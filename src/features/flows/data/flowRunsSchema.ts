import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';
import type { FlowVariableValue } from '../blocks/types';
import type { NodeRunLog } from '../engine/executor';
import type { FlowRunStatus } from './flowRunLifecycle';

/**
 * The events a parked `action.waitForEvent` node can wake on.
 *
 * One of three copies kept together: the block's `flowWaitKindSchema` and the repo's
 * `waitConfigSchema` name the same members, and a member missing from either is a
 * park the block can write and the repo refuses to read back.
 *
 * `message` is the odd one out in how it is woken: not by a database fan-out per
 * event like the other three, but through the engine's in-memory index of parked
 * message waits, so a message nobody is waiting on costs no read.
 */
export type FlowWaitKind = 'memberJoin' | 'reactionAdd' | 'buttonClick' | 'message';

/**
 * The minimal context persisted with a suspended run. Discord handles (guild,
 * member, channel, interaction) are deliberately NOT stored — only their ids are,
 * and the live objects are re-fetched on resume. `interaction` is simply gone by
 * then, its token long expired.
 *
 * **`actorId` is absent by design.** A parked run has no current step, so it has
 * nobody acting on it; persisting an actor would persist a stale one and make
 * every resumed run look as though the original clicker were still there. The
 * member who advances a prompt is supplied by that interaction, not from here.
 * This is a decision, not an oversight — do not "fix" it.
 */
export interface FlowRunContextSnapshot {
    guildId: string;
    userId: string;
    /**
     * Where the run was operating when it parked, when it was anywhere at all.
     *
     * Optional because a run started by a gateway event happens in no particular
     * channel, and because rows written before this key existed simply do not
     * have it — both are the same honest "nowhere recorded", and neither needs a
     * migration to rewrite it. The id rather than the channel: a channel can be
     * deleted between park and resume, so what is stored has to be something that
     * survives the channel not existing, and resolving it is the resume path's
     * job.
     */
    channelId?: string;
    /**
     * When the run started, as an ISO-8601 UTC string.
     *
     * Written once, at the first park, and never rewritten — a later park updates the
     * row but leaves the snapshot alone — so it survives every wait unchanged.
     * Optional because rows parked before this key existed simply do not have it; the
     * resume path reports that as "no start time", never as the row's `createdAt`,
     * which is when the run first parked rather than when it began.
     */
    startedAt?: string;
}

/**
 * Extra matching data for a parked wait, mirroring the wait node's config.
 *
 * Discriminated on `eventKind` so that what only a message wait carries is required
 * there and absent everywhere else: every row parked on another kind before the
 * message arm existed still reads back unchanged.
 *
 * A message wait records:
 *
 * - `channelId` — the resolved channel it listens in, when the author picked one.
 *   Absent means anywhere in the server. A message in a thread under the channel
 *   counts.
 * - `parkedAt` — when it parked, as an ISO-8601 UTC string. It is where the outage
 *   catch-up starts looking for a reply. Its own key rather than the row's
 *   `updatedAt`, which every claim, release, reclaim and deferral bumps.
 */
export type FlowRunWaitConfig =
    | { eventKind: Exclude<FlowWaitKind, 'message'>; timeoutMs?: number }
    | { eventKind: 'message'; timeoutMs?: number; channelId?: string; parkedAt: string };

/**
 * A timed park whose deadline counts from the last qualifying message rather than
 * from when it parked.
 *
 * The scheduler reads this when the park comes due: if a qualifying message landed
 * within `durationMs`, it moves `wakeAt` to that message plus `durationMs` instead
 * of waking the run. The first `wakeAt` is park time plus the same span, so a
 * message from before the park can never bring the deadline forward.
 *
 * Discriminated on `who` so that "anyone, anywhere" is unrepresentable rather than
 * merely refused: in a live server it is never quiet, so a park asking for it would
 * wait forever. `channelId` matches the channel itself and any thread under it.
 */
export type FlowQuietWindow =
    | { durationMs: number; who: 'member'; channelId?: string }
    | { durationMs: number; who: 'anyone'; channelId: string };

/**
 * One row per durable flow run. A run only reaches this table when it suspends
 * (a delay or a wait-for-event); purely inline runs never touch the database.
 */
export interface FlowRunTable {
    id: Generated<number>;

    /** Stable public id (crypto.randomUUID) for this run. */
    runId: string;

    // Index
    flowId: string;

    // Index
    guildId: string;

    status: FlowRunStatus;

    /**
     * When a resumer claimed this run, i.e. moved it to `running`. Null whenever
     * the run is not claimed. A claim still set long after the fact means the
     * process holding it died, which is what the startup sweep looks for.
     */
    claimedAt: ColumnType<Date | null, string | null, string | null>;

    /** The node to resume AT when the run wakes. */
    resumeNodeId: string | null;

    /** When a delayed/timed-out run becomes due. Indexed for the poller. */
    wakeAt: ColumnType<Date | null, string | null, string | null>;

    /** Set when the run is parked on an event rather than a plain delay. */
    waitKind: string | null;
    waitConfig: JSONColumnType<FlowRunWaitConfig> | null;

    /**
     * The message whose components this park is waiting on, when it posted one.
     *
     * **It identifies the park, not merely the message.** A run can park at the
     * same node twice — an author who wires a branch back to the question asks it
     * again — and every other column is identical across those two parks:
     * `resumeNodeId` is the same node, `status` is `suspended` both times. So a
     * button from the first park is indistinguishable from a live one by anything
     * else stored, and pressing it would advance the run a second time. Each park
     * posts its own message, so this is the one value that differs, which is what
     * lets a claim name *which* park it believes it is resuming.
     *
     * Null for every park that posted nothing — a delay, a gateway wait, and every
     * row written before this column existed. All three are the same honest "no
     * message is holding this run", so none of them needs rewriting.
     */
    waitMessageId: string | null;

    /**
     * Set when this park's deadline counts from the last qualifying message — see
     * {@link FlowQuietWindow}. Null for every other park and every row written
     * before the column existed, which all mean the same thing: `wakeAt` stands.
     *
     * Its own column rather than a member of `waitConfig`, which describes an
     * *event* wait and which a plain delay never sets.
     */
    quietWindow: JSONColumnType<FlowQuietWindow> | null;

    /** Who the run is about and where it was — see {@link FlowRunContextSnapshot}. */
    contextSnapshot: JSONColumnType<FlowRunContextSnapshot>;

    /**
     * Values blocks recorded before this run parked, keyed by the flat output
     * names their authors declared.
     *
     * Its own column rather than a member of {@link FlowRunContextSnapshot}: the
     * snapshot records *who and where* a run is, which is re-fetched from Discord
     * on resume, whereas these are the run's own accumulated work and exist
     * nowhere else. Widening the snapshot is a separate change with a migration
     * that rewrites every stored row; this one only ever adds.
     *
     * Defaulted to `{}` in the migration, so a row parked before variables
     * existed reads back as a run that recorded nothing — which is exactly what
     * it is, and needs no tolerant union to say so.
     */
    variables: JSONColumnType<Record<string, FlowVariableValue>>;

    /**
     * Node visits consumed so far, carried across resumes so a loop containing
     * a delay cannot reset its budget every wake-up.
     */
    visitsUsed: number;

    /** Accumulated node log across every segment of this run. */
    log: JSONColumnType<NodeRunLog[]>;

    error: string | null;

    /** Schema migration marker (matches the existing entityVersion convention). */
    entityVersion: number;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type FlowRunEntity = Selectable<FlowRunTable>;
export type NewFlowRunEntity = Insertable<FlowRunTable>;
export type FlowRunUpdateEntity = Updateable<FlowRunTable>;
