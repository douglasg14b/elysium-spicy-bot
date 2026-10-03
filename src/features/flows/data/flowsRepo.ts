import { randomUUID } from 'crypto';
import type { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';
import {
    database,
    type Database,
    type DatabaseClient,
} from '../../../features-system/data-persistence/database';
import { FLOW_ENTITY_VERSION } from '../constants';
import { validateFlowGraph } from '../engine/graphValidation';
import { FlowDraftsRepo, type FlowDraftInput } from './flowDraftsRepo';
import type { FlowDraftEntity } from './flowDraftsSchema';
import type { FlowGraph } from './flowGraph';
import type { FlowEntity } from './flowsSchema';

/**
 * An author's canvas, to be kept as their draft rather than written to the flow. Which
 * flow and guild the draft belongs to, `mutate` fills in from the row it read.
 */
export type FlowDraftWrite = Pick<FlowDraftInput, 'authorId' | 'authorName' | 'name' | 'graph' | 'baseUpdatedAt'>;

/**
 * What {@link FlowsRepo.mutate}'s caller decided, having seen the current row.
 *
 *  - `write` — patch the flow row. `discardDraftOf` names the author whose draft the
 *    write supersedes: a graph saved to the flow is the draft's work landing, so the
 *    draft goes in the same commit. Absent for a write that is not a graph save — a
 *    rename or a switch-off from the list is not the author's canvas arriving, and must
 *    not throw away a draft they are still working on.
 *  - `draft` — leave the flow row alone and keep the graph as the author's draft.
 *  - `refuse` — write nothing, and hand the refusal back.
 */
export type FlowWriteDecision<TRefusal> =
    | { readonly kind: 'write'; readonly input: UpdateFlowInput; readonly discardDraftOf?: string }
    | { readonly kind: 'draft'; readonly draft: FlowDraftWrite }
    | { readonly kind: 'refuse'; readonly refusal: TRefusal };

/**
 * What {@link FlowsRepo.mutate} did: wrote the row, kept a draft beside it, passed on a
 * refusal, or found no row. `drafted` carries the flow **as it still is** — the live row
 * the draft was kept beside, untouched.
 */
export type FlowWriteOutcome<TRefusal> =
    | { readonly kind: 'written'; readonly flow: FlowEntity }
    | { readonly kind: 'drafted'; readonly flow: FlowEntity; readonly draft: FlowDraftEntity }
    | { readonly kind: 'refused'; readonly refusal: TRefusal }
    | { readonly kind: 'missing' };

export interface CreateFlowInput {
    guildId: string;
    name: string;
    graph: FlowGraph;
    enabled?: boolean;
    /** Optional explicit flowId; a UUID is generated when omitted. */
    flowId?: string;
}

export interface UpdateFlowInput {
    name?: string;
    enabled?: boolean;
    graph?: FlowGraph;
}

/**
 * Told after any write to a flow row has committed — a create, an update, a write
 * through `mutate`, or a delete. Takes nothing: whoever holds something derived from
 * flows drops it and reads again, which is simpler than reasoning about which write
 * touched what.
 */
export type AfterFlowWrite = () => void;

/**
 * Persistence for flows. The graph is validated (shape + structure) on every write
 * and read so a malformed graph never reaches the executor.
 *
 * **Structure only, on write as well as read.** A graph that is sound but *incomplete*
 * — a node still missing config, an authoring rule still broken — is storable, because
 * refusing it here is how an operator lost an afternoon's canvas to one empty field.
 * Whether an incomplete graph may be *live* is a separate question, answered by
 * `flowReadinessIssues` in `logic/flowReadiness.ts` wherever a flow is switched on or
 * deployed. It is not asked here because it needs the flow's declared resources, and a
 * repo reaching for provisioning would invert the dependency between the two.
 */
export class FlowsRepo {
    private readonly afterWrites: AfterFlowWrite[] = [];

    constructor(private readonly db: DatabaseClient = database) {}

    /**
     * Be told after every committed write to a flow row.
     *
     * For the engine's in-memory index of Message Sent triggers, registered from
     * `initFlows` so `data/` never imports `engine/` — the `registerResourceWriteBack`
     * shape. Each is called **after** the write commits, never inside a transaction, so
     * a reload it starts reads what was written; one that throws is logged and the rest
     * still run. A `mutate` that kept a draft, refused or found no row wrote nothing to
     * a flow, so it tells no one.
     *
     * Only this process's writes: `seedOnboardingFlow` runs in a process of its own, so
     * the running bot sees what it wrote only after a restart.
     */
    registerAfterWrite(afterWrite: AfterFlowWrite): void {
        this.afterWrites.push(afterWrite);
    }

    async getByGuildId(guildId: string): Promise<FlowEntity[]> {
        const rows = await this.db
            .selectFrom('flows')
            .selectAll()
            .where('guildId', '=', guildId)
            .orderBy('createdAt', 'asc')
            .execute();

        return rows.map((row) => this.assertValidGraph(row));
    }

    async getByFlowId(flowId: string): Promise<FlowEntity | null> {
        const row = await this.db
            .selectFrom('flows')
            .selectAll()
            .where('flowId', '=', flowId)
            .executeTakeFirst();

        return row ? this.assertValidGraph(row) : null;
    }

    async create(input: CreateFlowInput): Promise<FlowEntity> {
        const result = validateFlowGraph(input.graph);
        if (!result.valid) {
            throw new Error(`Cannot create flow with invalid graph: ${result.errors.join('; ')}`);
        }

        const flowId = input.flowId ?? randomUUID();
        const now = new Date().toISOString();

        await this.db
            .insertInto('flows')
            .values({
                flowId,
                guildId: input.guildId,
                name: input.name,
                enabled: input.enabled ?? false,
                graph: JSON.stringify(result.graph),
                entityVersion: FLOW_ENTITY_VERSION,
                createdAt: now,
                updatedAt: now,
            })
            .execute();
        this.tellAfterWrites();

        const saved = await this.getByFlowId(flowId);
        if (!saved) {
            throw new Error(`Flow create succeeded but row was not found for flowId ${flowId}`);
        }

        return saved;
    }

    async update(flowId: string, input: UpdateFlowInput): Promise<FlowEntity> {
        await this.writeUpdate(this.db, flowId, input);
        this.tellAfterWrites();

        const saved = await this.getByFlowId(flowId);
        if (!saved) {
            throw new Error(`Flow update succeeded but row was not found for flowId ${flowId}`);
        }

        return saved;
    }

    /**
     * Read a flow, decide what to write from the row **as it is now**, and write it —
     * in one transaction.
     *
     * **Why this exists rather than `getByFlowId` then `update`.** Whether a write is
     * allowed can depend on the row it lands on: an incomplete graph may be stored on a
     * flow that is off but not on one that is live, and a flow may be switched on only
     * if its stored graph is ready. Checked against a copy read earlier, two requests
     * pass each other — one saves an incomplete graph because the flow was off, the
     * other switches it on because the graph was ready — and the row ends up live and
     * incomplete, which is the one state the readiness rules exist to prevent.
     *
     * **`check` is synchronous, and that is load-bearing, not a style choice.** Kysely's
     * `SqliteDialect` has a single connection behind a mutex, which this transaction
     * holds; a query on any singleton repo from inside it waits for a mutex that cannot
     * be released until it returns — a deadlock that poisons the only connection in the
     * process (see `ticketingRepo.mutateConfig`). Anything `check` needs from elsewhere
     * — a flow's declared resources, say — is read by the caller beforehand and closed
     * over; only the flow row itself has to be current.
     *
     * **Drafts are written here, on the transaction, for the same reason.** Whether a
     * save lands on the flow or on the author's draft is decided against this row, so
     * the draft must be written in the same commit; and a save that lands on the flow
     * deletes the author's draft, which must commit with it or a crash between them
     * leaves a stale draft offering to undo the save. `FlowDraftsRepo` is built on the
     * transaction rather than used as its singleton, which is the deadlock.
     *
     * The row lock is **postgres-only**, for the reason `mutateConfig` gives: READ
     * COMMITTED does not stop a read-then-write losing an update, so the row is locked
     * explicitly there, while sqlite rejects `FOR UPDATE` outright and needs no lock —
     * its one connection already serialises every transaction.
     *
     * @param check - Given the row as it stands inside the transaction, what to write —
     * or the refusal to hand back unwritten.
     */
    async mutate<TRefusal>(
        flowId: string,
        check: (current: FlowEntity) => FlowWriteDecision<TRefusal>
    ): Promise<FlowWriteOutcome<TRefusal>> {
        const outcome = await this.db.transaction().execute(async (transaction): Promise<FlowWriteOutcome<TRefusal>> => {
            let query = transaction.selectFrom('flows').selectAll().where('flowId', '=', flowId);
            if (DB_TYPE === 'postgres') {
                query = query.forUpdate();
            }

            const row = await query.executeTakeFirst();
            if (!row) {
                return { kind: 'missing' };
            }

            const current = this.assertValidGraph(row);
            const decision = check(current);
            const drafts = new FlowDraftsRepo(transaction);

            switch (decision.kind) {
                case 'refuse':
                    return { kind: 'refused', refusal: decision.refusal };
                case 'draft': {
                    const draft = await drafts.upsertMine({ ...decision.draft, flowId, guildId: current.guildId });
                    return { kind: 'drafted', flow: current, draft };
                }
                case 'write':
                    break;
            }

            await this.writeUpdate(transaction, flowId, decision.input);
            if (decision.discardDraftOf) {
                await drafts.deleteByAuthor(flowId, decision.discardDraftOf);
            }

            const saved = await transaction
                .selectFrom('flows')
                .selectAll()
                .where('flowId', '=', flowId)
                .executeTakeFirst();
            if (!saved) {
                throw new Error(`Flow update succeeded but row was not found for flowId ${flowId}`);
            }

            return { kind: 'written', flow: this.assertValidGraph(saved) };
        });

        // Outside the transaction, so it has committed: a reload started now reads it.
        if (outcome.kind === 'written') {
            this.tellAfterWrites();
        }
        return outcome;
    }

    async setEnabled(flowId: string, enabled: boolean): Promise<FlowEntity> {
        return this.update(flowId, { enabled });
    }

    /**
     * Hard-delete a flow and its drafts, and nothing else.
     *
     * The drafts go with it because they are the flow's own unsaved work, in this
     * database and nowhere else: a draft of a flow that no longer exists can never be
     * loaded, listed or saved, so keeping it would only be keeping litter. That is a
     * different category from what follows, which is about the guild.
     *
     * Deployed buttons **do** outlive their flow — the message stays in the channel —
     * and the dispatcher answers a click on one with "This flow no longer exists."
     * rather than no-opping. That is a decent dead end but it is not cleanup, so
     * `flow_button_messages` rows are deliberately left behind: they are the only
     * record of where those live buttons are, and dropping them here would make the
     * buttons unretirable forever.
     *
     * Retiring them is `undeployFlowButtons`, offered beside this rather than folded
     * into it — deleting a record must not silently destroy part of a live server.
     */
    async deleteByFlowId(flowId: string): Promise<void> {
        // One transaction, so a failure cannot leave the flow gone and its drafts behind.
        await this.db.transaction().execute(async (transaction) => {
            await new FlowDraftsRepo(transaction).deleteByFlowId(flowId);
            await transaction.deleteFrom('flows').where('flowId', '=', flowId).execute();
        });
        this.tellAfterWrites();
    }

    /** Tell every {@link registerAfterWrite} caller that a write has committed. */
    private tellAfterWrites(): void {
        for (const afterWrite of this.afterWrites) {
            try {
                afterWrite();
            } catch (error) {
                console.error('[flows] A follow-up to a flow write failed:', error);
            }
        }
    }

    /**
     * The one place an update's columns are built, so `update` and `mutate` cannot
     * disagree about what a patch writes. `executor` is the transaction when there is
     * one — never the singleton alongside it, for the deadlock `mutate` describes.
     */
    private async writeUpdate(
        executor: Kysely<Database>,
        flowId: string,
        input: UpdateFlowInput
    ): Promise<void> {
        const updateData: Record<string, unknown> = { updatedAt: new Date().toISOString() };

        if (input.name !== undefined) {
            updateData.name = input.name;
        }
        if (input.enabled !== undefined) {
            updateData.enabled = input.enabled;
        }
        if (input.graph !== undefined) {
            const result = validateFlowGraph(input.graph);
            if (!result.valid) {
                throw new Error(`Cannot update flow with invalid graph: ${result.errors.join('; ')}`);
            }
            updateData.graph = JSON.stringify(result.graph);
        }

        await executor.updateTable('flows').set(updateData).where('flowId', '=', flowId).execute();
    }

    /**
     * The SqliteJsonPlugin parses the `graph` column back into an object, but a
     * corrupt row could still slip through. Re-validate defensively.
     */
    private assertValidGraph(row: FlowEntity): FlowEntity {
        const result = validateFlowGraph(row.graph);
        if (!result.valid) {
            throw new Error(
                `Flow ${row.flowId} has an invalid stored graph: ${result.errors.join('; ')}`
            );
        }
        return { ...row, graph: result.graph };
    }
}

export const flowsRepo = new FlowsRepo();
