import { ButtonInteraction, GuildMember, type Guild, type PartialGuildMember } from 'discord.js';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { flowsRepo } from '../data/flowsRepo';
import type { FlowNode } from '../data/flowGraph';
import type { FlowEntity } from '../data/flowsSchema';
import { isTriggerStartedBy } from '../blocks/registry';
import { parseFlowCustomId } from '../utils/customId';
import { evaluateEligibility, readEligibility, UNREADABLE_GATE_MESSAGE, type EligibilityFacts } from './eligibility';
import { executeFlow } from './executor';
import { asGuildTextChannel } from './runChannel';
import { resumeWaitingRunsForEvent } from './waitingRunDispatch';
import type { FlowRunSeed, FlowVariableValue } from '../blocks/types';

/** A trigger node whose gate a press asks, with the flow it is in — for the log, when it cannot be read. */
export interface ButtonGate {
    readonly flowId: string;
    readonly node: FlowNode;
}

/**
 * What a button press comes to: the run of one trigger node, gated by that node, or an answer
 * its caller worded — a flow that is off, gone, in another server, or nothing listening at all
 * — with the trigger nodes whose gates still decide the wake.
 */
export type ButtonRunOutcome =
    | { readonly kind: 'run'; readonly flow: FlowEntity; readonly node: FlowNode }
    | {
          readonly kind: 'answer';
          readonly status: 'error' | 'skipped';
          readonly message: string;
          /**
           * The trigger nodes the press would answer for. Empty when nothing names the button:
           * there is no gate to ask, so the press wakes.
           */
          readonly gates: readonly ButtonGate[];
      };

/** A press's subject other than the presser: who, and how to fetch them when a run starts. */
export interface ButtonRunSubject {
    readonly id: string;
    /** The member, or a partial one when they have left. May throw on a failed fetch. */
    readonly resolve: () => Promise<GuildMember | PartialGuildMember>;
}

export interface ButtonRunInput {
    readonly interaction: ButtonInteraction;
    readonly guild: Guild;
    /** Who pressed: always the run's actor, and the one every gate is asked about. */
    readonly member: GuildMember;
    readonly outcome: ButtonRunOutcome;
    /**
     * Who the run a press starts is about, when its caller knows somebody other than the
     * presser — the member a block's post was about, who may have left since. Absent: the
     * presser.
     *
     * By id, with a way to fetch them: the gates read only the id, and the member is fetched
     * only once a run is starting, after the press is acknowledged — a fetch (two, for a
     * leaver) before the acknowledgement could run the press past Discord's three seconds,
     * and would be paid on answers that start nothing.
     */
    readonly subject?: ButtonRunSubject;
    /** The run's opening variables, when its caller has some to hand on. Absent: none. */
    readonly variables?: Readonly<Record<string, FlowVariableValue>>;
}

/**
 * The one order every button press that can start a run goes through — the `flow:` bridge
 * (below) and a message resource's buttons (`logic/messageButtonPress.ts`):
 *
 *  1. **the gates**, decided before anything runs or wakes: once the executor has the run, the
 *     press has already been accepted;
 *  2. **the wake** of this member's own runs parked on a button click — only when no gate
 *     refuses them;
 *  3. **the caller's own answer**, when the press starts nothing;
 *  4. **the refusal**, quietly, to the presser;
 *  5. **the run**: `deferUpdate`, then the subject fetched (when the caller named one), then
 *     the executor, then a follow-up only on failure.
 *
 * Each caller words its own off, missing and wrong-server cases into {@link ButtonRunOutcome}
 * — which is why they come after the wake rather than before it: none of them is a refusal of
 * this member.
 *
 * **One gate rule for every press**: each gate sees the run the press would start — about
 * `subject` (else the presser), set going by the presser, carrying `variables`. On a press
 * whose caller names no subject the presser is both, so a `subject` or `actor` gate there
 * admits whoever presses. The gates of an answer are asked against the same facts, so a
 * switched-off or fighting flow decides the wake exactly as it would decide the run.
 */
export async function startButtonRun(input: ButtonRunInput): Promise<InteractionHandlerResult> {
    const { interaction, guild, member, outcome } = input;
    const variables = input.variables ?? {};
    const facts: EligibilityFacts = {
        candidate: member,
        subject: input.subject ? { id: input.subject.id } : member,
        actor: member,
        variables,
    };
    const gates: readonly ButtonGate[] =
        outcome.kind === 'run' ? [{ flowId: outcome.flow.flowId, node: outcome.node }] : outcome.gates;

    /*
     * Who may press this, decided **before** anything runs and before the wake below — once
     * the executor has the run, the press has already been accepted.
     *
     * Computed rather than returned, because the wake that follows has to happen for a press
     * the caller answers without a run but no gate refuses. Returning early here is what made
     * the first attempt at this ordering wrong. Any one gate refusing is a refusal: a press
     * several triggers would answer for is let through only when all of them would let it.
     * Every gate is asked, not just up to the first refusal, so an unreadable one behind it
     * is still found for the log below.
     */
    const gateRefusals = gates.map((gate) => ({ gate, refusal: refusalFor(gate.node, facts) }));
    const refusal = gateRefusals.find((entry) => entry.refusal !== null)?.refusal ?? null;

    /*
     * A press also wakes any of this member's **own** runs parked on an `action.waitForEvent`
     * node awaiting a button click.
     *
     * Its position is load-bearing in both directions, and each was got wrong once:
     *
     * * **Below the gates**, because this matches on guild, wait kind and member — never on
     *   *which* button was pressed. Above them, a refused press would still walk the
     *   presser's parked runs forward, assigning roles and sending messages, while
     *   reporting itself as a refusal that changed nothing.
     * * **Above the callers' answers**, because a deleted, disabled or unheard button is not
     *   a refusal of this member at all. Any button press was always meant to wake their
     *   run, and skipping the wake there would leave it parked with nothing left to wake it.
     *   `reactionAddDispatch` wakes before its own lookup for the same reason.
     */
    if (!refusal) {
        await resumeWaitingRunsForEvent(interaction.client, {
            guildId: guild.id,
            userId: interaction.user.id,
            eventKind: 'buttonClick',
        });
    }

    if (outcome.kind === 'answer') {
        /*
         * The presser hears the caller's answer, not the refusal, so an unreadable gate would
         * otherwise go unseen: a corrupt rule on a switched-off or fighting flow, found only
         * once someone switches it on. Ids only — never the presser or the rule.
         */
        for (const { gate, refusal: found } of gateRefusals) {
            if (found?.status === 'error') {
                console.error(
                    `[flows] A button press found an unreadable eligibility rule — flow ${gate.flowId}, node ${gate.node.id}.`
                );
            }
        }
        return { status: outcome.status, message: outcome.message };
    }

    if (refusal) {
        return refuse(interaction, refusal.content, refusal.status, refusal.message);
    }

    // Acknowledge quietly so the user is not left with a "failed" interaction
    // while actions run. Actions post their own visible side effects.
    //
    // `deferUpdate` rather than `deferReply`: it closes the interaction with no
    // message, where `deferReply` promises one and so obliges a reply even when
    // there is nothing to report. A member who pressed a button and watched the
    // flow do its thing does not also need a "Done!" popup saying so.
    //
    // Refusals do not reach here — they are sent above, before any acknowledgement,
    // which is what lets them reply outright instead of behind a spinner.
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
    }

    // Fetched only now, acknowledged: the gates above judged this id.
    let subject: GuildMember | PartialGuildMember;
    try {
        subject = input.subject ? await input.subject.resolve() : member;
    } catch (error) {
        console.error(
            `[flows] A button press could not fetch the member its run is about — flow ${outcome.flow.flowId}, node ${outcome.node.id}, member ${input.subject?.id}:`,
            error
        );
        await sayRunFailed(interaction);
        return { status: 'error', message: 'Could not fetch the member the run is about.' };
    }

    // A button click happens in a channel, and that channel is the run's.
    const context: FlowRunSeed = {
        client: interaction.client,
        guild,
        // Who the run is about — the member a block's post was about, or the presser — and
        // the presser as who caused this step. The gates above saw exactly these.
        subject,
        actor: member,
        channel: asGuildTextChannel(interaction.channel),
        variables,
        interaction,
    };

    const result = await executeFlow(outcome.flow.flowId, outcome.flow.graph, outcome.node.id, context);

    if (result.status !== 'success') {
        await sayRunFailed(interaction);
    }

    return {
        status: result.status === 'success' ? 'success' : 'error',
        message: result.status === 'success' ? undefined : result.error,
    };
}

/**
 * Tell the presser, quietly, that their run went wrong — the only thing a press says once it
 * has been accepted. `followUp`, not `editReply`: after `deferUpdate` there is no reply to edit,
 * and editing would rewrite the message the button sits on.
 */
async function sayRunFailed(interaction: ButtonInteraction): Promise<void> {
    const content = '❌ Something went wrong running this flow. A mod has been notified in the logs.';
    if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, ephemeral: true });
    } else {
        await interaction.reply({ content, ephemeral: true });
    }
}

/**
 * What a `flow:` button answers once nothing stands behind it: the bridge's answer to a node
 * the step-3 migration emptied, and — in the bridge-removal deploy — the whole `flow:`
 * handler's (`docs/plans/message-resource-step-3.md`, "After this step"; Douglas, 2026-10-25).
 */
export const RETIRED_BUTTON_MESSAGE = "This button's been retired — ask a mod to repost it.";

/**
 * The `flow:<flowId>:<nodeId>` handler, **kept as a bridge** for buttons posted by the retired
 * Deploy (`docs/plans/message-resource-step-3.md`, "After this step"): the step-3 migration
 * converts each such trigger to a message resource's button, and until its journey is
 * installed and repaired, its old message still carries `flow:` ids. A converted node keeps
 * its gate and is still a button-click trigger, which is all this reads.
 *
 * A node the migration **emptied** — one no `flow_button_messages` row named, such as a
 * button Deploy posted before that table existed — has no button left to run from, so its
 * old button answers {@link RETIRED_BUTTON_MESSAGE} rather than failing inside the run.
 *
 * Every press is logged, with its message and channel, so the stragglers can be found before
 * the bridge is replaced with a one-line retirement answer.
 */
export async function handleFlowButtonInteraction(
    interaction: ButtonInteraction
): Promise<InteractionHandlerResult> {
    const parsed = parseFlowCustomId(interaction.customId);
    if (!parsed) {
        return { status: 'error', message: 'Malformed flow button id.' };
    }

    console.info(
        `[flows] flow: bridge press — flow ${parsed.flowId}, node ${parsed.nodeId}, message ${interaction.message.id}, channel ${interaction.channelId}`
    );

    if (!interaction.guild || !(interaction.member instanceof GuildMember)) {
        return { status: 'error', message: '❌ This button can only be used in a server.' };
    }

    const flow = await flowsRepo.getByFlowId(parsed.flowId);
    const triggerNode = flow?.graph.nodes.find((node) => node.id === parsed.nodeId);
    const outcome = outcomeOf(flow, triggerNode, interaction.guild.id);

    if (outcome.kind === 'answer' && outcome.message === RETIRED_BUTTON_MESSAGE) {
        console.warn(
            `[flows] flow: bridge press on an emptied Button Click — flow ${parsed.flowId}, node ${parsed.nodeId}, ` +
                `message ${interaction.message.id}, channel ${interaction.channelId}. It answered that the button is ` +
                'retired; delete that message by hand.'
        );
    }

    return startButtonRun({
        interaction,
        guild: interaction.guild,
        member: interaction.member,
        outcome,
    });
}

/** What a `flow:` press runs, or why it runs nothing, in the bridge's own words. */
function outcomeOf(flow: FlowEntity | null, triggerNode: FlowNode | undefined, guildId: string): ButtonRunOutcome {
    // Whatever the answer, the node the id names still gates the wake. A node this handler
    // could not find has no gate to ask — not a gate falling open: the answer says it is gone.
    const gates = flow && triggerNode ? [{ flowId: flow.flowId, node: triggerNode }] : [];
    if (!flow) {
        return { kind: 'answer', status: 'error', message: 'This flow no longer exists.', gates };
    }
    if (!flow.enabled) {
        return { kind: 'answer', status: 'error', message: 'This flow is currently disabled.', gates };
    }
    if (flow.guildId !== guildId) {
        return { kind: 'answer', status: 'error', message: 'This flow does not belong to this server.', gates };
    }
    if (!triggerNode || !isTriggerStartedBy(triggerNode.type, 'buttonClick')) {
        return { kind: 'answer', status: 'error', message: 'This button is not wired to a valid trigger.', gates };
    }
    // A node the migration emptied names no button, so its run would fail parsing its own
    // config. Only that: a node with a button and an unreadable gate still reaches the run
    // path, where `refusalFor` tells the presser the gate is broken — the fix it needs.
    if (!Object.hasOwn(triggerNode.data, 'button')) {
        return { kind: 'answer', status: 'error', message: RETIRED_BUTTON_MESSAGE, gates };
    }
    return { kind: 'run', flow, node: triggerNode };
}

/**
 * Would this node's eligibility rule turn this member away, and with what?
 *
 * Returns the refusal rather than sending it, so the caller can decide *when* to
 * send — which matters here, because a press that is refused must still be
 * distinguished from a press at a flow that is merely unhealthy, and only the
 * first of those suppresses the wake.
 */
function refusalFor(
    triggerNode: { readonly data?: unknown },
    facts: EligibilityFacts
): { content: string; status: InteractionHandlerResult['status']; message?: string } | null {
    // Read off the raw node data rather than the block's validated config,
    // because that is all a dispatcher has: the graph came out of the database,
    // and `executeFlow` is what parses each node against its schema.
    const gate = readEligibility(triggerNode.data);
    if (!gate) {
        return {
            content: `❌ ${UNREADABLE_GATE_MESSAGE}`,
            status: 'error',
            message: 'Unreadable eligibility rule',
        };
    }

    // Judged against the run the press would start (see `startButtonRun`): its subject, the
    // presser as its actor, and its opening variables.
    const decision = evaluateEligibility(gate, facts);
    return decision.allowed ? null : { content: `🚫 ${decision.reason}`, status: 'skipped' };
}

/**
 * Turn somebody away: tell them, quietly, and change nothing.
 *
 * Ephemeral because a refusal is between the bot and the presser — announcing in
 * channel that somebody pressed a button they were not allowed to would make the
 * gate a public shaming device rather than a permission check.
 *
 * `status` is required rather than defaulted, matching `replyWith` in
 * `flowChoiceDispatch` — the two are the same job on the two surfaces, and the
 * distinction they both need is the same one. An ordinary refusal is `skipped`:
 * a rule doing its job is the system working, and logging every refused press as
 * a failure would bury real errors under the ordinary traffic of a moderator-only
 * button in a busy guild. An **unreadable** rule is the one refusal that is a
 * genuine fault — a fault in the flow rather than in this press — so it reports
 * `error` with its own message. A press that ends in its caller's answer instead never
 * reaches here, so `startButtonRun` logs the unreadable rule itself.
 *
 * Called before `deferUpdate`, so the reply path is always the plain one; it still
 * checks, because a handler that assumes its own position in the function is one
 * edit away from double-replying.
 */
async function refuse(
    interaction: ButtonInteraction,
    content: string,
    status: InteractionHandlerResult['status'],
    message?: string
): Promise<InteractionHandlerResult> {
    if (interaction.deferred) {
        await interaction.editReply({ content });
    } else if (!interaction.replied) {
        await interaction.reply({ content, ephemeral: true });
    }

    return { status, message: message ?? content };
}
