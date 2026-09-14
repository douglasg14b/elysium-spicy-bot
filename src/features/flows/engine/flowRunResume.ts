import { DiscordAPIError, DiscordjsError, DiscordjsErrorCodes, RESTJSONErrorCodes } from 'discord.js';
import type { Channel, Client, Guild, GuildMember, GuildTextBasedChannel } from 'discord.js';
import { FLOW_MAX_NODE_VISITS } from '../constants';
import { FlowRunsRepo, flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import { FlowsRepo, flowsRepo } from '../data/flowsRepo';
import type { FlowResumeReason, FlowRunSeed } from '../blocks/types';
import { emptyBagWith, executeFlowSegment } from './executor';
import { asGuildTextChannel } from './runChannel';

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
 * Rebuild a {@link FlowRunSeed} for a parked run.
 *
 * Only ids are persisted, so the guild, subject and channel are re-fetched from
 * the live client. `interaction` is always undefined on a resumed run — the
 * original interaction token is long expired — and so is `actor`, because a run
 * woken by the clock was not caused by anybody.
 *
 * **The channel is resolved from its stored id, not rebuilt from the trigger.**
 * Without this a resumed run could not answer "where am I", so `condition.inChannel`
 * would take the false branch every time — right answer by accident on a run that
 * really had moved, wrong on every other, and indistinguishable from the outside.
 *
 * **It is the channel the run *parked* in, not the one the waking event happened
 * in**, and those can differ: a run parked in #general wakes on a reaction the
 * member adds in #announcements. The parked channel is the deliberate answer —
 * it is where the run is operating, which is what a block asking "where am I"
 * means, and it stays stable across however many events wake the run. An event
 * channel would make the same graph answer differently depending on where the
 * member happened to click.
 *
 * It is also the only answer that *can* be coherent: `resumeWaitingRunsForEvent`
 * fans one event out over every parked run it matches, and those runs may have
 * parked in different channels. There is no single "the event's channel" that is
 * right for all of them, so threading one would make unrelated runs answer
 * `inChannel` against somewhere they have never been. That is why
 * `resumeWaitingRunsForEvent` carries no channel. If a block ever needs the waking
 * event's location, it is a new fact to add beside this one, not a redefinition
 * of it.
 *
 * **The variable bag is seeded from the row, not started empty.** This is the half
 * of the write channel that is easiest to leave unbuilt and hardest to notice
 * missing: everything still passes when a producer and its consumer happen to sit
 * in one segment, and every value silently disappears the moment a wait comes
 * between them. A block reading `{{var.x}}` after a park would then fail for a
 * reason no author could see from their canvas.
 *
 * Returns a reason string instead of throwing when the guild or member is gone,
 * so the caller can fail the run cleanly. It *does* throw when a channel fetch
 * fails transiently, because that is not a run that cannot run — it is a question
 * that could not be asked, and the run should be retried rather than failed.
 */
export async function rebuildResumeContext(
    client: Client,
    run: FlowRunEntity
): Promise<{ ok: true; context: FlowRunSeed } | { ok: false; reason: string }> {
    const { guildId, userId, channelId } = run.contextSnapshot;

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

    const resolved = await resolveSnapshotChannel(guild, channelId, run.runId);
    if (resolved.status === 'unavailable') {
        // Deliberately a *throw*, not an `ok: false`. The two failure shapes mean
        // different things here: `ok: false` is "this run cannot run" and the
        // caller fails it terminally, which is right for a deleted guild or a
        // departed member but wrong for a Discord hiccup. Throwing takes the path
        // that releases the claim and leaves the run parked, so the next poll
        // simply asks again — the honest response to "I could not find out",
        // and the one thing advancing on a guess can never be.
        throw new Error(`Could not resolve channel ${channelId} for run ${run.runId}; leaving it parked to retry`, {
            cause: resolved.cause,
        });
    }

    return {
        ok: true,
        context: {
            client,
            guild,
            subject: member,
            // A resumed run has no actor: nobody caused this step, the clock did.
            // Reporting the subject here would make every resumed run look like
            // the subject acted on themselves.
            actor: undefined,
            channel: resolved.channel,
            // Everything blocks recorded before the park, read back off the row.
            // Re-bagged rather than used as parsed: a row that has been through
            // JSON and Zod comes back as an ordinary object, so without this a
            // resumed run's bag inherits a prototype the same bag never had on
            // the leg that wrote it.
            variables: emptyBagWith(run.variables),
            // Resumed runs have no interaction — the token is expired.
            interaction: undefined,
        },
    };
}

/**
 * What became of the channel a run parked in.
 *
 * Three outcomes, not two, because "there is no channel" and "I could not find
 * out" are different facts and only one of them is safe to act on.
 *
 * `resolved` carries the channel or `undefined`. **A missing channel is a state,
 * not a failure**: one can be archived or deleted in the days between a park and
 * its wake, and the run is still perfectly valid — the context models an absent
 * channel precisely so that is expressible, and every block treats "nowhere" as a
 * legitimate answer. Failing a run whose remaining steps are a DM and a role would
 * be worse than letting it proceed knowing it is nowhere.
 *
 * `unavailable` is a rate limit or an outage — the question could not be asked.
 * Treating that as "nowhere" would send `condition.inChannel` down the false branch
 * and report success, turning a transient Discord fault into a run that silently
 * took a path its author never drew. That is the silent-false-branch bug this slice
 * exists to remove, and it would be reappearing one door over.
 *
 * It carries the underlying error as `cause`. This is the one branch that retries
 * indefinitely, so it is also the one where "why" has to survive to the log — a 429,
 * a network reset and an unlisted error code are otherwise indistinguishable in the
 * only place anyone would look.
 */
type SnapshotChannel =
    | { status: 'resolved'; channel: GuildTextBasedChannel | undefined }
    | { status: 'unavailable'; cause: unknown };

/**
 * The failures that mean the channel is gone for good rather than momentarily
 * unreachable.
 *
 * **A revoked permission belongs here, not in `unavailable`.** It reads like a
 * transient fault and is not one: nothing about polling again makes the bot's access
 * come back, so classifying it as "could not ask" leaves the run retrying every poll
 * forever — never completing, never failing, and absent from every operator surface
 * because `findDue` keeps reporting it as ordinary due work. That is the same
 * invisible-wrong-state class this slice exists to remove.
 *
 * `MissingAccess` is what `GET /channels/{id}` returns when the channel still exists
 * but the bot can no longer see it — a distinct code from `UnknownChannel`, so the
 * deleted case and the walled-off case arrive separately and both have to be named.
 *
 * Typed as the union `DiscordAPIError.code` actually holds rather than as the enum:
 * the enum's members are numeric, but the field is `number | string`, so a set of
 * `RESTJSONErrorCodes` would only accept a lookup through a cast. Asserting the value
 * into the enum to satisfy a narrower collection would tell `tsc` something about a
 * string code that is not true, and would silently stop matching if an entry here
 * ever were one.
 */
const CHANNEL_GONE_FOR_GOOD: ReadonlySet<number | string> = new Set<number | string>([
    RESTJSONErrorCodes.UnknownChannel,
    RESTJSONErrorCodes.MissingAccess,
]);

/**
 * Resolve the channel a run parked in, given the id it stored.
 *
 * **Every path that loses a channel says so.** Losing one is designed degradation —
 * the run carries on knowing it is nowhere — but it also silently changes the run's
 * route, because `condition.inChannel` then answers "no" to every question and the
 * run completes reporting success. Degradation that is invisible is indistinguishable
 * from a bug, so each way of arriving at "nowhere" names itself once, and the run id
 * is carried in purely so those lines identify the run they are about.
 *
 * The exception is a run that stored no channel at all: that is not a loss, it is a
 * run that was never anywhere, and logging it would be noise on every gateway-started
 * run in the guild.
 */
async function resolveSnapshotChannel(
    guild: Guild,
    channelId: string | undefined,
    runId: string
): Promise<SnapshotChannel> {
    if (!channelId) {
        return { status: 'resolved', channel: undefined };
    }

    const channel = guild.channels.cache.get(channelId);
    if (channel) {
        return { status: 'resolved', channel: narrowOrReport(channel, channelId, runId) };
    }

    try {
        const fetched = await guild.channels.fetch(channelId);
        return { status: 'resolved', channel: narrowOrReport(fetched, channelId, runId) };
    } catch (error) {
        // The failures that are an *answer*: the channel is gone or walled off, so
        // the run is nowhere and may carry on saying so.
        if (error instanceof DiscordAPIError && CHANNEL_GONE_FOR_GOOD.has(error.code)) {
            console.warn(
                `[flow-runs] Run ${runId} parked in channel ${channelId}, which is now gone or invisible to the bot ` +
                    `(${error.code}); it resumes as though it were nowhere, so "is this run in #x" answers no.`
            );
            return { status: 'resolved', channel: undefined };
        }
        // Not a `DiscordAPIError` at all: discord.js throws this itself when the id
        // resolves to a channel in a different guild. Permanent by definition — the
        // channel will never migrate into this guild — and it would otherwise fall
        // through to the retry-forever branch precisely because it fails the
        // `instanceof` check above.
        if (error instanceof DiscordjsError && error.code === DiscordjsErrorCodes.GuildChannelUnowned) {
            console.warn(
                `[flow-runs] Run ${runId} stored channel ${channelId}, which belongs to another guild; ` +
                    'it resumes as though it were nowhere.'
            );
            return { status: 'resolved', channel: undefined };
        }
        return { status: 'unavailable', cause: error };
    }
}

/**
 * Narrow a channel the run can still see, reporting it when the answer is "not one a
 * run can use".
 *
 * This case is easy to miss because it is not a failure: the fetch succeeded, the id
 * is exactly the one recorded, and the bot can see it — but the channel is a forum,
 * media or category parent, which holds threads rather than messages. Without this it
 * would collapse into the same silent `undefined` as a run that never had a channel.
 * A text channel converted to a forum in place keeps its id, so a run parked in it
 * before the change lands here on every resume.
 */
function narrowOrReport(
    candidate: Channel | null | undefined,
    channelId: string,
    runId: string
): GuildTextBasedChannel | undefined {
    const usable = asGuildTextChannel(candidate);
    if (!usable && candidate) {
        console.warn(
            `[flow-runs] Run ${runId} parked in channel ${channelId}, which is no longer one a run can use ` +
                `(type ${candidate.type}); it resumes as though it were nowhere.`
        );
    }
    return usable;
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
 * `exit` says why the run is waking: `event` when the gateway event it was parked
 * on arrived, `timeout` when its `wakeAt` elapsed, `choice` when a person picked
 * one of the options the parked block offered. It is handed to the node that
 * parked, which maps it to one of its own declared handles — this module names no
 * block and knows nothing about what any of them wait for.
 *
 * Required rather than defaulted. It used to default to `timeout`, which meant a
 * caller that forgot to say why a run woke got a plausible answer instead of a
 * compile error — survivable while there were two reasons and the wrong one only
 * cost a branch, but not once a reason carries which button somebody pressed.
 */
export async function resumeFlowRun(
    client: Client,
    run: FlowRunEntity,
    exit: FlowResumeReason,
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
    exit: FlowResumeReason,
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

    // The run resumes AT the node that parked it, which is re-entered and told
    // why it woke. Choosing the exit is that block's job, not this one's.
    const outcome = await executeFlowSegment(run.flowId, flow.graph, rebuilt.context, {
        // The row's own id, so a block re-entered here addresses the run it is
        // actually in — a fresh one would name a run nothing can find.
        runId: run.runId,
        startNodeId: run.resumeNodeId,
        triggerNodeId: run.resumeNodeId,
        visitsUsed: run.visitsUsed,
        log: run.log,
        // Carried forward so a block downstream of the wait reads what blocks
        // upstream of it recorded, exactly as it would without the park.
        variables: rebuilt.context.variables,
        // Addressed to the parked node. A pre-M1 delay row names the node *after*
        // the delay, which never parked, so this matches nothing and that run
        // simply carries on from there — exactly as it did before M1.
        resume: { nodeId: run.resumeNodeId, reason: exit },
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
