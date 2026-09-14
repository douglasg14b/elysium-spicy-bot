import type { ButtonInteraction } from 'discord.js';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { FlowRunsRepo, flowRunsRepo } from '../data/flowRunsRepo';
import { parseFlowChoiceCustomId } from '../utils/customId';
import { resumeFlowRun } from './flowRunResume';

export interface FlowChoiceDependencies {
    flowRunsRepo: Pick<FlowRunsRepo, 'getByRunId'>;
    resume: typeof resumeFlowRun;
}

const defaultDependencies: FlowChoiceDependencies = {
    flowRunsRepo,
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

    // `resumeFlowRun` does not turn every failure into an outcome: it releases the
    // claim and rethrows for a transient channel fetch or an illegal transition.
    // Unhandled, that throw escapes to the registry — which only sends its own
    // fallback when the interaction is neither replied nor deferred, and this one
    // deferred above. The member would be left on "Bot is thinking…" forever, with
    // the reason only in a console line. The run itself is fine: the claim is
    // already back, so it stays parked and the next press retries.
    let outcome: Awaited<ReturnType<typeof resumeFlowRun>>;
    try {
        outcome = await dependencies.resume(interaction.client, run, {
            kind: 'choice',
            index: parsed.index,
        });
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
            // The claim was lost to another resumer — most likely the timeout
            // sweep landing at the same moment. Nothing went wrong; the question
            // simply closed first.
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
