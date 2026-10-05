import type { ColumnType, Generated, Selectable } from 'kysely';

/**
 * One row per Schedule trigger node in a guild's flows: when it next fires.
 *
 * Kept by reconcile (`logic/reconcileGuildSchedules.ts`) from the saved `flows` rows —
 * never from drafts — and read by the shared run tick, which fires the due ones. Nothing
 * here knows what a schedule repeats on: that is the block's config, and `configKey` is
 * the whole of what this table holds about it.
 *
 * A switched-off flow keeps its rows with no `nextRunAt`, so `lastRunId` survives: the row
 * is the only link between a schedule and a run it started that is still parked
 * (`flow_runs` stores no trigger node), and switching the flow back on must not let a new
 * run overlap that one. Rows go only when their node or their flow does.
 */
export interface FlowScheduleTable {
    id: Generated<number>;

    /** Copied from the flow, so a guild's rows are found without a join. */
    guildId: string;

    /** The flow holding the trigger, by `flows.flowId`. */
    flowId: string;

    /** The Schedule trigger node within that flow's graph. */
    nodeId: string;

    /**
     * The stable JSON of the node's parsed, visible config plus the server's effective
     * time zone. Reconcile leaves a row whose key is unchanged alone — which is what makes
     * a time missed while the bot was down fire once — and works out a fresh next time when
     * it differs.
     */
    configKey: string;

    /**
     * When it next fires. Null on a switched-off flow, and on one whose time could not be
     * worked out (a zone `Intl` no longer accepts) — never due, never shown.
     */
    nextRunAt: ColumnType<Date | null, string | null, string | null>;

    /**
     * The `runId` of the last run this schedule started that parked, or null. While that
     * run is still parked or running, the schedule's next time is skipped.
     */
    lastRunId: string | null;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type FlowScheduleEntity = Selectable<FlowScheduleTable>;
