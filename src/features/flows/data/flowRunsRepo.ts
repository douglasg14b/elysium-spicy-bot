import { randomUUID } from 'crypto';
import { z } from 'zod';
import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import { FLOW_RUN_ENTITY_VERSION, FLOW_RUN_POLL_BATCH_SIZE } from '../constants';
import type { NodeRunLog } from '../engine/executor';
import type {
    FlowRunContextSnapshot,
    FlowRunEntity,
    FlowRunStatus,
    FlowRunWaitConfig,
    FlowWaitKind,
} from './flowRunsSchema';

export interface CreateFlowRunInput {
    flowId: string;
    guildId: string;
    contextSnapshot: FlowRunContextSnapshot;
    resumeNodeId: string;
    wakeAt?: Date | null;
    waitKind?: FlowWaitKind | null;
    waitConfig?: FlowRunWaitConfig | null;
    visitsUsed?: number;
    log?: NodeRunLog[];
    status?: FlowRunStatus;
    /** Optional explicit runId; a UUID is generated when omitted. */
    runId?: string;
}

export interface UpdateFlowRunInput {
    status?: FlowRunStatus;
    resumeNodeId?: string | null;
    wakeAt?: Date | null;
    waitKind?: FlowWaitKind | null;
    waitConfig?: FlowRunWaitConfig | null;
    visitsUsed?: number;
    log?: NodeRunLog[];
    error?: string | null;
}

export interface FindWaitingFilter {
    guildId?: string;
    flowId?: string;
    waitKind?: FlowWaitKind;
}

const nodeRunLogSchema = z.object({
    nodeId: z.string(),
    type: z.string(),
    kind: z.enum(['trigger', 'condition', 'action']),
    status: z.enum(['ok', 'error']),
    branch: z.enum(['true', 'false']).optional(),
    error: z.string().optional(),
});

const contextSnapshotSchema = z.object({
    guildId: z.string().min(1),
    userId: z.string().min(1),
});

const waitConfigSchema = z.object({
    eventKind: z.enum(['memberJoin', 'reactionAdd', 'buttonClick']),
    timeoutMs: z.number().int().positive().optional(),
});

const logSchema = z.array(nodeRunLogSchema);

/**
 * Persistence for durable flow runs. A row exists only for a run that has
 * suspended at least once; purely inline runs never touch this table.
 *
 * The JSON columns are re-validated on read (mirroring
 * {@link FlowsRepo.assertValidGraph}) so a corrupt row surfaces as a clear
 * error instead of an unsafe cast.
 */
export class FlowRunsRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    async create(input: CreateFlowRunInput): Promise<FlowRunEntity> {
        const runId = input.runId ?? randomUUID();
        const now = new Date().toISOString();

        await this.db
            .insertInto('flow_runs')
            .values({
                runId,
                flowId: input.flowId,
                guildId: input.guildId,
                status: input.status ?? 'pending',
                resumeNodeId: input.resumeNodeId,
                wakeAt: input.wakeAt ? input.wakeAt.toISOString() : null,
                waitKind: input.waitKind ?? null,
                waitConfig: input.waitConfig ? JSON.stringify(input.waitConfig) : null,
                contextSnapshot: JSON.stringify(input.contextSnapshot),
                visitsUsed: input.visitsUsed ?? 0,
                log: JSON.stringify(input.log ?? []),
                error: null,
                entityVersion: FLOW_RUN_ENTITY_VERSION,
                createdAt: now,
                updatedAt: now,
            })
            .execute();

        const saved = await this.getByRunId(runId);
        if (!saved) {
            throw new Error(`Flow run create succeeded but row was not found for runId ${runId}`);
        }

        return saved;
    }

    async getByRunId(runId: string): Promise<FlowRunEntity | null> {
        const row = await this.db
            .selectFrom('flow_runs')
            .selectAll()
            .where('runId', '=', runId)
            .executeTakeFirst();

        return row ? this.assertValidJsonColumns(row) : null;
    }

    /** Pending runs whose `wakeAt` has passed — the poller's work queue. */
    async findDue(now: Date, limit: number = FLOW_RUN_POLL_BATCH_SIZE): Promise<FlowRunEntity[]> {
        const rows = await this.db
            .selectFrom('flow_runs')
            .selectAll()
            .where('status', '=', 'pending')
            .where('wakeAt', 'is not', null)
            .where('wakeAt', '<=', now)
            .orderBy('wakeAt', 'asc')
            .limit(limit)
            .execute();

        return rows.map((row) => this.assertValidJsonColumns(row));
    }

    /**
     * Pending runs parked on an event. Used by the dispatchers to find runs a
     * freshly-arrived event should wake; the caller still matches on the run's
     * own `contextSnapshot.userId`.
     */
    async findWaiting(filter: FindWaitingFilter = {}): Promise<FlowRunEntity[]> {
        let query = this.db
            .selectFrom('flow_runs')
            .selectAll()
            .where('status', '=', 'pending')
            .where('waitKind', 'is not', null);

        if (filter.guildId !== undefined) {
            query = query.where('guildId', '=', filter.guildId);
        }
        if (filter.flowId !== undefined) {
            query = query.where('flowId', '=', filter.flowId);
        }
        if (filter.waitKind !== undefined) {
            query = query.where('waitKind', '=', filter.waitKind);
        }

        const rows = await query.orderBy('createdAt', 'asc').execute();
        return rows.map((row) => this.assertValidJsonColumns(row));
    }

    async update(runId: string, input: UpdateFlowRunInput): Promise<FlowRunEntity> {
        const updateData: Record<string, unknown> = { updatedAt: new Date().toISOString() };

        if (input.status !== undefined) {
            updateData.status = input.status;
        }
        if (input.resumeNodeId !== undefined) {
            updateData.resumeNodeId = input.resumeNodeId;
        }
        if (input.wakeAt !== undefined) {
            updateData.wakeAt = input.wakeAt ? input.wakeAt.toISOString() : null;
        }
        if (input.waitKind !== undefined) {
            updateData.waitKind = input.waitKind;
        }
        if (input.waitConfig !== undefined) {
            updateData.waitConfig = input.waitConfig ? JSON.stringify(input.waitConfig) : null;
        }
        if (input.visitsUsed !== undefined) {
            updateData.visitsUsed = input.visitsUsed;
        }
        if (input.log !== undefined) {
            updateData.log = JSON.stringify(input.log);
        }
        if (input.error !== undefined) {
            updateData.error = input.error;
        }

        await this.db.updateTable('flow_runs').set(updateData).where('runId', '=', runId).execute();

        const saved = await this.getByRunId(runId);
        if (!saved) {
            throw new Error(`Flow run update succeeded but row was not found for runId ${runId}`);
        }

        return saved;
    }

    /** Mark a run finished; clears the wake/wait fields so it is never re-picked. */
    async complete(runId: string, log?: NodeRunLog[]): Promise<FlowRunEntity> {
        return this.update(runId, {
            status: 'completed',
            resumeNodeId: null,
            wakeAt: null,
            waitKind: null,
            waitConfig: null,
            error: null,
            ...(log ? { log } : {}),
        });
    }

    async fail(runId: string, error: string, log?: NodeRunLog[]): Promise<FlowRunEntity> {
        return this.update(runId, {
            status: 'failed',
            resumeNodeId: null,
            wakeAt: null,
            waitKind: null,
            waitConfig: null,
            error,
            ...(log ? { log } : {}),
        });
    }

    async cancel(runId: string, reason?: string): Promise<FlowRunEntity> {
        return this.update(runId, {
            status: 'cancelled',
            resumeNodeId: null,
            wakeAt: null,
            waitKind: null,
            waitConfig: null,
            error: reason ?? null,
        });
    }

    /**
     * The SqliteJsonPlugin parses the JSON columns back into objects, but a
     * corrupt row could still slip through. Re-validate defensively.
     */
    private assertValidJsonColumns(row: FlowRunEntity): FlowRunEntity {
        const snapshot = contextSnapshotSchema.safeParse(row.contextSnapshot);
        if (!snapshot.success) {
            throw new Error(
                `Flow run ${row.runId} has an invalid stored contextSnapshot: ${snapshot.error.issues
                    .map((issue) => issue.message)
                    .join('; ')}`
            );
        }

        const log = logSchema.safeParse(row.log);
        if (!log.success) {
            throw new Error(
                `Flow run ${row.runId} has an invalid stored log: ${log.error.issues
                    .map((issue) => issue.message)
                    .join('; ')}`
            );
        }

        let waitConfig: FlowRunWaitConfig | null = null;
        if (row.waitConfig !== null && row.waitConfig !== undefined) {
            const parsed = waitConfigSchema.safeParse(row.waitConfig);
            if (!parsed.success) {
                throw new Error(
                    `Flow run ${row.runId} has an invalid stored waitConfig: ${parsed.error.issues
                        .map((issue) => issue.message)
                        .join('; ')}`
                );
            }
            waitConfig = parsed.data;
        }

        return { ...row, contextSnapshot: snapshot.data, log: log.data, waitConfig };
    }
}

export const flowRunsRepo = new FlowRunsRepo();
