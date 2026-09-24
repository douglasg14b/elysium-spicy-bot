import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SqlDatePlugin } from '../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { up as createTickets } from '../../../../features-system/data-persistence/migrations/2026-09-17-Create_Tickets_Table';
import { up as addIdentityAndTypes } from '../../../../features-system/data-persistence/migrations/2026-09-23-Add_Ticket_Identity_And_Types';
import { up as createTicketingConfig } from '../../../../features-system/data-persistence/migrations/2025-11-10-Create_Ticketing_Config';
import type { TicketTable } from '../ticketsSchema';

/**
 * `searchByGuild` and `countsByGuild` against real SQLite, on the migrations' own tables.
 *
 * Both build SQL that no unit test can see the shape of, and both have a failure mode that
 * typechecks perfectly:
 *
 *   - the search uses a raw `sql` template for its `escape` clause, so whether
 *     `sql.ref(column)` resolves a camelCase property to a snake_case column — under
 *     `CamelCasePlugin`, which only rewrites the *typed* query builder — is a question only
 *     the driver answers. Getting it wrong is a runtime "no such column" on every search;
 *   - `countsByGuild` counts with `case` expressions inside aggregates, and `count`
 *     returns a string on postgres and a number on sqlite.
 *
 * Only the sqlite arm runs. The postgres arm stays hand-reviewed and unexercised, which is
 * recorded rather than claimed.
 */

interface TestDatabase {
    tickets: TicketTable;
}

const db = new Kysely<TestDatabase>({
    dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
    plugins: [
        new CamelCasePlugin(),
        new SqlDatePlugin<TestDatabase>({
            tickets: ['openedAt', 'claimedAt', 'closedAt', 'deletedAt', 'updatedAt'],
        }),
    ],
});

vi.mock('../../../../features-system/data-persistence/database', () => ({
    get database() {
        return db;
    },
}));

const { ticketsRepo } = await import('../ticketsRepo');

const GUILD_ID = 'guild-1';
const OTHER_GUILD = 'guild-2';

interface SeedRow {
    ticketNumber: number;
    subjectUsername: string | null;
    subjectNickname: string | null;
    openerUsername?: string | null;
    claimerUsername?: string | null;
    claimerId?: string | null;
    status?: 'open' | 'closed' | 'deleted';
    guildId?: string;
}

async function seed(rows: SeedRow[]): Promise<void> {
    const now = new Date().toISOString();
    for (const row of rows) {
        await db
            .insertInto('tickets')
            .values({
                guildId: row.guildId ?? GUILD_ID,
                ticketNumber: row.ticketNumber,
                type: 'support',
                status: row.status ?? 'open',
                subjectId: `subject-${row.ticketNumber}`,
                openerId: 'opener-1',
                claimerId: row.claimerId ?? null,
                channelId: `channel-${row.ticketNumber}`,
                subjectUsername: row.subjectUsername,
                subjectNickname: row.subjectNickname,
                openerUsername: row.openerUsername ?? null,
                openerNickname: null,
                claimerUsername: row.claimerUsername ?? null,
                claimerNickname: null,
                stateMessageId: null,
                title: `Ticket ${row.ticketNumber}`,
                reason: 'A reason',
                openedAt: now,
                claimedAt: null,
                closedAt: null,
                deletedAt: null,
                updatedAt: now,
            })
            .execute();
    }
}

beforeAll(async () => {
    const migrator = db as unknown as Kysely<unknown>;
    await createTicketingConfig(migrator);
    await createTickets(migrator);
    await addIdentityAndTypes(migrator);

    await seed([
        { ticketNumber: 1, subjectUsername: 'kittenuser', subjectNickname: 'Kitten' },
        { ticketNumber: 2, subjectUsername: 'bratuser', subjectNickname: 'Brat', claimerId: 'mod-1', claimerUsername: 'modperson' },
        { ticketNumber: 3, subjectUsername: 'KITTENSHOUT', subjectNickname: null, status: 'closed' },
        // The literal-underscore and literal-percent cases the escape clause exists for.
        { ticketNumber: 4, subjectUsername: 'a_b', subjectNickname: null },
        { ticketNumber: 5, subjectUsername: 'axb', subjectNickname: null },
        { ticketNumber: 42, subjectUsername: 'numbered', subjectNickname: null },
        { ticketNumber: 420, subjectUsername: 'alsonumbered', subjectNickname: null },
        // Another guild's row, to prove every query is scoped.
        { ticketNumber: 9, subjectUsername: 'kittenuser', subjectNickname: 'Kitten', guildId: OTHER_GUILD },
    ]);
});

afterAll(async () => {
    await db.destroy();
});

describe('searchByGuild against real sqlite', () => {
    it('resolves its raw-SQL column references, rather than raising "no such column"', async () => {
        // The guard for `sql.ref` under `CamelCasePlugin`: the plugin rewrites the typed
        // builder, and a raw template is not the typed builder. If the names did not
        // resolve, every search in the product would throw at runtime with a green suite.
        const found = await ticketsRepo.searchByGuild(GUILD_ID, 'kitten');

        // Both `kittenuser` and `KITTENSHOUT` start with "kitten", and newest-first
        // ordering puts 3 ahead of 1. Prefix matching is the point: an operator half-
        // remembering a name should get the candidates, not only an exact hit.
        expect(found.map((row) => row.ticketNumber)).toEqual([3, 1]);
    });

    it('matches a nickname as well as a username', async () => {
        expect((await ticketsRepo.searchByGuild(GUILD_ID, 'Brat')).map((row) => row.ticketNumber)).toEqual([2]);
    });

    it('matches case-insensitively in both directions', async () => {
        const lower = await ticketsRepo.searchByGuild(GUILD_ID, 'kittenshout');
        const upper = await ticketsRepo.searchByGuild(GUILD_ID, 'KITTENSHOUT');

        expect(lower.map((row) => row.ticketNumber)).toEqual([3]);
        expect(upper.map((row) => row.ticketNumber)).toEqual([3]);
    });

    it('matches a claimer by name', async () => {
        expect((await ticketsRepo.searchByGuild(GUILD_ID, 'modperson')).map((row) => row.ticketNumber)).toEqual([2]);
    });

    it('treats a numeric query as an exact ticket number, not a prefix', async () => {
        // `LIKE '%42%'` would bury ticket 42 under 420. A number an operator typed is the
        // number they mean.
        expect((await ticketsRepo.searchByGuild(GUILD_ID, '42')).map((row) => row.ticketNumber)).toEqual([42]);
    });

    it('treats a typed underscore as an underscore', async () => {
        // Unescaped, `a_b` is a LIKE wildcard and would also match `axb`.
        expect((await ticketsRepo.searchByGuild(GUILD_ID, 'a_b')).map((row) => row.ticketNumber)).toEqual([4]);
    });

    it('does not let a bare percent match every row', async () => {
        // Parameterization prevents injection but not interpretation: `%` is a legal bind
        // value that matches everything, which is a search returning the whole table.
        expect(await ticketsRepo.searchByGuild(GUILD_ID, '%')).toEqual([]);
    });

    it('never returns another guild’s tickets', async () => {
        const found = await ticketsRepo.searchByGuild(GUILD_ID, 'kitten');

        expect(found.every((row) => row.guildId === GUILD_ID)).toBe(true);
    });

    it('honours the status filter alongside the text', async () => {
        expect(await ticketsRepo.searchByGuild(GUILD_ID, 'kittenshout', { status: 'open' })).toEqual([]);
        expect(
            (await ticketsRepo.searchByGuild(GUILD_ID, 'kittenshout', { status: 'closed' })).map(
                (row) => row.ticketNumber
            )
        ).toEqual([3]);
    });

    it('honours the unclaimed filter, so searching does not widen it', async () => {
        expect(await ticketsRepo.searchByGuild(GUILD_ID, 'brat', { unclaimedOnly: true })).toEqual([]);
    });
});

describe('countsByGuild against real sqlite', () => {
    it('counts open, unclaimed and closed in one query, as numbers', async () => {
        const counts = await ticketsRepo.countsByGuild(GUILD_ID);

        // `case` inside an aggregate is the part worth pinning: it is valid on both
        // dialects but easy to get wrong, and `count` returns a string on postgres.
        expect(typeof counts.open).toBe('number');
        expect(counts.closed).toBe(1);
        // Six open rows in this guild, of which one (ticket 2) is claimed.
        expect(counts.open).toBe(6);
        expect(counts.unclaimed).toBe(5);
    });

    it('scopes the counts to the guild', async () => {
        const other = await ticketsRepo.countsByGuild(OTHER_GUILD);

        expect(other.open).toBe(1);
        expect(other.closed).toBe(0);
    });

    it('reports zeroes for a guild with no tickets rather than throwing', async () => {
        expect(await ticketsRepo.countsByGuild('guild-with-nothing')).toEqual({
            open: 0,
            unclaimed: 0,
            closed: 0,
        });
    });
});
