import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqlDatePlugin } from '../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { up } from '../../../../features-system/data-persistence/migrations/2026-09-17-Create_Tickets_Table';
import type { TicketTable } from '../ticketsSchema';

/**
 * Real SQL against a real SQLite database, because the service tests mock the
 * repo entirely and so cannot see any of this.
 *
 * Three things are only true if the database says so, and each was verified by
 * hand once and then pinned by nothing:
 *
 *   - `returningAll()` actually returns the inserted row on this driver;
 *   - `SqlDatePlugin` coerces the five timestamp columns back to `Date`;
 *   - the unique index genuinely rejects a duplicate ticket number, which is
 *     what makes atomic numbering load-bearing rather than decorative.
 *
 * In-memory, so it costs nothing and cannot touch the dev database. Only the
 * sqlite arm runs here; the postgres arm remains hand-reviewed and unexercised,
 * which is recorded honestly rather than claimed as covered.
 */

interface TestDatabase {
    tickets: TicketTable;
}

let db: Kysely<TestDatabase>;

beforeAll(async () => {
    db = new Kysely<TestDatabase>({
        dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
        // Order matters and mirrors `database.ts` deliberately. `SqlDatePlugin`
        // matches camelCase keys, but result rows arrive as `updated_at` until
        // `CamelCasePlugin` has transformed them — so with these reversed, every
        // timestamp silently stays a string. Getting this wrong while writing
        // the test is what proved the test is worth having.
        plugins: [
            new CamelCasePlugin(),
            new SqlDatePlugin<TestDatabase>({
                tickets: ['openedAt', 'claimedAt', 'closedAt', 'deletedAt', 'updatedAt'],
            }),
        ],
    });

    // The migration's own sqlite arm, so a change to it is what this runs
    // against rather than a hand-copied schema that can drift.
    process.env.DB_TYPE = 'sqlite';
    // The migration is typed `Kysely<any>`, as every migration in this repo is —
    // it runs before the schema it creates exists.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await up(db as unknown as Kysely<any>);
});

afterAll(async () => {
    await db.destroy();
});

const baseRow = {
    guildId: 'guild-1',
    type: 'support' as const,
    status: 'open' as const,
    subjectId: 'subject-1',
    openerId: 'opener-1',
    claimerId: null,
    channelId: 'channel-1',
    title: 'Title',
    reason: 'Reason',
    openedAt: '2026-09-17T10:00:00.000Z',
    claimedAt: null,
    closedAt: null,
    deletedAt: null,
    updatedAt: '2026-09-17T10:00:00.000Z',
};

describe('the tickets table, against real SQL', () => {
    it('returns the inserted row and coerces its timestamps back to Date', async () => {
        const inserted = await db
            .insertInto('tickets')
            .values({ ...baseRow, ticketNumber: 1 })
            .returningAll()
            .executeTakeFirst();

        expect(inserted).toBeDefined();
        expect(inserted?.ticketNumber).toBe(1);
        // The claim the date-plugin registration exists to make good on.
        expect(inserted?.openedAt).toBeInstanceOf(Date);
        expect(inserted?.openedAt.toISOString()).toBe('2026-09-17T10:00:00.000Z');
        // A nullable timestamp stays null rather than becoming an epoch Date.
        expect(inserted?.closedAt).toBeNull();
    });

    it('rejects a second ticket with the same number in the same guild', async () => {
        await db
            .insertInto('tickets')
            .values({ ...baseRow, ticketNumber: 2 })
            .execute();

        await expect(
            db
                .insertInto('tickets')
                .values({ ...baseRow, ticketNumber: 2, subjectId: 'subject-2', channelId: 'channel-2' })
                .execute()
        ).rejects.toThrow();
    });

    it('allows the same number in a different guild', async () => {
        await expect(
            db
                .insertInto('tickets')
                .values({ ...baseRow, guildId: 'guild-2', ticketNumber: 2, channelId: 'channel-3' })
                .execute()
        ).resolves.toBeDefined();
    });

    it('defaults updatedAt to a UTC instant, not a local one', async () => {
        const inserted = await db
            .insertInto('tickets')
            .values({
                guildId: 'guild-3',
                ticketNumber: 1,
                type: 'verification',
                status: 'open',
                subjectId: 'subject-3',
                openerId: null,
                claimerId: null,
                channelId: null,
                title: 'Defaulted',
                reason: 'No updatedAt supplied',
                openedAt: '2026-09-17T10:00:00.000Z',
                claimedAt: null,
                closedAt: null,
                deletedAt: null,
            })
            .returningAll()
            .executeTakeFirst();

        // `CURRENT_TIMESTAMP` would give a zoneless, space-separated string that
        // JS reads as local time — off by the host's offset, and invisible on a
        // UTC machine. Asserting closeness to now catches that on any host.
        expect(inserted?.updatedAt).toBeInstanceOf(Date);
        expect(Math.abs(Date.now() - (inserted?.updatedAt.getTime() ?? 0))).toBeLessThan(60_000);
    });

    it('lets only one of two racing claims win', async () => {
        const inserted = await db
            .insertInto('tickets')
            .values({ ...baseRow, guildId: 'guild-race', ticketNumber: 1, channelId: 'channel-race' })
            .returningAll()
            .executeTakeFirstOrThrow();

        // The guard that makes claiming safe lives in the `where` clause, so it
        // is invisible to the mocked service tests — only real SQL can show it.
        const claim = (claimerId: string) =>
            db
                .updateTable('tickets')
                .set({ claimerId, claimedAt: new Date().toISOString() })
                .where('id', '=', inserted.id)
                .where('status', '=', 'open')
                .where('claimerId', 'is', null)
                .returningAll()
                .executeTakeFirst();

        const first = await claim('mod-1');
        const second = await claim('mod-2');

        expect(first).toBeDefined();
        // Zero rows back is the refusal. Without the `claimerId is null` guard
        // this would succeed and silently overwrite the first claimer.
        expect(second).toBeUndefined();

        const settled = await db
            .selectFrom('tickets')
            .selectAll()
            .where('id', '=', inserted.id)
            .executeTakeFirstOrThrow();
        expect(settled.claimerId).toBe('mod-1');
    });

    it('finds an open ticket by subject and type, the query conditions are asked through', async () => {
        const open = await db
            .selectFrom('tickets')
            .selectAll()
            .where('guildId', '=', 'guild-1')
            .where('subjectId', '=', 'subject-1')
            .where('status', '=', 'open')
            .where('type', '=', 'support')
            .execute();

        expect(open.length).toBeGreaterThan(0);
        expect(open.every((row) => row.status === 'open')).toBe(true);
    });
});
