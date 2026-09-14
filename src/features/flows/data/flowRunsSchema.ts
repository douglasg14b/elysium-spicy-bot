import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';
import type { FlowVariableValue } from '../blocks/types';
import type { NodeRunLog } from '../engine/executor';
import type { FlowRunStatus } from './flowRunLifecycle';

/** The gateway events a parked `action.waitForEvent` node can wake on. */
export type FlowWaitKind = 'memberJoin' | 'reactionAdd' | 'buttonClick';

/**
 * The minimal context persisted with a suspended run. Discord handles (guild,
 * member, interaction) are deliberately NOT stored — they are re-fetched on
 * resume, and `interaction` is simply gone by then.
 */
export interface FlowRunContextSnapshot {
    guildId: string;
    userId: string;
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

    /** Only `{ guildId, userId }` — see {@link FlowRunContextSnapshot}. */
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
