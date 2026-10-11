import type { Client } from 'discord.js';
import type { ActivityEventsRepo, RecordedActivityEvent } from '../../../features-system/activity';
import { RESUME_EVENT } from '../blocks/types';
import type { ClaimedPark, FlowRunsRepo } from '../data/flowRunsRepo';
import { resumeFlowRun } from './flowRunResume';
import { messageActivityLimit, type MessageActivityLimit } from './messageActivityLimit';
import { messageWaitIndex } from './messageWaitIndex';

/**
 * Waking runs parked on Wait for Event's message kind: live, as messages arrive, and
 * once after a restart for replies sent while the bot was down.
 *
 * Both go through {@link messageWaitIndex}, never a per-message query, so a message
 * from a member nobody is waiting on costs a map lookup and nothing else.
 */

/**
 * The claim every message wake makes: only a run still parked on a message — see
 * {@link messageWaitIndex} for why the index alone is not trusted with that.
 */
const MESSAGE_WAIT_PARK: ClaimedPark = { waitKind: 'message' };

/**
 * Wake every run waiting on a message that this one satisfies — called first by
 * `handleMessage`, the activity subscriber flows registers, before it starts triggers.
 *
 * A run matches when the poster is its member and it listens anywhere, in the channel
 * posted in, or in the channel a thread sits under. Runs are resumed one after another
 * from a copy taken up front, and each is skipped if its entry has changed by the time
 * its turn comes: a run timed out and parked on a new wait while an earlier one resumed
 * is waiting for a message after this one.
 *
 * The claim also carries when the message was sent, so a park whose deadline had already
 * passed — its timeout merely not processed yet, as while the scheduler holds message
 * waits through a restart — is left to time out rather than saved by a late reply.
 *
 * **Each wake-up draws from the message flood limit** — one token from the guild and
 * one from the member, per run woken, taken before the claim (so a claim that misses —
 * the run moved on — still spent its token; rare, and cheaper than a refund path). That
 * is what bounds
 * "Message Sent → reply → wait for a message → reply", where every message would
 * otherwise wake every earlier copy. A refused run is skipped and stays parked: the
 * member's next message, or its time limit, moves it on. Still no database read: the
 * limit is in memory too.
 *
 * Reactions are ignored. Each failure is logged on its own, and a run that cannot be
 * claimed — already woken, or moved on — is skipped quietly.
 */
export async function wakeMessageWaits(
    event: RecordedActivityEvent,
    limit: Pick<MessageActivityLimit, 'take'> = messageActivityLimit
): Promise<void> {
    if (event.kind !== 'message') return;

    // Taken synchronously, before any await, and that is load-bearing: leveling is a
    // parallel subscriber, and a Level Reached run this same message causes can only
    // park after leveling's own database write — so it is never in this snapshot and
    // never woken by the message that started it. An await before this line would
    // break that silently.
    //
    // A run about nobody is never among these: the index refuses a message wait with no
    // member, and validation keeps one from parking on a path about nobody.
    const entries = messageWaitIndex.matching({
        guildId: event.guild.id,
        userId: event.userId,
        channelId: event.channelId,
        parentChannelId: event.parentChannelId,
    });

    for (const entry of entries) {
        if (messageWaitIndex.get(entry.runId) !== entry) continue;
        if (!limit.take(entry.guildId, entry.userId, 'wake')) continue;
        await resumeOnMessage(event.message.client, entry.runId, { ...MESSAGE_WAIT_PARK, eventAt: event.message.createdAt });
    }
}

/**
 * Load every run parked on a message wait into the index.
 *
 * For the scheduler's startup sweep, **after** it has reclaimed claims a dead process
 * left behind, so a run stranded mid-resume is loaded too. Adds rather than replaces: a
 * run that parked while the read was in flight already wrote a newer entry. Never
 * throws: a failure — one unreadable row fails the whole read — is logged loudly, and
 * the bot carries on without those runs' message wakes rather than not starting.
 */
export async function rebuildMessageWaitIndex(flowRunsRepo: Pick<FlowRunsRepo, 'findWaiting'>): Promise<void> {
    try {
        const waiting = await flowRunsRepo.findWaiting({ waitKind: 'message' });
        messageWaitIndex.addMissing(waiting);
        if (waiting.length > 0) {
            console.info(`[flow-runs] Indexed ${waiting.length} run(s) waiting on a message`);
        }
    } catch (error) {
        console.error(
            '[flow-runs] Could not load the runs waiting on a message, so none of them will wake on a message — ' +
                'live or from replies sent while the bot was down — until the next restart. Their time limits still apply:',
            error
        );
    }
}

/**
 * Wake every indexed message wait whose member replied while the bot was down — once,
 * after activity's startup backfill has restored those messages.
 *
 * One run at a time, each resume finished before the next begins: that is the pacing,
 * so a large catch-up cannot flood a guild — and why it never draws from the message
 * flood limit, which would drop a reply the member really sent. For each run it asks the activity record for
 * a message by the member, in the run's channel or a thread under it, between when the
 * run parked and the earlier of its deadline and now. Found, the run wakes by its event
 * exit — once, however many messages there were — carrying when the latest of them was
 * sent, as a live wake carries its message's time: a wait the run parks on next listens
 * after it, so the same recovered reply cannot wake the run again after another restart.
 * Not found, it is left: a run past its deadline is timed out by the scheduler once the
 * hold on message waits lifts, and a message sent after the deadline does not save it.
 *
 * A run whose park changes while its history is being read — a live message woke it,
 * and it parked again — is left to the live wake: the park the catch-up looked at is
 * over.
 *
 * Known gaps. If the backfill failed or never started, this reads partial history and
 * can only find replies the live recorder heard. And for a message wait that also has a
 * quiet window, the range ends at the *stored* deadline, which the scheduler may still
 * push back: a reply after it but inside the extension is not found here, and the run
 * times out later even though the member answered in time.
 *
 * Returns how many runs it resumed, for its log line.
 */
export async function resumeMessageWaitsAfterBackfill(
    client: Client,
    activityEventsRepo: Pick<ActivityEventsRepo, 'findLastMessageBetween'>
): Promise<number> {
    let resumed = 0;

    for (const runId of messageWaitIndex.runIds()) {
        const entry = messageWaitIndex.get(runId);
        // Claimed since the list was taken; whoever claimed it owns it now.
        if (!entry) continue;

        try {
            const now = Date.now();
            const lastReplyAt = await activityEventsRepo.findLastMessageBetween({
                guildId: entry.guildId,
                userId: entry.userId,
                ...(entry.channelId ? { channelId: entry.channelId } : {}),
                from: entry.parkedAt,
                to: new Date(Math.min(entry.wakeAt?.getTime() ?? now, now)),
            });
            if (!lastReplyAt || messageWaitIndex.get(runId) !== entry) continue;

            if (await resumeOnMessage(client, runId, { ...MESSAGE_WAIT_PARK, eventAt: lastReplyAt })) {
                resumed += 1;
            }
        } catch (error) {
            console.error(`[flow-runs] Could not look for a reply to run ${runId} sent while the bot was down:`, error);
        }
    }

    if (resumed > 0) {
        console.info(`[flow-runs] Woke ${resumed} run(s) on a reply sent while the bot was down`);
    }
    return resumed;
}

/**
 * Resume one run on a message, logging rather than throwing. Returns whether it was
 * claimed — false when it had already moved on.
 */
async function resumeOnMessage(client: Client, runId: string, claimedPark: ClaimedPark): Promise<boolean> {
    try {
        const outcome = await resumeFlowRun(client, { runId }, RESUME_EVENT, undefined, claimedPark);
        if (outcome.status === 'failed') {
            console.warn(`[flow-runs] Run ${runId} failed on waking for a message: ${outcome.error}`);
        }
        return outcome.status !== 'skipped';
    } catch (error) {
        console.error(`[flow-runs] Unexpected error waking run ${runId} for a message:`, error);
        return false;
    }
}
