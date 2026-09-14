import { randomUUID } from 'crypto';
import type { UpdateQueryBuilder, UpdateResult } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../features-system/data-persistence/database';
import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import { BLOCK_KINDS } from '../blocks/manifest';
import type { FlowVariableValue } from '../blocks/types';
import { FLOW_RUN_ENTITY_VERSION, FLOW_RUN_POLL_BATCH_SIZE } from '../constants';
import type { FlowSuspension, NodeRunLog } from '../engine/executor';
import {
    FLOW_RUN_TRANSITIONS,
    IllegalFlowRunTransitionError,
    isLegalRunTransition,
    type FlowRunEvent,
} from './flowRunLifecycle';
import type {
    FlowRunContextSnapshot,
    FlowRunEntity,
    FlowRunUpdateEntity,
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
    /** Values blocks recorded before this run parked. Empty when none did. */
    variables?: Record<string, FlowVariableValue>;
    /** Optional explicit runId; a UUID is generated when omitted. */
    runId?: string;
}

/**
 * The row fields a write may touch. Status is absent on purpose: it moves only
 * through the lifecycle methods below, so no caller can put a run into a state the
 * machine in {@link FLOW_RUN_TRANSITIONS} does not allow.
 */
export interface FlowRunFieldsPatch {
    resumeNodeId?: string | null;
    wakeAt?: Date | null;
    waitKind?: FlowWaitKind | null;
    waitConfig?: FlowRunWaitConfig | null;
    visitsUsed?: number;
    log?: NodeRunLog[];
    variables?: Record<string, FlowVariableValue>;
    error?: string | null;
}

/**
 * Everything a run needs to park again after a resumed segment suspended — which
 * is exactly a {@link FlowSuspension} minus the bookkeeping the executor keeps to
 * itself, so a resumer can hand one straight through instead of restating it.
 */
export type ParkFlowRunInput = Omit<FlowSuspension, 'visitedNodeIds'>;

/** A field patch plus the claim column, which only a transition may write. */
type LifecyclePatch = FlowRunFieldsPatch & { claimedAt?: Date | null };

type FlowRunUpdateQuery = UpdateQueryBuilder<Database, 'flow_runs', 'flow_runs', UpdateResult>;

export interface FindWaitingFilter {
    guildId?: string;
    flowId?: string;
    waitKind?: FlowWaitKind;
}

const nodeRunLogSchema = z.object({
    nodeId: z.string(),
    type: z.string(),
    kind: z.enum(BLOCK_KINDS),
    status: z.enum(['ok', 'error']),
    /**
     * Any declared handle, not just a condition's. A block names whichever of its
     * own handles the run left by — a wait that expires logs `timeout` — and
     * pinning this to the condition vocabulary would reject a log the engine
     * legitimately wrote.
     *
     * Widening needs no migration: every value an older build wrote still parses.
     * It is one-way, though — roll the code back and a log containing `timeout`
     * becomes unreadable, failing the run that carries it.
     */
    branch: z.string().optional(),
    error: z.string().optional(),
});

const contextSnapshotSchema = z.object({
    guildId: z.string().min(1),
    userId: z.string().min(1),
});

/**
 * The stored variable bag: flat, scalar-only, exactly as {@link FlowVariableValue}
 * says. Re-validated on read like every other JSON column, so a hand-edited or
 * half-written row is a named error rather than a block being handed an object
 * where it expected a string.
 */
const variablesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

const waitConfigSchema = z.object({
    eventKind: z.enum(['memberJoin', 'reactionAdd', 'buttonClick']),
    timeoutMs: z.number().int().positive().optional(),
});

const logSchema = z.array(nodeRunLogSchema);

/**
 * Persistence for durable flow runs. A row exists only for a run that has
 * suspended at least once; purely inline runs never touch this table.
 *
 * Every status write goes through {@link FlowRunsRepo.applyTransition}, which takes
 * both its guard and its target from `flowRunLifecycle.ts` — so the predicate on an
 * UPDATE and the status it lands on cannot drift apart, and a resumer claiming a
 * run is a single conditional write rather than a read-then-write race.
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
                // A row is only ever inserted because a run just parked, so its
                // status is not a caller's choice.
                status: 'suspended',
                claimedAt: null,
                resumeNodeId: input.resumeNodeId,
                wakeAt: input.wakeAt ? input.wakeAt.toISOString() : null,
                waitKind: input.waitKind ?? null,
                waitConfig: input.waitConfig ? JSON.stringify(input.waitConfig) : null,
                contextSnapshot: JSON.stringify(input.contextSnapshot),
                visitsUsed: input.visitsUsed ?? 0,
                log: JSON.stringify(input.log ?? []),
                variables: JSON.stringify(input.variables ?? {}),
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

    /** Suspended runs whose `wakeAt` has passed — the poller's work queue. */
    async findDue(now: Date, limit: number = FLOW_RUN_POLL_BATCH_SIZE): Promise<FlowRunEntity[]> {
        const rows = await this.db
            .selectFrom('flow_runs')
            .selectAll()
            .where('status', '=', 'suspended')
            .where('wakeAt', 'is not', null)
            .where('wakeAt', '<=', now)
            .orderBy('wakeAt', 'asc')
            .limit(limit)
            .execute();

        return rows.map((row) => this.assertValidJsonColumns(row));
    }

    /**
     * Suspended runs parked on an event. Used by the dispatchers to find runs a
     * freshly-arrived event should wake; the caller still matches on the run's
     * own `contextSnapshot.userId`.
     */
    async findWaiting(filter: FindWaitingFilter = {}): Promise<FlowRunEntity[]> {
        let query = this.db
            .selectFrom('flow_runs')
            .selectAll()
            .where('status', '=', 'suspended')
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

    /**
     * Claim a suspended run for resumption.
     *
     * The guard lives in the UPDATE rather than in a prior read, so a timeout and a
     * button press arriving together cannot both win. The loser gets `null` and is
     * expected to no-op quietly — losing a race is ordinary, not an error.
     *
     * The returned row is read back immediately after the claim, so the resumer
     * works from what is persisted rather than from whatever it selected a moment
     * earlier.
     */
    async claimForResume(runId: string): Promise<FlowRunEntity | null> {
        return this.tryTransition(runId, 'claim', { claimedAt: new Date() });
    }

    /**
     * Give a claim straight back, leaving the run parked exactly as it was.
     *
     * Used when a resumer fails for a reason that has nothing to do with the run —
     * a database hiccup, say. Without this, a transient fault would strand the run
     * at `running` until the next restart, when before the claim existed the very
     * next poll would simply have retried it.
     *
     * Returns null when the run has already moved on, which is not an error.
     */
    async releaseClaim(runId: string): Promise<FlowRunEntity | null> {
        return this.tryTransition(runId, 'release', { claimedAt: null });
    }

    /**
     * Hand back every outstanding resume claim. Returns how many were reclaimed.
     *
     * **Call this only at process startup.** A run sitting at `running` matches
     * neither parked-run query, so a process killed mid-resume would otherwise
     * strand a live run with no operator surface until the operations view exists.
     *
     * There is deliberately no staleness threshold. At startup no claim in the
     * table can belong to this process, so every one of them was left behind by a
     * process that is gone — and an age filter would be actively harmful, because a
     * crash or a redeploy seconds after a claim is the common case and waiting out a
     * threshold no live claim can trip would only delay recovery.
     *
     * This is sound because the bot runs as a single process (see
     * `src/scripts/dockerEntrypoint.sh`). **If the deployment ever runs more than
     * one instance against one database, or if this sweep is ever put on a timer,
     * it must first become claim-scoped** — taking a claim a live resumer still
     * holds would let two resumers advance one run, which is the exact failure the
     * claim exists to prevent.
     */
    async reclaimAbandonedClaims(): Promise<number> {
        return this.applyTransition('reclaim', { claimedAt: null }, (query) => query);
    }

    /** Park a claimed run again after its resumed segment suspended. */
    async park(runId: string, input: ParkFlowRunInput): Promise<FlowRunEntity> {
        return this.mustTransition(runId, 'park', {
            resumeNodeId: input.resumeNodeId,
            // `?? null` rather than a passthrough: a run re-parking on an event with
            // no timeout must have its old `wakeAt` cleared, not left standing.
            wakeAt: input.wakeAt ?? null,
            waitKind: input.waitKind ?? null,
            waitConfig: input.waitConfig ?? null,
            visitsUsed: input.visitsUsed,
            log: input.log,
            // Rewritten on every park, not merged: the executor carries the whole
            // bag through the segment, so what it hands back is the complete
            // current state. Merging here would resurrect a key a later build
            // deliberately stopped writing.
            variables: input.variables,
            error: null,
            claimedAt: null,
        });
    }

    /** Mark a run finished; clears the wake/wait fields so it is never re-picked. */
    async complete(runId: string, log?: NodeRunLog[]): Promise<FlowRunEntity> {
        return this.mustTransition(runId, 'complete', {
            ...this.clearedResumeFields(),
            error: null,
            ...(log ? { log } : {}),
        });
    }

    async fail(runId: string, error: string, log?: NodeRunLog[]): Promise<FlowRunEntity> {
        return this.mustTransition(runId, 'fail', {
            ...this.clearedResumeFields(),
            error,
            ...(log ? { log } : {}),
        });
    }

    async cancel(runId: string, reason?: string): Promise<FlowRunEntity> {
        return this.mustTransition(runId, 'cancel', {
            ...this.clearedResumeFields(),
            error: reason ?? null,
        });
    }

    /**
     * Apply a lifecycle event to one run, guarded by the statuses the machine
     * allows it from. Returns null when no row matched — either the run is in
     * another status or it does not exist.
     */
    private async tryTransition(
        runId: string,
        event: FlowRunEvent,
        patch: LifecyclePatch
    ): Promise<FlowRunEntity | null> {
        const updated = await this.applyTransition(event, patch, (query) => query.where('runId', '=', runId));
        if (updated === 0) {
            return null;
        }

        const saved = await this.getByRunId(runId);
        if (!saved) {
            throw new Error(`Flow run ${runId} was ${event}ed but the row was not found afterwards`);
        }

        return saved;
    }

    /**
     * Apply a lifecycle event the caller has already established is legal — a
     * resumer completing the run it claimed, for instance. A miss is a real fault,
     * so it raises naming the run and the statuses involved rather than silently
     * leaving the run where it was.
     */
    private async mustTransition(
        runId: string,
        event: FlowRunEvent,
        patch: LifecyclePatch
    ): Promise<FlowRunEntity> {
        const saved = await this.tryTransition(runId, event, patch);
        if (saved) {
            return saved;
        }

        const current = await this.getByRunId(runId);
        if (!current) {
            throw new Error(`Flow run ${runId} does not exist, so it cannot ${event}`);
        }
        if (!isLegalRunTransition(current.status, event)) {
            throw new IllegalFlowRunTransitionError(current.status, event);
        }

        throw new Error(`Flow run ${runId} could not ${event}: the row changed underneath the write`);
    }

    /**
     * The one place a status is written. `narrow` picks which rows the event applies
     * to; the guard and the target status both come from the machine. Returns how
     * many rows moved.
     */
    private async applyTransition(
        event: FlowRunEvent,
        patch: LifecyclePatch,
        narrow: (query: FlowRunUpdateQuery) => FlowRunUpdateQuery
    ): Promise<number> {
        const { from, to } = FLOW_RUN_TRANSITIONS[event];

        const result = await narrow(this.db.updateTable('flow_runs').set(this.buildPatch(patch, to)))
            .where('status', 'in', from)
            .executeTakeFirst();

        return Number(result?.numUpdatedRows ?? 0);
    }

    /** The fields a terminal transition must clear so a run is never re-picked. */
    private clearedResumeFields(): LifecyclePatch {
        return {
            resumeNodeId: null,
            wakeAt: null,
            waitKind: null,
            waitConfig: null,
            claimedAt: null,
        };
    }

    /**
     * Serialise a patch into typed column values, always bumping `updatedAt`.
     *
     * `status` is a required parameter rather than an optional field so a
     * transition cannot forget it, and the return type is Kysely's own updateable
     * row so a mistyped column name is a compile error instead of a silently
     * stranded run.
     */
    private buildPatch(patch: LifecyclePatch, status: FlowRunUpdateEntity['status']): FlowRunUpdateEntity {
        const columns: FlowRunUpdateEntity = { status, updatedAt: new Date().toISOString() };

        if (patch.resumeNodeId !== undefined) {
            columns.resumeNodeId = patch.resumeNodeId;
        }
        if (patch.wakeAt !== undefined) {
            columns.wakeAt = patch.wakeAt ? patch.wakeAt.toISOString() : null;
        }
        if (patch.claimedAt !== undefined) {
            columns.claimedAt = patch.claimedAt ? patch.claimedAt.toISOString() : null;
        }
        if (patch.waitKind !== undefined) {
            columns.waitKind = patch.waitKind;
        }
        if (patch.waitConfig !== undefined) {
            columns.waitConfig = patch.waitConfig ? JSON.stringify(patch.waitConfig) : null;
        }
        if (patch.visitsUsed !== undefined) {
            columns.visitsUsed = patch.visitsUsed;
        }
        if (patch.log !== undefined) {
            columns.log = JSON.stringify(patch.log);
        }
        if (patch.variables !== undefined) {
            columns.variables = JSON.stringify(patch.variables);
        }
        if (patch.error !== undefined) {
            columns.error = patch.error;
        }

        return columns;
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

        // No `?? {}` fallback: the column is NOT NULL with a `{}` default, and the
        // migration backfills every pre-existing row in both dialects, so a null
        // here is a corrupt row rather than an old one. Defaulting it would hide
        // that behind a run that quietly behaves as though it recorded nothing.
        const variables = variablesSchema.safeParse(row.variables);
        if (!variables.success) {
            throw new Error(
                `Flow run ${row.runId} has invalid stored variables: ${variables.error.issues
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

        return { ...row, contextSnapshot: snapshot.data, log: log.data, waitConfig, variables: variables.data };
    }
}

export const flowRunsRepo = new FlowRunsRepo();
