import SqliteDatabase from 'better-sqlite3';
import { Kysely, Migrator, SqliteDialect, sql, type MigrationProvider } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_TYPE } from '../../../environment';
import * as createLevelingTables from '../migrations/2026-05-26-Create_Leveling_Tables';
import * as addLevelingVoiceXp from '../migrations/2026-08-17-Add_Leveling_Voice_Xp';
import * as createActivityEvents from '../migrations/2026-10-01-Create_Activity_Events';

/**
 * The ledger split, through a real `Migrator`.
 *
 * Not by calling `up` directly, as `settleFlowRunLifecycle.test.ts` does: the migrator
 * hands a migration a *connection-bound* instance and, on SQLite, no transaction of its
 * own. The sqlite arm opens one itself, and whether that works on the bound instance is
 * only answered by running it the way `pnpm migrate:latest` does.
 */

const BEFORE_SPLIT = '2026-08-17-Add_Leveling_Voice_Xp';

const provider: MigrationProvider = {
    getMigrations: async () => ({
        '2026-05-26-Create_Leveling_Tables': createLevelingTables,
        [BEFORE_SPLIT]: addLevelingVoiceXp,
        '2026-10-01-Create_Activity_Events': createActivityEvents,
    }),
};

/*
 * Voice and flow take the LOW ids on purpose. If the copy stopped preserving ids, the
 * message and reaction events would be renumbered 1 and 2 and the link assertions below
 * would fail; with message = 1 a renumbering would be invisible.
 */
const SEEDED = [
    { id: 1, activityType: 'voice', occurredAt: '2026-09-01T10:00:00.000Z' },
    { id: 2, activityType: 'flow', occurredAt: '2026-09-01T11:00:00.000Z' },
    { id: 3, activityType: 'message', occurredAt: '2026-09-01T12:00:00.000Z' },
    { id: 4, activityType: 'reaction', occurredAt: '2026-09-01T13:00:00.000Z' },
] as const;

let db: Kysely<any>;
let migrator: Migrator;

async function tableNames(): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `.execute(db);
    return rows.map((row) => row.name);
}

async function columnNames(table: string): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
    return rows.map((row) => row.name);
}

async function migrateOrThrow(run: Promise<{ error?: unknown }>): Promise<void> {
    const { error } = await run;
    if (error) throw error;
}

describe('2026-10-01-Create_Activity_Events (sqlite, through Migrator)', () => {
    beforeEach(async () => {
        if (DB_TYPE !== 'sqlite') {
            throw new Error(`This suite runs the sqlite arm, but DB_TYPE is "${DB_TYPE}".`);
        }

        db = new Kysely<any>({ dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }) });
        migrator = new Migrator({ db, provider });

        await migrateOrThrow(migrator.migrateTo(BEFORE_SPLIT));

        for (const row of SEEDED) {
            await sql`
                INSERT INTO leveling_activity_events (id, guild_id, user_id, activity_type, xp_amount, occurred_at)
                VALUES (${row.id}, 'guild-1', 'user-1', ${row.activityType}, 10, ${row.occurredAt})
            `.execute(db);
        }
    });

    afterEach(async () => {
        await db.destroy();
    });

    it('copies message and reaction grants into activity_events under the same ids, with no channel', async () => {
        await migrateOrThrow(migrator.migrateToLatest());

        const { rows } = await sql<{
            id: number;
            guild_id: string;
            user_id: string;
            channel_id: string | null;
            kind: string;
            occurred_at: string;
        }>`SELECT * FROM activity_events ORDER BY id`.execute(db);

        expect(rows).toEqual([
            {
                id: 3,
                guild_id: 'guild-1',
                user_id: 'user-1',
                channel_id: null,
                kind: 'message',
                occurred_at: '2026-09-01T12:00:00.000Z',
            },
            {
                id: 4,
                guild_id: 'guild-1',
                user_id: 'user-1',
                channel_id: null,
                kind: 'reaction',
                occurred_at: '2026-09-01T13:00:00.000Z',
            },
        ]);
    });

    it('links only the message and reaction grants, each to its own activity event', async () => {
        await migrateOrThrow(migrator.migrateToLatest());

        // Joined, not just read: a link value that matches the grant's own id is only right
        // if the activity event under that id is this grant's event.
        const { rows } = await sql<{
            id: number;
            activity_type: string;
            activity_event_id: number | null;
            linked_kind: string | null;
            linked_occurred_at: string | null;
        }>`
            SELECT xp.id, xp.activity_type, xp.activity_event_id,
                   activity.kind AS linked_kind, activity.occurred_at AS linked_occurred_at
            FROM leveling_xp_grants AS xp
            LEFT JOIN activity_events AS activity ON activity.id = xp.activity_event_id
            ORDER BY xp.id
        `.execute(db);

        expect(rows).toEqual([
            { id: 1, activity_type: 'voice', activity_event_id: null, linked_kind: null, linked_occurred_at: null },
            { id: 2, activity_type: 'flow', activity_event_id: null, linked_kind: null, linked_occurred_at: null },
            {
                id: 3,
                activity_type: 'message',
                activity_event_id: 3,
                linked_kind: 'message',
                linked_occurred_at: '2026-09-01T12:00:00.000Z',
            },
            {
                id: 4,
                activity_type: 'reaction',
                activity_event_id: 4,
                linked_kind: 'reaction',
                linked_occurred_at: '2026-09-01T13:00:00.000Z',
            },
        ]);
        expect(await tableNames()).not.toContain('leveling_activity_events');
    });

    it('hands the next live activity event an id past every copied one', async () => {
        await migrateOrThrow(migrator.migrateToLatest());

        const { rows } = await sql<{ id: number }>`
            INSERT INTO activity_events (guild_id, user_id, channel_id, kind, occurred_at)
            VALUES ('guild-1', 'user-2', 'channel-1', 'message', '2026-10-01T00:00:00.000Z')
            RETURNING id
        `.execute(db);

        expect(rows[0]?.id).toBe(5);
    });

    it('reverses to the original ledger, rows and columns intact', async () => {
        const originalColumns = await columnNames('leveling_activity_events');
        await migrateOrThrow(migrator.migrateToLatest());

        await migrateOrThrow(migrator.migrateDown());

        const tables = await tableNames();
        expect(tables).toContain('leveling_activity_events');
        expect(tables).not.toContain('leveling_xp_grants');
        expect(tables).not.toContain('activity_events');
        expect(await columnNames('leveling_activity_events')).toEqual(originalColumns);

        const { rows } = await sql<{ id: number; activity_type: string }>`
            SELECT id, activity_type FROM leveling_activity_events ORDER BY id
        `.execute(db);
        expect(rows).toEqual(SEEDED.map(({ id, activityType }) => ({ id, activity_type: activityType })));
    });

    it('leaves the database untouched when a step fails part-way', async () => {
        // A table already holding the name makes step 3 fail after the rename and the
        // new column have both run. Without the sqlite arm's own transaction those two
        // would stay applied and the ledger would be left half-renamed.
        await sql`CREATE TABLE activity_events (id integer primary key)`.execute(db);

        const { error, results } = await migrator.migrateToLatest();

        expect(error).toBeDefined();
        expect(results?.find((result) => result.migrationName === '2026-10-01-Create_Activity_Events')?.status).toBe(
            'Error'
        );
        const tables = await tableNames();
        expect(tables).toContain('leveling_activity_events');
        expect(tables).not.toContain('leveling_xp_grants');
        expect(await columnNames('leveling_activity_events')).not.toContain('activity_event_id');
    });
});
