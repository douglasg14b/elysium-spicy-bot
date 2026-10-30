import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../database';
import { SqliteBindingPlugin } from '../plugins/sqliteBindingPlugin';

/**
 * Booleans read back on sqlite, with the plugins in the order `database.ts` lists them: this
 * one before `CamelCasePlugin`, so it meets each row under its database names. A column of
 * one word was read back as a boolean either way; one of several came back 0/1 until the
 * plugin matched its snake_case name too.
 */
describe('SqliteBindingPlugin', () => {
    const sqlite = new SqliteDatabase(':memory:');
    const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: async () => sqlite }),
        plugins: [
            new SqliteBindingPlugin<Database>({ leveling_config: ['enabled', 'reactionXpEnabled'] }),
            new CamelCasePlugin(),
        ],
    });

    beforeAll(async () => {
        await sql`CREATE TABLE leveling_config (guild_id TEXT, enabled INTEGER, reaction_xp_enabled INTEGER)`.execute(db);
        await sql`INSERT INTO leveling_config VALUES ('guild-1', 1, 0)`.execute(db);
    });

    afterAll(async () => {
        await db.destroy();
    });

    it('reads one-word and multi-word boolean columns back as booleans', async () => {
        const row = await db
            .selectFrom('leveling_config')
            .select(['guildId', 'enabled', 'reactionXpEnabled'])
            .executeTakeFirstOrThrow();

        expect(row).toEqual({ guildId: 'guild-1', enabled: true, reactionXpEnabled: false });
    });
});
