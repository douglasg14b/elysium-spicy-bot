import { Migrator, sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { database } from '../database';
import { FileMigrationProvider } from '../fileMigrationProvider';
import { migrateTestDatabase } from './support/migrateTestDatabase';

/**
 * `2026-10-25-Resource_Binding_Message_Post` on SQLite, through a real `Migrator` on the
 * production `database` stack, after the pattern of `postEmbedMessageShapeMigration.test.ts`:
 * up, down and up again, with a row in the table throughout so the down and the second up
 * are proven to keep every binding.
 *
 * Postgres is not covered here: CI runs SQLite only. When this migration was written it was
 * run by hand against a throwaway `postgres:16` — up, down and up, with the repo writes
 * that touch the two columns in between.
 */

const BEFORE = '2026-10-24-Post_Embed_Message_Shape';
const MESSAGE_COLUMNS = ['message_channel_id', 'message_digest'];

const migrator = new Migrator({ db: database, provider: new FileMigrationProvider() });

async function migrateOrThrow(run: Promise<{ error?: unknown }>): Promise<void> {
    const { error } = await run;
    if (error) throw error;
}

async function columns(): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`select name from pragma_table_info('resource_bindings')`.execute(database);
    return rows.map((row) => row.name);
}

async function seedChannelRow(): Promise<void> {
    await sql`
        insert into resource_bindings (guild_id, owner_kind, owner_key, resource_key, kind, state, discord_id, name, created_at, updated_at)
        values ('guild-1', 'journey', 'house', 'rules', 'textChannel', 'created', '1100000000000000001', 'rules', ${new Date().toISOString()}, ${new Date().toISOString()})
    `.execute(database);
}

beforeAll(async () => {
    await migrateTestDatabase();
});

afterEach(async () => {
    await database.deleteFrom('resource_bindings').execute();
    await migrateOrThrow(migrator.migrateToLatest());
});

describe('2026-10-25-Resource_Binding_Message_Post (sqlite, through Migrator)', () => {
    it('adds the two message columns, null on a row that was already there', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        expect(await columns()).not.toEqual(expect.arrayContaining([MESSAGE_COLUMNS[0]]));
        await seedChannelRow();

        await migrateOrThrow(migrator.migrateToLatest());

        expect(await columns()).toEqual(expect.arrayContaining(MESSAGE_COLUMNS));
        expect(await database.selectFrom('resource_bindings').select(['resourceKey', 'messageChannelId', 'messageDigest']).execute()).toEqual([
            { resourceKey: 'rules', messageChannelId: null, messageDigest: null },
        ]);
    });

    it('goes down dropping only those columns, keeping the row, and back up', async () => {
        await seedChannelRow();

        await migrateOrThrow(migrator.migrateTo(BEFORE));
        const down = await columns();
        expect(down.filter((column) => MESSAGE_COLUMNS.includes(column))).toEqual([]);
        expect(down).toEqual(expect.arrayContaining(['discord_id', 'name', 'state']));
        // `CamelCasePlugin` maps a raw query's result keys too.
        const { rows } = await sql<{ resourceKey: string }>`select resource_key from resource_bindings`.execute(database);
        expect(rows).toEqual([{ resourceKey: 'rules' }]);

        await migrateOrThrow(migrator.migrateToLatest());
        expect(await columns()).toEqual(expect.arrayContaining(MESSAGE_COLUMNS));
    });
});
