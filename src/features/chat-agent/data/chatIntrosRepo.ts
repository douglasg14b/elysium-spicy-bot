import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import type { IntroPost } from './chatIntrosSchema';

/** How many ids one delete names, so a whole channel's worth stays under SQLite's bound-parameter cap. */
const DELETE_CHUNK = 500;

/** Persistence for the chat agent's copy of each server's intros channel. SQL lives here and nowhere else. */
export class ChatIntrosRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /** Write each post, replacing the text of one already held (an edit). */
    async savePosts(posts: readonly IntroPost[]): Promise<void> {
        if (posts.length === 0) return;
        await this.db
            .insertInto('chat_agent_intros')
            .values(posts.map((post) => ({ ...post, postedAt: post.postedAt.toISOString() })))
            .onConflict((conflict) => conflict.column('messageId').doUpdateSet((update) => ({ content: update.ref('excluded.content') })))
            .execute();
    }

    /** Drop these posts from `guildId`'s copy; ids it does not hold are ignored. */
    async deletePosts(guildId: string, messageIds: readonly string[]): Promise<void> {
        for (let start = 0; start < messageIds.length; start += DELETE_CHUNK) {
            await this.db
                .deleteFrom('chat_agent_intros')
                .where('guildId', '=', guildId)
                .where('messageId', 'in', messageIds.slice(start, start + DELETE_CHUNK))
                .execute();
        }
    }

    /** Drop every post `guildId` holds from any channel but `channelId` — all of them when it is null. */
    async deleteOutsideChannel(guildId: string, channelId: string | null): Promise<void> {
        let query = this.db.deleteFrom('chat_agent_intros').where('guildId', '=', guildId);
        if (channelId) query = query.where('channelId', '!=', channelId);
        await query.execute();
    }

    /** The ids of every post held from `channelId`. */
    async listMessageIds(guildId: string, channelId: string): Promise<string[]> {
        const rows = await this.db
            .selectFrom('chat_agent_intros')
            .select('messageId')
            .where('guildId', '=', guildId)
            .where('channelId', '=', channelId)
            .execute();
        return rows.map((row) => row.messageId);
    }

    /** `authorId`'s newest `limit` posts in `channelId`, newest first. */
    async findByAuthor(guildId: string, channelId: string, authorId: string, limit: number): Promise<IntroPost[]> {
        return this.db
            .selectFrom('chat_agent_intros')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('channelId', '=', channelId)
            .where('authorId', '=', authorId)
            .orderBy('postedAt', 'desc')
            .limit(limit)
            .execute();
    }
}

export const chatIntrosRepo = new ChatIntrosRepo();
