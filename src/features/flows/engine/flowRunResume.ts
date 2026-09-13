import type { Client, Guild, GuildMember } from 'discord.js';
import { FLOW_MAX_NODE_VISITS } from '../constants';
import { FlowRunsRepo, flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import { FlowsRepo, flowsRepo } from '../data/flowsRepo';
import { ACTION_WAIT_FOR_EVENT } from '../blocks/actionWaitForEvent';
import type { FlowRunContext } from '../blocks/types';
import { executeFlowSegment, resolveWaitExit } from './executor';

export interface ResumeFlowRunDependencies {
    flowsRepo: Pick<FlowsRepo, 'getByFlowId'>;
    flowRunsRepo: Pick<FlowRunsRepo, 'claimForResume' | 'releaseClaim' | 'park' | 'complete' | 'fail'>;
}

const defaultDependencies: ResumeFlowRunDependencies = {
    flowsRepo,
    flowRunsRepo,
};

export type ResumeOutcome =
    | { status: 'completed' }
    | { status: 'suspended' }
    | { status: 'failed'; error: string }
    | { status: 'skipped'; reason: string };

/**
 * Rebuild a {@link FlowRunContext} for a parked run.
 *
 * Only `{ guildId, userId }` is persisted, so the guild and member are re-fetched
 * from the live client. `interaction` is always undefined on a resumed run — the
 * original interaction token is long expired.
 *
 * Returns a reason string instead of throwing when the guild or member is gone,
 * so the caller can fail the run cleanly.
 */
export async function rebuildResumeContext(
    client: Client,
    run: FlowRunEntity
): Promise<{ ok: true; context: FlowRunContext } | { ok: false; reason: string }> {
    const { guildId, userId } = run.contextSnapshot;

    let guild: Guild | null = client.guilds.cache.get(guildId) ?? null;
    if (!guild) {
        guild = await client.guilds.fetch(guildId).catch(() => null);
    }
    if (!guild) {
        return { ok: false, reason: `Guild ${guildId} is no longer available to this bot` };
    }

    let member: GuildMember | null = null;
    try {
        member = await guild.members.fetch(userId);
    } catch {
        member = null;
    }
    if (!member) {
        return { ok: false, reason: `Member ${userId} is no longer in guild ${guildId}` };
    }

    return {
        ok: true,
        context: {
            client,
            guild,
            member,
            user: member.user,
            // Resumed runs have no interaction — the token is expired.
            interaction: undefined,
        },
    };
}

/**
 * Resume one parked run and persist whatever happens next.
 *
 * The run is first *claimed*: a single conditional write moving it from
 * `suspended` to `running`. Only one caller can win, so a moderator's click
 * arriving at the same moment as the run's timeout can no longer advance the same
 * run twice — the loser is told it was skipped and does nothing. Everything after
 * the claim works from the row the claim returned, not from whatever the caller
 * selected a moment earlier.
 *
 * `exit` decides how a run parked on `action.waitForEvent` leaves that node:
 * 'event' when the awaited event arrived, 'timeout' when its `wakeAt` elapsed.
 * It is ignored for a plain delay, whose `resumeNodeId` already points past the
 * delay node.
 */
export async function resumeFlowRun(
    client: Client,
    run: FlowRunEntity,
    exit: 'event' | 'timeout' = 'timeout',
    dependencies: ResumeFlowRunDependencies = defaultDependencies
): Promise<ResumeOutcome> {
    const claimed = await dependencies.flowRunsRepo.claimForResume(run.runId);
    if (!claimed) {
        // The claim is all we know: the run may have been taken by another
        // resumer, already finished, been cancelled, or be gone entirely. Say what
        // is true rather than guessing which.
        return {
            status: 'skipped',
            reason: `Run ${run.runId} could not be claimed — it is already claimed, finished, or gone`,
        };
    }

    try {
        return await advanceClaimedRun(client, claimed, exit, dependencies);
    } catch (error) {
        // The run itself is fine; something around it broke. Give the claim back so
        // the next poll retries, rather than leaving it for the startup sweep.
        await dependencies.flowRunsRepo.releaseClaim(claimed.runId).catch((releaseError: unknown) => {
            console.error(`[flow-runs] Could not release the claim on run ${claimed.runId}:`, releaseError);
        });
        throw error;
    }
}

/** Advance a run this process has already claimed. */
async function advanceClaimedRun(
    client: Client,
    run: FlowRunEntity,
    exit: 'event' | 'timeout',
    dependencies: ResumeFlowRunDependencies
): Promise<ResumeOutcome> {
    if (!run.resumeNodeId) {
        const error = `Run ${run.runId} was parked but has no resumeNodeId`;
        await dependencies.flowRunsRepo.fail(run.runId, error);
        return { status: 'failed', error };
    }

    // The visit budget is carried across resumes on purpose: a loop that parks on
    // a delay must not refill it by sleeping.
    if (run.visitsUsed >= FLOW_MAX_NODE_VISITS) {
        const error = `Exceeded max node visits (${FLOW_MAX_NODE_VISITS})`;
        await dependencies.flowRunsRepo.fail(run.runId, error, run.log);
        return { status: 'failed', error };
    }

    const flow = await dependencies.flowsRepo.getByFlowId(run.flowId);
    if (!flow) {
        const error = `Flow ${run.flowId} no longer exists`;
        await dependencies.flowRunsRepo.fail(run.runId, error, run.log);
        return { status: 'failed', error };
    }

    const rebuilt = await rebuildResumeContext(client, run);
    if (!rebuilt.ok) {
        await dependencies.flowRunsRepo.fail(run.runId, rebuilt.reason, run.log);
        return { status: 'failed', error: rebuilt.reason };
    }

    // A run parked on a wait node resumes AT that node, so first work out which
    // handle it should leave by.
    let startNodeId = run.resumeNodeId;
    const resumeNode = flow.graph.nodes.find((node) => node.id === run.resumeNodeId);
    if (resumeNode?.type === ACTION_WAIT_FOR_EVENT) {
        const next = resolveWaitExit(flow.graph, run.resumeNodeId, exit);
        if (!next) {
            if (exit === 'timeout') {
                const error = `Wait node ${run.resumeNodeId} timed out and the flow has no "timeout" branch`;
                await dependencies.flowRunsRepo.fail(run.runId, error, run.log);
                return { status: 'failed', error };
            }
            // Event arrived but nothing follows the wait — the run is simply done.
            await dependencies.flowRunsRepo.complete(run.runId, run.log);
            return { status: 'completed' };
        }
        startNodeId = next;
    }

    const outcome = await executeFlowSegment(run.flowId, flow.graph, rebuilt.context, {
        startNodeId,
        triggerNodeId: run.resumeNodeId,
        visitsUsed: run.visitsUsed,
        log: run.log,
    });

    if (outcome.kind === 'suspended') {
        await dependencies.flowRunsRepo.park(run.runId, outcome.suspension);
        return { status: 'suspended' };
    }

    if (outcome.result.status === 'error') {
        const error = outcome.result.error ?? 'Unknown flow error';
        await dependencies.flowRunsRepo.fail(run.runId, error, outcome.result.log);
        return { status: 'failed', error };
    }

    await dependencies.flowRunsRepo.complete(run.runId, outcome.result.log);
    return { status: 'completed' };
}
