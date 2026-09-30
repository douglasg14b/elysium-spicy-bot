import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import { validateFlowGraph } from '../engine/graphValidation';
import type { FlowGraph } from './flowGraph';
import type { FlowDraftEntity } from './flowDraftsSchema';

/** Everything {@link FlowDraftsRepo.upsertMine} writes. */
export interface FlowDraftInput {
    readonly flowId: string;
    readonly guildId: string;
    readonly authorId: string;
    readonly authorName: string;
    readonly name: string;
    readonly graph: FlowGraph;
    /**
     * The flow version this canvas descends from — the flow's `updatedAt` when the
     * operator loaded it, or the base of the draft they loaded instead — as an ISO string.
     *
     * Supplied by the caller rather than read off the flow at write time, because only
     * the page knows what it loaded. The flow's `updatedAt` at the first write is the
     * wrong answer whenever someone else saved between the operator opening the page and
     * their first autosave: the draft would claim to descend from a save it never saw,
     * and the picker would stay quiet about loading it undoing that save.
     */
    readonly baseUpdatedAt: string;
}

/**
 * Persistence for flow drafts — one operator's unsaved canvas per flow.
 *
 * Graphs are checked **structurally** on write and on read, with the same
 * `validateFlowGraph` `FlowsRepo` uses, and nothing more: a draft is where incomplete
 * work lives, so readiness is exactly the question it must not ask.
 *
 * Constructed with a transaction by `FlowsRepo.mutate`, so a save that lands as a draft,
 * or one that supersedes the author's draft, is one commit with the flow row it was
 * judged against. That is why the executor is a constructor argument rather than the
 * singleton: see `mutate` for the sqlite deadlock a singleton query inside a transaction
 * causes.
 */
export class FlowDraftsRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /**
     * Every operator's draft of a flow, most recently edited first — the order the
     * picker lists them in, so the work someone touched a minute ago is not under the
     * one abandoned last week.
     */
    async listByFlowId(flowId: string): Promise<FlowDraftEntity[]> {
        const rows = await this.db
            .selectFrom('flow_drafts')
            .selectAll()
            .where('flowId', '=', flowId)
            .orderBy('updatedAt', 'desc')
            .orderBy('id', 'desc')
            .execute();

        return rows.map((row) => this.assertValidGraph(row));
    }

    /**
     * Write the author's draft of this flow, creating it or replacing its content.
     *
     * An upsert on the `(flowId, authorId)` unique index rather than check-then-insert,
     * so two autosaves from one operator's two tabs cannot both insert. `baseUpdatedAt`
     * is written on the update half too: it describes the content being stored, and an
     * operator who kept the saved version and edited it has replaced their old draft with
     * work descending from a newer flow — keeping the old base would warn "saved since"
     * about a save their canvas already contains.
     *
     * @throws When the graph is structurally broken. Callers check first and answer
     * with a 400; reaching this is a bug, not an operator mistake.
     */
    async upsertMine(input: FlowDraftInput): Promise<FlowDraftEntity> {
        const result = validateFlowGraph(input.graph);
        if (!result.valid) {
            throw new Error(`Cannot save a draft with an invalid graph: ${result.errors.join('; ')}`);
        }

        const now = new Date().toISOString();
        const graph = JSON.stringify(result.graph);

        await this.db
            .insertInto('flow_drafts')
            .values({
                flowId: input.flowId,
                guildId: input.guildId,
                authorId: input.authorId,
                authorName: input.authorName,
                name: input.name,
                graph,
                baseUpdatedAt: input.baseUpdatedAt,
                createdAt: now,
                updatedAt: now,
            })
            .onConflict((conflict) =>
                conflict.columns(['flowId', 'authorId']).doUpdateSet({
                    authorName: input.authorName,
                    name: input.name,
                    graph,
                    baseUpdatedAt: input.baseUpdatedAt,
                    updatedAt: now,
                })
            )
            .execute();

        const saved = await this.db
            .selectFrom('flow_drafts')
            .selectAll()
            .where('flowId', '=', input.flowId)
            .where('authorId', '=', input.authorId)
            .executeTakeFirst();
        if (!saved) {
            throw new Error(`Draft upsert succeeded but no row was found for ${input.flowId}/${input.authorId}.`);
        }

        return this.assertValidGraph(saved);
    }

    /**
     * Discard one draft, whoever wrote it — **scoped to the flow**, so a draft id taken
     * from one flow's URL cannot reach another flow's drafts. True when a row went.
     */
    async deleteById(flowId: string, draftId: number): Promise<boolean> {
        const result = await this.db
            .deleteFrom('flow_drafts')
            .where('flowId', '=', flowId)
            .where('id', '=', draftId)
            .executeTakeFirst();

        return Number(result.numDeletedRows) > 0;
    }

    /** Discard one author's draft of a flow — what a successful save does to the saver's own. */
    async deleteByAuthor(flowId: string, authorId: string): Promise<void> {
        await this.db
            .deleteFrom('flow_drafts')
            .where('flowId', '=', flowId)
            .where('authorId', '=', authorId)
            .execute();
    }

    /** Every draft of a flow, for when the flow itself is deleted. */
    async deleteByFlowId(flowId: string): Promise<void> {
        await this.db.deleteFrom('flow_drafts').where('flowId', '=', flowId).execute();
    }

    /** Re-checked on read for the reason `FlowsRepo` gives: the JSON plugin parses, it does not validate. */
    private assertValidGraph(row: FlowDraftEntity): FlowDraftEntity {
        const result = validateFlowGraph(row.graph);
        if (!result.valid) {
            throw new Error(`Draft ${row.id} of flow ${row.flowId} has an invalid stored graph: ${result.errors.join('; ')}`);
        }
        return { ...row, graph: result.graph };
    }
}

export const flowDraftsRepo = new FlowDraftsRepo();
