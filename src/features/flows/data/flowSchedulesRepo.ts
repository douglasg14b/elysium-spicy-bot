import { FLOW_RUN_POLL_BATCH_SIZE } from '../constants';
import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import type { FlowScheduleEntity } from './flowSchedulesSchema';

/** Which trigger node a schedule row belongs to. */
export interface FlowScheduleTarget {
    readonly flowId: string;
    readonly nodeId: string;
}

/** Everything {@link FlowSchedulesRepo.upsert} writes. `lastRunId` is never among it. */
export interface FlowScheduleInput extends FlowScheduleTarget {
    readonly guildId: string;
    readonly configKey: string;
    /** Null for a switched-off flow, or a time that could not be worked out. */
    readonly nextRunAt: Date | null;
}

/** One schedule's next time, for the builder's countdown. */
export interface FlowScheduleNextRun {
    readonly nodeId: string;
    readonly nextRunAt: Date;
}

/**
 * Persistence for `flow_schedules` — one row per Schedule trigger node, holding when it
 * next fires. See `flowSchedulesSchema.ts` for what a row means.
 */
export class FlowSchedulesRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /** Every schedule row in a guild, switched-off flows' included. */
    async listForGuild(guildId: string): Promise<FlowScheduleEntity[]> {
        return this.db.selectFrom('flow_schedules').selectAll().where('guildId', '=', guildId).orderBy('id', 'asc').execute();
    }

    /**
     * Write a schedule's key and next time, creating its row if it has none.
     *
     * An upsert on the `(flowId, nodeId)` unique index, so two reconciles racing each
     * other land on one row. **`lastRunId` is left alone** on the update half: a changed
     * schedule or a flow switched off and on still knows which of its runs may be parked,
     * and a new row starts with none.
     */
    async upsert(input: FlowScheduleInput): Promise<void> {
        const now = new Date().toISOString();
        const nextRunAt = input.nextRunAt ? input.nextRunAt.toISOString() : null;
        await this.db
            .insertInto('flow_schedules')
            .values({
                guildId: input.guildId,
                flowId: input.flowId,
                nodeId: input.nodeId,
                configKey: input.configKey,
                nextRunAt,
                lastRunId: null,
                createdAt: now,
                updatedAt: now,
            })
            .onConflict((conflict) =>
                conflict.columns(['flowId', 'nodeId']).doUpdateSet({
                    guildId: input.guildId,
                    configKey: input.configKey,
                    nextRunAt,
                    updatedAt: now,
                })
            )
            .execute();
    }

    /**
     * Delete these rows — reconcile's rows whose node or flow is gone, picked from the rows
     * it read. Nothing to delete is no query at all.
     */
    async deleteByIds(ids: readonly number[]): Promise<void> {
        if (ids.length === 0) {
            return;
        }
        await this.db.deleteFrom('flow_schedules').where('id', 'in', ids).execute();
    }

    /** Rows whose next time has come, oldest first, at most `limit` of them. */
    async findDue(now: Date, limit: number = FLOW_RUN_POLL_BATCH_SIZE): Promise<FlowScheduleEntity[]> {
        return this.db
            .selectFrom('flow_schedules')
            .selectAll()
            .where('nextRunAt', 'is not', null)
            .where('nextRunAt', '<=', now)
            .orderBy('nextRunAt', 'asc')
            .limit(limit)
            .execute();
    }

    /**
     * Move a due row's next time on, only while it still holds the time the caller read.
     * Returns whether it moved.
     *
     * What makes firing at most once: the tick advances a row **before** it starts the run,
     * and a second advance from the same reading — another tick, a reconcile that rewrote
     * the row in between — matches nothing, so `false` is the ordinary answer to losing
     * that race. `nextRunAt` may be null, for a time that can no longer be worked out.
     *
     * The equality only holds if `nextRunAt` round-trips exactly — the reason
     * `flowRunsRepo.deferWake` gives: text-to-text on SQLite, and on postgres only because
     * `timestamptz` keeps the milliseconds `toISOString` wrote. If it ever did not, every
     * advance would quietly miss and the row would never fire. `deferWake`'s postgres arm
     * was proven live; this one rides the same columns and the same comparison.
     */
    async advance(id: number, readNextRunAt: Date, nextRunAt: Date | null): Promise<boolean> {
        const result = await this.db
            .updateTable('flow_schedules')
            .set({ nextRunAt: nextRunAt ? nextRunAt.toISOString() : null, updatedAt: new Date().toISOString() })
            .where('id', '=', id)
            .where('nextRunAt', '=', readNextRunAt)
            .executeTakeFirst();

        return Number(result?.numUpdatedRows ?? 0) > 0;
    }

    /** Record the run this schedule last started that parked. */
    async setLastRunId(id: number, runId: string): Promise<void> {
        await this.db
            .updateTable('flow_schedules')
            .set({ lastRunId: runId, updatedAt: new Date().toISOString() })
            .where('id', '=', id)
            .execute();
    }

    /** The next time of each of a flow's schedules that has one, for the builder's countdown. */
    async nextRunsForFlow(flowId: string): Promise<FlowScheduleNextRun[]> {
        const rows = await this.db
            .selectFrom('flow_schedules')
            .select(['nodeId', 'nextRunAt'])
            .where('flowId', '=', flowId)
            .where('nextRunAt', 'is not', null)
            .orderBy('id', 'asc')
            .execute();

        return rows.flatMap((row) => (row.nextRunAt ? [{ nodeId: row.nodeId, nextRunAt: row.nextRunAt }] : []));
    }
}

export const flowSchedulesRepo = new FlowSchedulesRepo();
