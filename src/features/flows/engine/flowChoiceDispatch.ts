import { GuildMember, type ButtonInteraction } from 'discord.js';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { FlowRunsRepo, flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import { FlowsRepo, flowsRepo } from '../data/flowsRepo';
import { parseFlowChoiceCustomId } from '../utils/customId';
import { evaluateEligibility, readEligibility, UNREADABLE_GATE_MESSAGE } from './eligibility';
import { resumeFlowRun } from './flowRunResume';

export interface FlowChoiceDependencies {
    flowRunsRepo: Pick<FlowRunsRepo, 'getByRunId'>;
    flowsRepo: Pick<FlowsRepo, 'getByFlowId'>;
    resume: typeof resumeFlowRun;
}

const defaultDependencies: FlowChoiceDependencies = {
    flowRunsRepo,
    flowsRepo,
    resume: resumeFlowRun,
};

/**
 * What a presser is told when the question is no longer open.
 *
 * One string for several internal states — already answered, timed out,
 * cancelled, moved on, or claimed by another resumer a moment earlier. From the
 * presser's side those are one event, and the run's own status is not theirs to
 * read. Shared so a copy edit cannot land on one branch and not the others.
 */
export const QUESTION_CLOSED_MESSAGE = 'This question has already been answered or has expired.';

/**
 * The `flowc:` handler: somebody answered a question a parked run asked.
 *
 * The counterpart to `flowTriggerDispatch`, and deliberately not an extension of
 * it. A trigger button *starts* a run and so needs only to name a graph; this one
 * *advances* an existing run and names the run itself, because two members can be
 * parked at the same node of the same flow at once.
 *
 * It does **not** call `resumeWaitingRunsForEvent`. An answer is addressed to one
 * run; fanning it out over every run in the guild waiting on a button click would
 * advance runs whose members pressed nothing. The two paths stay separate, and
 * they cannot collide from the other direction either: a prompt parks with no
 * `waitKind`, so `findWaiting` never returns its row.
 */
export async function handleFlowChoiceInteraction(
    interaction: ButtonInteraction,
    dependencies: FlowChoiceDependencies = defaultDependencies
): Promise<InteractionHandlerResult> {
    const parsed = parseFlowChoiceCustomId(interaction.customId);
    if (!parsed) {
        return { status: 'error', message: 'Malformed flow answer id.' };
    }

    if (!interaction.guild) {
        return { status: 'error', message: '❌ This button can only be used in a server.' };
    }

    // Answering can take longer than Discord's three seconds, because resuming
    // runs the rest of the graph. Defer first so the press is acknowledged
    // whatever follows; visible side effects are the blocks' own.
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    const run = await dependencies.flowRunsRepo.getByRunId(parsed.runId);
    if (!run) {
        // Two facts arrive here and the copy has to be true of both. The run id
        // is minted before its row exists — the question is posted during the
        // step that parks, and the row is written when that step returns — so a
        // press inside that window is a question not ready yet, which retrying
        // fixes. But a row that was deleted, or one lost to a reset, lands here
        // identically and retrying will never fix it. Saying "still being set
        // up" outright would send that member into a loop against a run that is
        // gone, so this names both and promises neither.
        return replyWith(
            interaction,
            "⏳ This question isn't available right now. It may still be setting up — or it may be gone.",
            'skipped'
        );
    }

    if (run.guildId !== interaction.guild.id) {
        return replyWith(interaction, '❌ This question belongs to a different server.', 'error');
    }

    if (run.contextSnapshot.userId !== interaction.user.id) {
        return replyWith(interaction, '❌ This question was not asked of you.', 'error');
    }

    if (run.status !== 'suspended' || run.resumeNodeId !== parsed.nodeId) {
        return replyWith(interaction, QUESTION_CLOSED_MESSAGE, 'skipped');
    }

    // The press must belong to the park the run is *currently* on, not merely to
    // this run at this node. Those come apart whenever a graph routes back to the
    // question — the run advances, asks again, and is once more `suspended` at the
    // same `resumeNodeId`, so every check above passes for a button left over from
    // the previous asking. The message a press arrived on is the one thing that
    // differs between the two, so it is what the claim below is told to match.
    //
    // Checked here as well as in the claim so the presser gets the honest copy:
    // this branch knows the question is closed, whereas a claim that misses cannot
    // tell that apart from losing a race.
    //
    // **A run that names no message is exempt, and the claim below is told the
    // same thing.** A question parked before this column existed has
    // `waitMessageId` null while its buttons are still live in the channel; there
    // is no park name to check it against, and inventing one would refuse the
    // presser forever on a question that is genuinely open. Such a run keeps
    // exactly the guarantees it had before — the status and node checks above, and
    // the claim's own single winner — which is what it was shipped with.
    //
    // Bound once rather than re-derived at the claim below. The refusal here and
    // the claim's own condition are one rule, and stating it twice is how they
    // come to disagree.
    const claimedPark = run.waitMessageId ?? undefined;
    if (claimedPark && claimedPark !== interaction.message.id) {
        return replyWith(interaction, QUESTION_CLOSED_MESSAGE, 'skipped');
    }

    const refusal = await refuseIfIneligible(interaction, run, parsed.nodeId, dependencies);
    if (refusal) {
        return refusal;
    }

    // `resumeFlowRun` does not turn every failure into an outcome: it releases the
    // claim and rethrows for a transient channel fetch or an illegal transition.
    // Unhandled, that throw escapes to the registry — which only sends its own
    // fallback when the interaction is neither replied nor deferred, and this one
    // deferred above. The member would be left on "Bot is thinking…" forever, with
    // the reason only in a console line. The run itself is fine: the claim is
    // already back, so it stays parked and the next press retries.
    let outcome: Awaited<ReturnType<typeof resumeFlowRun>>;
    try {
        outcome = await dependencies.resume(
            interaction.client,
            run,
            {
                kind: 'choice',
                index: parsed.index,
            },
            undefined,
            // The park this press claims to be answering. Everything above is a
            // read-then-check and so is only as current as the row it read; this
            // is the same condition applied *inside* the claim's own conditional
            // write, which is what makes two presses arriving together — or one
            // arriving while the timeout sweep resumes the run — unable to both
            // win. The loser is told the question closed.
            //
            // Undefined when the run names no message, per the exemption above: a
            // pre-column row would otherwise be claimed against a name it does not
            // have and could never be answered again.
            claimedPark
        );
    } catch (error) {
        return replyWith(
            interaction,
            '❌ Something went wrong carrying on from your answer. Give it another go in a moment.',
            'error',
            error instanceof Error ? error.message : 'Unknown error resuming the run'
        );
    }

    switch (outcome.status) {
        case 'completed':
        case 'suspended':
            return replyWith(interaction, '✅ Got it.', 'success');
        case 'skipped':
            // The claim did not land. Either it was lost to another resumer — most
            // likely the timeout sweep arriving at the same moment — or the run
            // moved off this park between the read above and the write, so the
            // press is answering an asking that has since closed. Both are the
            // same event from the presser's side, and neither is a fault.
            return replyWith(interaction, QUESTION_CLOSED_MESSAGE, 'skipped');
        case 'failed':
            return replyWith(
                interaction,
                '❌ Something went wrong carrying on from your answer. A mod has been notified in the logs.',
                'error',
                outcome.error
            );
    }
}

/**
 * Refuse the presser if the question's own gate does not admit them — or
 * `null` to carry on.
 *
 * Runs **after** the ownership check, and that order is the whole shape of it: by
 * the time a gate is consulted the presser is already known to be the member the
 * run is about, so a gate here can only add a second condition on that same
 * person. It is not a way to let somebody else answer.
 *
 * Costs one extra read of the flow row. Worth it rather than persisting the gate
 * onto the run: a gate copied onto the run at park time would keep enforcing what
 * the author wrote *then*, so tightening a live question would not take effect
 * until every open one had closed — which is the wrong behaviour for the one
 * change an author makes urgently.
 *
 * A missing flow, node or member is refused rather than admitted, for the reason
 * {@link evaluateEligibility} refuses an unsatisfiable gate: a gate that cannot be
 * evaluated has not been passed.
 */
async function refuseIfIneligible(
    interaction: ButtonInteraction,
    run: FlowRunEntity,
    nodeId: string,
    dependencies: FlowChoiceDependencies
): Promise<InteractionHandlerResult | null> {
    // Wrapped for the reason the resume call below is: the interaction is already
    // deferred by now, so a throw escaping here reaches a registry that will not
    // send its fallback, and the member sits on "Bot is thinking…" forever.
    let flow: Awaited<ReturnType<FlowChoiceDependencies['flowsRepo']['getByFlowId']>>;
    try {
        flow = await dependencies.flowsRepo.getByFlowId(run.flowId);
    } catch (error) {
        return replyWith(
            interaction,
            "❌ Couldn't check this question just now. Give it another go in a moment.",
            'error',
            error instanceof Error ? error.message : 'Unknown error reading the flow'
        );
    }

    const node = flow?.graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
        // The flow was deleted, or edited to drop the node, while somebody held
        // the question open. Reported as closed rather than as a permission
        // problem, because from the presser's side that is what happened.
        return replyWith(interaction, QUESTION_CLOSED_MESSAGE, 'skipped');
    }

    const gate = readEligibility(node.data);
    if (!gate) {
        return replyWith(interaction, `❌ ${UNREADABLE_GATE_MESSAGE}`, 'error', 'Unreadable eligibility rule');
    }

    // An open rule admits without reading the member at all, so it is answered
    // before the narrowing below — which matters, because that narrowing can
    // fail for reasons that have nothing to do with the presser.
    //
    // This ordering is the difference between the feature being invisible on an
    // ungated question and it breaking one. Every question authored before rules
    // existed is open, and so is every one an author has not touched.
    if (gate.principal === 'anyone') {
        return null;
    }

    // `interaction.member` is a raw APIInteractionGuildMember when the gateway
    // has no cached member, and that shape carries no `roles.cache` to ask.
    // Refused rather than read anyway: a rule evaluated against an object with no
    // roles would turn *everybody* away and blame their roles for it.
    const { member } = interaction;
    if (!(member instanceof GuildMember)) {
        return replyWith(
            interaction,
            "❌ Couldn't check your permissions just now. Give it another go in a moment.",
            'error',
            'Interaction member was not a resolved GuildMember'
        );
    }

    // The presser is both. Subject because the ownership check above proved it,
    // and actor because pressing the button *is* the act advancing this step —
    // which is exactly what an actor is. Supplying the subject and withholding
    // the actor would leave an `actor` rule refusing the one person who satisfies
    // it, naming a condition they meet.
    const decision = evaluateEligibility(gate, {
        candidate: member,
        subject: member,
        actor: member,
        variables: run.variables,
    });

    return decision.allowed ? null : replyWith(interaction, `🚫 ${decision.reason}`, 'skipped');
}

/**
 * Answer the presser, and report what happened to the interactions registry.
 *
 * `status` is required rather than defaulted to `'error'`. Two of the branches
 * here — a question not written yet, and one that has already closed — are
 * ordinary outcomes that the code's own comments say are not failures, and a
 * default would have had them reporting themselves as errors anyway.
 */
async function replyWith(
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
    // `message` is the registry's log line, not the presser's copy: the two
    // differ whenever the honest internal reason is not something to put in
    // front of a member.
    return { status, message: status === 'success' ? undefined : (message ?? content) };
}
