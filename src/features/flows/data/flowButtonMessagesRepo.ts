import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import type { FlowButtonMessageEntity } from './flowButtonMessagesSchema';

export interface PersistFlowButtonMessageInput {
    guildId: string;
    flowId: string;
    channelId: string;
    messageId: string;
    nodeIds: readonly string[];
}

/**
 * Persistence for the messages carrying a flow's trigger buttons.
 *
 * Deliberately thin. The interesting decisions — whether a message may be removed,
 * what to do when it is already gone — belong to the logic layer, which can see the
 * guild; this only reads and writes rows.
 */
export class FlowButtonMessagesRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    async listByFlowId(guildId: string, flowId: string): Promise<FlowButtonMessageEntity[]> {
        return this.db
            .selectFrom('flow_button_messages')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('flowId', '=', flowId)
            .orderBy('createdAt', 'asc')
            .execute();
    }

    /**
     * Save where a flow's buttons were just posted.
     *
     * Insert rather than upsert: posting the same flow's buttons twice in one channel
     * produces two live messages, and keeping only one row would leave the other
     * orphaned — the exact defect this table exists to fix, reintroduced one level
     * down.
     *
     * Named `persist` rather than `record` because the vocabulary gate rejects the
     * latter and this directory is inside it. No meaning was lost; `persist` was
     * already the engine's word for this.
     */
    async persist(input: PersistFlowButtonMessageInput): Promise<FlowButtonMessageEntity> {
        const now = new Date().toISOString();

        /*
         * `returningAll` rather than insert-then-select.
         *
         * The read-back would have to match on `(guildId, messageId)`, which has no
         * unique index — deliberately, since posting the same flow's buttons twice is
         * legitimate. An unordered select could therefore hand back a different row's
         * `id`, and that `id` is what `forget` later deletes by primary key: the record
         * of a *live* message would be dropped while the orphan stayed. Both dialects
         * support `RETURNING`, so the ambiguity never has to arise.
         */
        const saved = await this.db
            .insertInto('flow_button_messages')
            .values({
                guildId: input.guildId,
                flowId: input.flowId,
                channelId: input.channelId,
                messageId: input.messageId,
                nodeIds: JSON.stringify(input.nodeIds),
                createdAt: now,
                updatedAt: now,
            })
            .returningAll()
            .executeTakeFirst();

        if (!saved) {
            throw new Error(
                `Saved the button message ${input.messageId} for flow ${input.flowId}, but the row was not returned.`
            );
        }

        return saved;
    }

    /**
     * Drop one row.
     *
     * Called only once the message is gone from the channel. Removing the row while the
     * message still carries live buttons would leave them unfindable, which is the
     * state this table was added to end.
     */
    async forget(id: number): Promise<boolean> {
        const result = await this.db
            .deleteFrom('flow_button_messages')
            .where('id', '=', id)
            .executeTakeFirst();

        return Number(result.numDeletedRows) > 0;
    }
}

export const flowButtonMessagesRepo = new FlowButtonMessagesRepo();
