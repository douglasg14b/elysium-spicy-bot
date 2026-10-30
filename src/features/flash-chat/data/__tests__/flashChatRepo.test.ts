import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect, sql } from 'kysely';
import type { Database, DatabaseClient } from '../../../../features-system/data-persistence/database';
import { SqlDatePlugin } from '../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { SqliteBindingPlugin } from '../../../../features-system/data-persistence/plugins/sqliteBindingPlugin';
import { FlashChatRepo } from '../flashChatRepo';

describe('FlashChatRepo (sqlite)', () => {
    const sqlite = new SqliteDatabase(':memory:');
    const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: async () => sqlite }),
        plugins: [
            new SqliteBindingPlugin<Database>({
                flash_chat_config: ['enabled', 'removed', 'preserveHistory', 'preservePinned'],
            }),
            new CamelCasePlugin(),
            new SqlDatePlugin<Database>({ flash_chat_config: ['createdAt', 'updatedAt'] }),
        ],
    }) as DatabaseClient;

    const repo = new FlashChatRepo(db);
    const alice = { id: 'user-alice', username: 'alice' };
    const bob = { id: 'user-bob', username: 'bob' };

    beforeAll(async () => {
        await sql`
            CREATE TABLE flash_chat_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                timeout_seconds INTEGER NOT NULL,
                preserve_pinned INTEGER NOT NULL DEFAULT 0,
                preserve_history INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                removed INTEGER NOT NULL DEFAULT 0,
                last_processed_at TEXT,
                created_by TEXT NOT NULL,
                created_by_name TEXT NOT NULL,
                updated_by TEXT NOT NULL,
                updated_by_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                config_version INTEGER NOT NULL DEFAULT 1
            )
        `.execute(db);
    });

    afterAll(async () => {
        await db.destroy();
    });

    it('changes only the settings and who last saved, keeping when and by whom it was set up', async () => {
        await repo.insert('guild-1', 'channel-1', { timeoutSeconds: 60, preservePinned: false, preserveHistory: false }, alice);
        const created = await repo.get('guild-1', 'channel-1');
        expect(created).not.toBeNull();

        await new Promise((resolve) => setTimeout(resolve, 5));
        await repo.updateSettings(
            'guild-1',
            'channel-1',
            { timeoutSeconds: 3600, preservePinned: true, preserveHistory: true },
            bob,
        );
        const updated = await repo.get('guild-1', 'channel-1');

        expect(updated).toEqual(
            expect.objectContaining({
                timeoutSeconds: 3600,
                preservePinned: true,
                preserveHistory: true,
                createdBy: 'user-alice',
                createdByName: 'alice',
                updatedBy: 'user-bob',
                updatedByName: 'bob',
            }),
        );
        // The periodic cleanup deletes above this; an edit must not move it.
        expect(updated?.createdAt).toEqual(created?.createdAt);
        expect(updated?.updatedAt).not.toEqual(created?.updatedAt);
    });

    it("lists one server's channels and none of another's", async () => {
        await repo.insert('guild-2', 'channel-a', { timeoutSeconds: 30, preservePinned: true, preserveHistory: false }, alice);
        await repo.insert('guild-2', 'channel-b', { timeoutSeconds: 90, preservePinned: false, preserveHistory: true }, alice);

        const listed = await repo.listByGuild('guild-2');
        expect(listed.map((config) => config.channelId)).toEqual(['channel-a', 'channel-b']);

        await repo.delete('guild-2', 'channel-a');
        expect((await repo.listByGuild('guild-2')).map((config) => config.channelId)).toEqual(['channel-b']);
        expect(await repo.get('guild-1', 'channel-1')).not.toBeNull();
    });
});
