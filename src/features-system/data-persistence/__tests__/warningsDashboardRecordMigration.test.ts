import { Migrator, sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { database } from '../database';
import { FileMigrationProvider } from '../fileMigrationProvider';
import { migrateTestDatabase } from './support/migrateTestDatabase';

/**
 * `2026-10-29-Warnings_Dashboard_Record` on SQLite, through a real `Migrator` on the
 * production `database` stack, after `resourceBindingMessagePostMigration.test.ts`: up,
 * down and up again, with a warning in the table throughout so both directions are proven
 * to keep it.
 *
 * Postgres is not covered here: CI runs SQLite only. The plan asks for one Postgres run in
 * Docker before merge.
 */

const BEFORE = '2026-10-27-Flow_Posted_Messages';
const RECORD_COLUMNS = [
    'user_name',
    'issuer_name',
    'cleared_by_name',
    'clear_reason',
    'edited_at',
    'edited_by_id',
    'edited_by_name',
];

const migrator = new Migrator({ db: database, provider: new FileMigrationProvider() });

async function migrateOrThrow(run: Promise<{ error?: unknown }>): Promise<void> {
    const { error } = await run;
    if (error) throw error;
}

async function columns(): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`select name from pragma_table_info('warnings')`.execute(database);
    return rows.map((row) => row.name);
}

async function seedWarning(): Promise<void> {
    await sql`
        insert into warnings (guild_id, user_id, issuer_id, slug, rule, description, issued_at, expires_at, created_at)
        values ('guild-1', 'user-1', 'mod-1', 'consent-k7m2', 'Consent', 'Pushed past a no.', '2026-09-01T00:00:00.000Z', '2027-03-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `.execute(database);
}

beforeAll(async () => {
    await migrateTestDatabase();
});

afterEach(async () => {
    await database.deleteFrom('warnings').execute();
    await migrateOrThrow(migrator.migrateToLatest());
});

describe('2026-10-29-Warnings_Dashboard_Record (sqlite, through Migrator)', () => {
    it('adds the seven record columns, null on a warning that was already there', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        expect((await columns()).filter((column) => RECORD_COLUMNS.includes(column))).toEqual([]);
        await seedWarning();

        await migrateOrThrow(migrator.migrateToLatest());

        expect(await columns()).toEqual(expect.arrayContaining(RECORD_COLUMNS));
        expect(
            await database
                .selectFrom('warnings')
                .select([
                    'slug',
                    'userName',
                    'issuerName',
                    'clearedByName',
                    'clearReason',
                    'editedAt',
                    'editedById',
                    'editedByName',
                ])
                .execute()
        ).toEqual([
            {
                slug: 'consent-k7m2',
                userName: null,
                issuerName: null,
                clearedByName: null,
                clearReason: null,
                editedAt: null,
                editedById: null,
                editedByName: null,
            },
        ]);
    });

    it('goes down dropping only those columns, keeping the warning, and back up', async () => {
        await seedWarning();

        await migrateOrThrow(migrator.migrateTo(BEFORE));
        const down = await columns();
        expect(down.filter((column) => RECORD_COLUMNS.includes(column))).toEqual([]);
        expect(down).toEqual(expect.arrayContaining(['slug', 'cleared_at', 'cleared_by_id']));
        const { rows } = await sql<{ slug: string }>`select slug from warnings`.execute(database);
        expect(rows).toEqual([{ slug: 'consent-k7m2' }]);

        await migrateOrThrow(migrator.migrateToLatest());
        expect(await columns()).toEqual(expect.arrayContaining(RECORD_COLUMNS));
    });
});
