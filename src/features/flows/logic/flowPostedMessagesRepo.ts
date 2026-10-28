import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import type { NewFlowPostedMessageEntity } from './flowPostedMessagesSchema';

/**
 * Persistence for `flow_posted_messages` — a block's posted message that carries buttons. See
 * `flowPostedMessagesSchema.ts` for what a row means, and why it lives in `logic/`.
 */
export class FlowPostedMessagesRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /**
     * Record one posted message. A message is posted once, so its id is new: a second write
     * for the same id is a bug, and throws on the primary key rather than being folded in —
     * which `recordPostedMessage`, the one caller, logs with every other failure.
     */
    async create(row: NewFlowPostedMessageEntity): Promise<void> {
        await this.db.insertInto('flow_posted_messages').values(row).execute();
    }
}

export const flowPostedMessagesRepo = new FlowPostedMessagesRepo();
