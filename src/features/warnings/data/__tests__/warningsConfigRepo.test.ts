import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect, sql } from 'kysely';
import type { Database, DatabaseClient } from '../../../../features-system/data-persistence/database';
import { SqlDatePlugin } from '../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { SqliteBindingPlugin } from '../../../../features-system/data-persistence/plugins/sqliteBindingPlugin';
import { WARNINGS_CONFIG_VERSION } from '../../constants';
import { WarningsConfigRepo } from '../warningsConfigRepo';

describe('WarningsConfigRepo (sqlite)', () => {
    const sqlite = new SqliteDatabase(':memory:');
    const db = new Kysely<Database>({
        dialect: new SqliteDialect({
            database: async () => sqlite,
        }),
        plugins: [
            new SqliteBindingPlugin<Database>({}),
            new CamelCasePlugin(),
            new SqlDatePlugin<Database>({
                warnings_config: ['createdAt', 'updatedAt'],
            }),
        ],
    }) as DatabaseClient;

    const repo = new WarningsConfigRepo(db);

    beforeAll(async () => {
        await sql`
            CREATE TABLE warnings_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                mod_channel_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                config_version INTEGER NOT NULL
            )
        `.execute(db);
        await sql`CREATE UNIQUE INDEX warnings_config_guild_unique_idx ON warnings_config (guild_id)`.execute(db);
    });

    afterAll(async () => {
        await db.destroy();
    });

    it('upserts one mod channel per guild', async () => {
        const created = await repo.upsertModChannel('guild-1', 'channel-first');
        expect(created.guildId).toBe('guild-1');
        expect(created.modChannelId).toBe('channel-first');
        expect(created.configVersion).toBe(WARNINGS_CONFIG_VERSION);

        const updated = await repo.upsertModChannel('guild-1', 'channel-second');
        expect(updated.modChannelId).toBe('channel-second');
        expect(await repo.getByGuildId('guild-1')).toEqual(
            expect.objectContaining({
                guildId: 'guild-1',
                modChannelId: 'channel-second',
            })
        );
        expect(await repo.getByGuildId('guild-2')).toBeNull();
    });
});
