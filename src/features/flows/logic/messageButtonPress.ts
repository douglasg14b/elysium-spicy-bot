import { GuildMember, type ButtonInteraction, type Guild } from 'discord.js';
import { commandError, commandSkipped } from '../../../features-system/commands';
import type { InteractionHandlerResult, MessageComponentInteraction } from '../../../features-system/commands/types';
import { MalformedJourneyError, parseMessageButtonCustomId, resourceBindingsRepo } from '../../provisioning';
import { TICKET_VARIABLES } from '../../tickets';
import { isTriggerStartedBy } from '../blocks/registry';
import type { FlowVariableValue } from '../blocks/types';
import { startButtonRun, type ButtonRunOutcome, type ButtonRunSubject } from '../engine/flowTriggerDispatch';
import { blockButtonTriggers, type BlockButtonTrigger } from './blockButtonListeners';
import { flowPostedMessagesRepo } from './flowPostedMessagesRepo';
import type { FlowPostedMessageEntity } from './flowPostedMessagesSchema';
import { journeyButtonTriggers, type ButtonTrigger } from './journeyButtonListeners';
import { memberOrLeaver } from './memberOrLeaver';

/**
 * What a press on a message resource's button answers while nothing listens to it, sent
 * only to the presser. In the bot's voice, for Douglas to tune.
 */
export const NOTHING_HOOKED_UP = "Nothing's hooked up to this yet. Poke it all you like, babe — it isn't going to put out.";

/** What a press answers when only switched-off flows listen: the `flow:` handler's own sentence. */
export const LISTENER_DISABLED = 'This flow is currently disabled.';

/**
 * What a press answers when two live flows listen to one button. Only a race gets here: going
 * live and grouping both refuse a second listener (`buttonClaims.ts`).
 */
export const LISTENERS_FIGHTING =
    'Two flows are fighting over this button, so neither gets it. A mod has to sort them out.';

/** What a press answers when its journey's row cannot be read, so nobody can say who listens. */
export const JOURNEY_UNREADABLE = "❌ This button's journey is broken, so nothing ran. A mod has to fix it on the dashboard.";

/** A trigger a press would answer for, with the flow it is in — either path's. */
type ListeningTrigger = Pick<ButtonTrigger, 'flow' | 'node'> | BlockButtonTrigger;

/**
 * The one handler for every `mbtn:<buttonKey>` press — the buttons under a message a journey
 * posts (`messageButtons.ts` in provisioning, which owns the prefix), and those under a
 * message a block posts (Post Embed's, Open Ticket's). Registered once, by `initFlows`: the
 * registry refuses a second handler for a prefix.
 *
 * A press is routed from the database on every press, all before anything is acknowledged:
 *
 *  1. **A block's post** — the message id finds a `flow_posted_messages` record (a primary-key
 *     read, asked first) → the posting flow's journey's flows, or the posting flow alone when
 *     it has none → the triggers naming exactly that flow, node and button
 *     (`blockButtonTriggers`). The run is about whoever the posting run was about, else the
 *     presser; a post from Open Ticket hands its ticket on as `ticketId` / `ticketChannelId`.
 *  2. **A journey's message** — otherwise, message id → its binding → its journey's flows →
 *     the trigger naming this button (step 3, pick 4). The run is about the presser.
 *
 * Then `startButtonRun` takes it, so the gate and the wake happen in the order every button
 * press shares, and both paths answer alike:
 *
 *  - **neither a record nor a binding** (never ours, or forgotten) → no gate to ask, so it
 *    wakes, then {@link NOTHING_HOOKED_UP};
 *  - **one live trigger** names the button → its gate, the wake, then the run;
 *  - **only switched-off flows** name it → their gates still decide the wake (review item 7),
 *    then {@link LISTENER_DISABLED};
 *  - **nothing** names it → the wake, then {@link NOTHING_HOOKED_UP};
 *  - **two or more live triggers** → their gates decide the wake, neither runs, the clash is
 *    logged naming every flow, and the presser hears {@link LISTENERS_FIGHTING}.
 *
 * Whether the button is still *declared* (or still on the posting node) is not asked: the
 * posted message is what can be pressed, and a trigger naming a key that is gone is a
 * readiness issue on that flow already. Presses take no journey lock (review item 17), so
 * during a repost a press on the new message can briefly find no binding.
 */
export async function handleMessageButtonPress(interaction: MessageComponentInteraction): Promise<InteractionHandlerResult> {
    if (!interaction.isButton()) {
        return commandSkipped('Message resources only carry buttons.');
    }
    const buttonKey = parseMessageButtonCustomId(interaction.customId);
    if (!buttonKey) {
        return commandError('Malformed message button id.');
    }
    if (!interaction.guild || !(interaction.member instanceof GuildMember)) {
        return commandError('❌ This button can only be used in a server.');
    }
    const { guild, member } = interaction;

    const record = await flowPostedMessagesRepo.findByMessageId(guild.id, interaction.message.id);
    if (record) {
        return blockButtonPress({ interaction, guild, member, record, buttonKey });
    }

    const posted = await resourceBindingsRepo.findPostedMessage(guild.id, interaction.message.id);
    if (!posted) {
        return startButtonRun({ interaction, guild, member, outcome: answer('skipped', NOTHING_HOOKED_UP, []) });
    }

    let triggers: ButtonTrigger[];
    try {
        triggers = await journeyButtonTriggers(guild.id, posted.ownerKey);
    } catch (error) {
        if (!(error instanceof MalformedJourneyError)) throw error;
        // Nobody can say whose gate would decide, so nothing wakes either: a refused press
        // that woke a parked run is the worse mistake of the two.
        console.error(`[flows] A press on journey "${posted.ownerKey}"'s message found its journey unreadable:`, error);
        return commandError(JOURNEY_UNREADABLE);
    }

    // Only a button-click trigger answers a press. Conformance allows a `messageButton` field on
    // no other block (`checkMessageButtonSource` in `blocks/conformance.ts`), so this filter and
    // the walk that feeds it agree; it stays as the press's own statement of the rule.
    const listening = triggers.filter(
        ({ listener, node }) =>
            listener.messageKey === posted.resourceKey &&
            listener.buttonKey === buttonKey &&
            isTriggerStartedBy(node.type, 'buttonClick')
    );

    return startButtonRun({
        interaction,
        guild,
        member,
        outcome: pressOutcome(listening, `Button "${buttonKey}" of journey "${posted.ownerKey}"`),
    });
}

interface BlockButtonPressInput {
    readonly interaction: ButtonInteraction;
    readonly guild: Guild;
    readonly member: GuildMember;
    readonly record: FlowPostedMessageEntity;
    readonly buttonKey: string;
}

/**
 * A press on a button under a block's post: its triggers, then who the run would be about and
 * what it carries, from the record — switched-off listeners' gates decide the wake against the
 * same facts. Nothing is fetched from Discord before the press is acknowledged: the gates judge
 * the subject by id, and the member is fetched only when a run starts.
 */
async function blockButtonPress(input: BlockButtonPressInput): Promise<InteractionHandlerResult> {
    const { interaction, guild, member, record, buttonKey } = input;

    let listening: BlockButtonTrigger[];
    try {
        listening = await blockButtonTriggers(guild.id, record, buttonKey);
    } catch (error) {
        if (!(error instanceof MalformedJourneyError)) throw error;
        console.error(
            `[flows] A press on flow ${record.flowId}'s post (message ${record.messageId}) found the flow's journey unreadable:`,
            error
        );
        return commandError(JOURNEY_UNREADABLE);
    }

    if (listening.length === 0) {
        return startButtonRun({ interaction, guild, member, outcome: answer('skipped', NOTHING_HOOKED_UP, []) });
    }

    return startButtonRun({
        interaction,
        guild,
        member,
        subject: postSubject(guild, member, record.subjectId),
        variables: postVariables(record),
        outcome: pressOutcome(
            listening,
            `Button "${buttonKey}" of flow ${record.flowId}'s node ${record.nodeId} (message ${record.messageId})`
        ),
    });
}

/**
 * Who a press on a block's post starts a run about: whoever the posting run was about — by id,
 * fetched by `startButtonRun` only once a run starts, a leaver as a partial member — or, for a
 * post from a run about nobody or about the presser, the presser (`undefined` here, which
 * `startButtonRun` reads as the presser).
 */
function postSubject(guild: Guild, presser: GuildMember, subjectId: string | null): ButtonRunSubject | undefined {
    if (!subjectId || subjectId === presser.id) return undefined;
    return { id: subjectId, resolve: () => memberOrLeaver(guild, subjectId) };
}

/**
 * The run's opening variables: a post from Open Ticket (keyed on its ticket being recorded,
 * never on the block) hands its ticket on under the names that block writes, so a Close
 * Ticket with `{{var.ticketId}}` closes it. The channel is the post's own — the ticket's.
 */
function postVariables(record: FlowPostedMessageEntity): Readonly<Record<string, FlowVariableValue>> {
    if (record.ticketId === null) return {};
    return {
        [TICKET_VARIABLES.ticketId]: record.ticketId,
        [TICKET_VARIABLES.ticketChannelId]: record.channelId,
    };
}

/** An answer that runs nothing, with the trigger nodes whose gates still decide the wake. */
function answer(status: 'error' | 'skipped', message: string, gates: readonly ListeningTrigger[]): ButtonRunOutcome {
    return { kind: 'answer', status, message, gates: gates.map(({ flow, node }) => ({ flowId: flow.flowId, node })) };
}

/**
 * What a press comes to, by how many live triggers name its button — either path's. The live
 * ones are what it answers for; only when there are none do the switched-off ones' gates
 * decide the wake. `button` names the button in the log.
 */
function pressOutcome(listening: readonly ListeningTrigger[], button: string): ButtonRunOutcome {
    const live = listening.filter(({ flow }) => flow.enabled);
    const [only, ...others] = live;
    if (only && others.length === 0) {
        return { kind: 'run', flow: only.flow, node: only.node };
    }
    if (only) {
        const names = live.map(({ flow }) => `"${flow.name}" (${flow.flowId})`).join(', ');
        console.error(`[flows] ${button} has ${live.length} live listeners — ${names}. Neither runs until one lets go.`);
        return answer('error', LISTENERS_FIGHTING, live);
    }
    // Kept `error`, as the `flow:` handler answers a disabled flow (review item 27).
    return listening.length > 0
        ? answer('error', LISTENER_DISABLED, listening)
        : answer('skipped', NOTHING_HOOKED_UP, []);
}
