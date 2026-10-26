import { GuildMember } from 'discord.js';
import { commandError, commandSkipped } from '../../../features-system/commands';
import type { InteractionHandlerResult, MessageComponentInteraction } from '../../../features-system/commands/types';
import { MalformedJourneyError, parseMessageButtonCustomId, resourceBindingsRepo } from '../../provisioning';
import { isTriggerStartedBy } from '../blocks/registry';
import { startButtonRun, type ButtonRunOutcome } from '../engine/flowTriggerDispatch';
import { journeyButtonTriggers, type ButtonTrigger } from './journeyButtonListeners';

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

/**
 * The one handler for every `mbtn:<buttonKey>` press — the buttons under a message a journey
 * posts (`messageButtons.ts` in provisioning, which owns the prefix). Registered once, by
 * `initFlows`: the registry refuses a second handler for a prefix.
 *
 * A press routes **message id → its binding → its journey's flows → the trigger naming this
 * button**, read from the database on every press (step 3, pick 4), all before anything is
 * acknowledged. Then `startButtonRun` takes it, so the gate and the wake happen in the order
 * every button press shares:
 *
 *  - **no binding** (never ours, or forgotten) → no gate to ask, so it wakes, then
 *    {@link NOTHING_HOOKED_UP};
 *  - **one live trigger** names the button → its gate, the wake, then the run;
 *  - **only switched-off flows** name it → their gates still decide the wake (review item 7),
 *    then {@link LISTENER_DISABLED};
 *  - **nothing** names it → the wake, then {@link NOTHING_HOOKED_UP};
 *  - **two or more live triggers** → their gates decide the wake, neither runs, the clash is
 *    logged naming every flow, and the presser hears {@link LISTENERS_FIGHTING}.
 *
 * Whether the button is still *declared* is not asked: the posted message is what can be
 * pressed, its binding is what says it is ours, and a trigger naming a key the journey no
 * longer declares is a readiness issue on that flow already. Presses take no journey lock
 * (review item 17), so during a repost a press on the new message can briefly find no binding.
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
        outcome: pressOutcome({ listening, journeyKey: posted.ownerKey, buttonKey }),
    });
}

/** An answer that runs nothing, with the trigger nodes whose gates still decide the wake. */
function answer(status: 'error' | 'skipped', message: string, gates: readonly ButtonTrigger[]): ButtonRunOutcome {
    return { kind: 'answer', status, message, gates: gates.map(({ flow, node }) => ({ flowId: flow.flowId, node })) };
}

/**
 * What a press comes to, by how many live triggers name its button. The live ones are what it
 * answers for; only when there are none do the switched-off ones' gates decide the wake.
 */
function pressOutcome(input: {
    readonly listening: readonly ButtonTrigger[];
    readonly journeyKey: string;
    readonly buttonKey: string;
}): ButtonRunOutcome {
    const live = input.listening.filter(({ listener }) => listener.enabled);
    const [only, ...others] = live;
    if (only && others.length === 0) {
        return { kind: 'run', flow: only.flow, node: only.node };
    }
    if (only) {
        const names = live.map(({ listener }) => `"${listener.flowName}" (${listener.flowId})`).join(', ');
        console.error(
            `[flows] Button "${input.buttonKey}" of journey "${input.journeyKey}" has ${live.length} live listeners — ${names}. Neither runs until one lets go.`
        );
        return answer('error', LISTENERS_FIGHTING, live);
    }
    // Kept `error`, as the `flow:` handler answers a disabled flow (review item 27).
    return input.listening.length > 0
        ? answer('error', LISTENER_DISABLED, input.listening)
        : answer('skipped', NOTHING_HOOKED_UP, []);
}
