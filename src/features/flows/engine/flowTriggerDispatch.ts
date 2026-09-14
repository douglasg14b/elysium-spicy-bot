import { ButtonInteraction, GuildMember } from 'discord.js';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { flowsRepo } from '../data/flowsRepo';
import { isTriggerStartedBy } from '../blocks/registry';
import { parseFlowCustomId } from '../utils/customId';
import { evaluateEligibility, readEligibility, UNREADABLE_GATE_MESSAGE } from './eligibility';
import { executeFlow } from './executor';
import { asGuildTextChannel } from './runChannel';
import { resumeWaitingRunsForEvent } from './waitingRunDispatch';
import type { FlowRunSeed } from '../blocks/types';

/**
 * The single `flow:` catch-all message-component handler. Parses
 * `flow:<flowId>:<nodeId>`, loads the flow, confirms the node is a buttonClick
 * trigger, and runs the executor with the interacting member as context.
 *
 * A click also wakes any durable run parked on an `action.waitForEvent` node
 * awaiting a button click from this user.
 */
export async function handleFlowButtonInteraction(
    interaction: ButtonInteraction
): Promise<InteractionHandlerResult> {
    const parsed = parseFlowCustomId(interaction.customId);
    if (!parsed) {
        return { status: 'error', message: 'Malformed flow button id.' };
    }

    if (!interaction.guild || !(interaction.member instanceof GuildMember)) {
        return { status: 'error', message: '❌ This button can only be used in a server.' };
    }

    const member = interaction.member;
    const flow = await flowsRepo.getByFlowId(parsed.flowId);
    const triggerNode = flow?.graph.nodes.find((node) => node.id === parsed.nodeId);

    /*
     * Who may press this, decided **before** anything runs and before the wake
     * below — once the executor has the run, the press has already been accepted.
     *
     * Computed rather than returned, because the wake that follows has to happen
     * for a press this flow's *health* rejects but its gate does not. Returning
     * early here is what made the first attempt at this ordering wrong.
     */
    const refusal = refusalFor(triggerNode, member);

    /*
     * A click also wakes any of this member's **own** runs parked on an
     * `action.waitForEvent` node awaiting a button click.
     *
     * Its position is load-bearing in both directions, and each was got wrong
     * once:
     *
     * * **Below the gate**, because this matches on guild, wait kind and member —
     *   never on *which* button was pressed. Above it, a refused press would
     *   still walk the presser's parked runs forward, assigning roles and sending
     *   messages, while reporting itself as a refusal that changed nothing.
     * * **Above the flow-health returns**, because a deleted, disabled or
     *   foreign flow is not a refusal of this member at all. Any button press
     *   was always meant to wake their run, and skipping the wake there would
     *   leave it parked with nothing left to wake it. `reactionAddDispatch` wakes
     *   before its own lookup for the same reason.
     */
    if (!refusal) {
        await resumeWaitingRunsForEvent(interaction.client, {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            eventKind: 'buttonClick',
        });
    }

    if (!flow) {
        return { status: 'error', message: 'This flow no longer exists.' };
    }
    if (!flow.enabled) {
        return { status: 'error', message: 'This flow is currently disabled.' };
    }
    if (flow.guildId !== interaction.guild.id) {
        return { status: 'error', message: 'This flow does not belong to this server.' };
    }
    if (!triggerNode || !isTriggerStartedBy(triggerNode.type, 'buttonClick')) {
        return { status: 'error', message: 'This button is not wired to a valid trigger.' };
    }

    if (refusal) {
        return refuse(interaction, refusal.content, refusal.status, refusal.message);
    }

    // A button click happens in a channel, and that channel is the run's.
    const interactionChannel = asGuildTextChannel(interaction.channel);
    const context: FlowRunSeed = {
        client: interaction.client,
        guild: interaction.guild,
        // The clicker is both who the run is about and who caused this step. They
        // diverge only once a run can be advanced by someone other than its
        // subject; setting both from one member here is true, not a placeholder.
        subject: member,
        actor: member,
        channel: interactionChannel,
        variables: {},
        interaction,
    };

    // Acknowledge quietly so the user is not left with a "failed" interaction
    // while actions run. Actions post their own visible side effects.
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    const result = await executeFlow(flow.flowId, flow.graph, triggerNode.id, context);

    const reply =
        result.status === 'success'
            ? '✅ Done!'
            : '❌ Something went wrong running this flow. A mod has been notified in the logs.';

    if (interaction.deferred) {
        await interaction.editReply({ content: reply });
    } else if (!interaction.replied) {
        await interaction.reply({ content: reply, ephemeral: true });
    }

    return {
        status: result.status === 'success' ? 'success' : 'error',
        message: result.status === 'success' ? undefined : result.error,
    };
}

/**
 * Would this node's eligibility rule turn this member away, and with what?
 *
 * Returns the refusal rather than sending it, so the caller can decide *when* to
 * send — which matters here, because a press that is refused must still be
 * distinguished from a press at a flow that is merely unhealthy, and only the
 * first of those suppresses the wake.
 *
 * A node this dispatcher could not find yields no refusal. That is not a gate
 * falling open: the caller rejects a missing or mis-typed node on its own, a few
 * lines later, and it has nothing to do with who pressed.
 */
function refusalFor(
    triggerNode: { data?: unknown } | undefined,
    member: GuildMember
): { content: string; status: InteractionHandlerResult['status']; message?: string } | null {
    if (!triggerNode) {
        return null;
    }

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

    // No subject, no actor and no variables: before a run exists the presser is
    // the only member there is. A `subject` or `actor` rule on a trigger is
    // therefore refused rather than quietly read as "the presser" — both are
    // about a run in progress, and a trigger has none to be about.
    const decision = evaluateEligibility(gate, { candidate: member });
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
 * `error` and its own log line, which is what makes a corrupt graph visible.
 *
 * Called before `deferReply`, so the reply path is always the plain one; it still
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
