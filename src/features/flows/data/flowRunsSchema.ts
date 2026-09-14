import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';
import type { FlowVariableValue } from '../blocks/types';
import type { NodeRunLog } from '../engine/executor';
import type { FlowRunStatus } from './flowRunLifecycle';

/** The gateway events a parked `action.waitForEvent` node can wake on. */
export type FlowWaitKind = 'memberJoin' | 'reactionAdd' | 'buttonClick';

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
}

/** Extra matching data for a parked wait, mirroring the wait node's config. */
export interface FlowRunWaitConfig {
    eventKind: FlowWaitKind;
    timeoutMs?: number;
}

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
