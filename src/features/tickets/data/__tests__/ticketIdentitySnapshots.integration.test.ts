import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SqlDatePlugin } from '../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';

/**
 * The identity migration and the type seed, against real SQLite.
 *
 * Three things here are only true if the database says so, and each is a shape this
 * repo has produced a false pass in before:
 *
 *   - the seven new columns exist and are nullable, asserted from `PRAGMA table_info`
 *     rather than from an insert that happens to work;
 *   - the seed genuinely *writes* — a migration that matches zero rows looks identical
 *     to one whose assertions read their own fixture, so every assertion below reads
 *     the row back out of the database;
 *   - `claimIfUnclaimed` writes the id and both names in **one** statement, so a
 *     refused claim cannot leave its name on the winner's row.
 *
 * `DB_TYPE` is read at *import* time by every migration module, so it cannot be set
 * in `beforeAll`. `vitest.setup.ts` sets it to `sqlite` before any test file is
 * imported; it is asserted below rather than assumed. Only the sqlite arm runs here —
 * the postgres arm of the seed is genuinely different SQL (`jsonb ||` and `-` against
 * `json_set`/`json_remove`) and remains hand-verified, which is recorded honestly
 * rather than claimed as covered.
 */

/**
 * The repo binds the module-level `database` singleton, so reaching an in-memory
 * instance means replacing that module. The mock is a *real* Kysely over `:memory:`
 * with the same plugin stack `database.ts` builds for sqlite — not a stub — so the
 * SQL under test is the SQL that runs in production.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: Kysely<any>;

vi.mock('../../../../features-system/data-persistence/database', () => ({
    get database() {
        return db;
    },
}));

import { up as createTicketingConfig } from '../../../../features-system/data-persistence/migrations/2025-11-10-Create_Ticketing_Config';
import { up as createTickets } from '../../../../features-system/data-persistence/migrations/2026-09-17-Create_Tickets_Table';
import {
    TICKET_TYPES_JSON,
    up as addIdentityAndTypes,
} from '../../../../features-system/data-persistence/migrations/2026-09-23-Add_Ticket_Identity_And_Types';
import { DEFAULT_TICKET_TYPES } from '../defaultTicketTypes';
import { ticketsRepo } from '../ticketsRepo';
import type { TicketingConfig } from '../ticketingSchema';

const IDENTITY_COLUMNS = [
    'subject_username',
    'subject_nickname',
    'opener_username',
    'opener_nickname',
    'claimer_username',
    'claimer_nickname',
    'state_message_id',
] as const;

/** A `ticketing_config.config` in its pre-migration shape: no types, all four dead members. */
const PRE_MIGRATION_CONFIG = {
    modTicketsDeployed: true,
    modTicketsDeployedChannelId: 'channel-1',
    modTicketsDeployedMessageId: 'message-1',
    userTicketsDeployed: false,
    userTicketsDeployedChannelId: null,
    userTicketsDeployedMessageId: null,
    supportTicketCategoryName: 'Support',
    claimedTicketCategoryName: 'Claimed',
    closedTicketCategoryName: 'Closed',
    ticketChannelNameTemplate: 'S{{####}}-{{user}}-{{creator}}',
    moderationRoles: ['role-1'],
};

/** A guild that already has types, and an operator-authored one the seed must not touch. */
const ALREADY_SEEDED_CONFIG = {
    ...PRE_MIGRATION_CONFIG,
    ticketTypes: {
        appeals: {
            type: 'appeals',
            label: 'Appeals',
            nameTemplate: 'A{{####}}-{{subject}}',
            permissions: DEFAULT_TICKET_TYPES.support.permissions,
            autoClaimOnOpen: false,
        },
    },
};

const AN_INSTANT = '2026-09-23T10:00:00.000Z';

/**
 * Reads a config back out of the database, never from the fixture object.
 *
 * Aliased deliberately: `SqliteJsonPlugin` is registered for
 * `ticketing_config.config` and would parse the column for us, which would hide
 * whether the migration left valid JSON *text* behind. `json_set` returns text and the
 * column stays `text`, and that is the claim being checked — so the parse happens here,
 * on bytes. The alias is one word so `CamelCasePlugin` cannot rewrite it either.
 */
async function readConfig(guildId: string): Promise<TicketingConfig> {
    const row = await sql<{
        stored: string;
    }>`select config as stored from ticketing_config where guild_id = ${guildId}`.execute(db);
    const stored = row.rows[0]?.stored;
    if (!stored) throw new Error(`No ticketing_config row for ${guildId}`);

    expect(typeof stored, 'config should still be stored as JSON text on sqlite').toBe('string');

    return JSON.parse(stored) as TicketingConfig;
}

beforeAll(async () => {
    expect(process.env.DB_TYPE).toBe('sqlite');

    db = new Kysely({
        dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
        // Order and content mirror `database.ts`'s sqlite arm. `CamelCasePlugin` must
        // come first: `SqlDatePlugin` matches camelCase keys, but result rows arrive as
        // `updated_at` until the case plugin has transformed them.
        plugins: [
            new CamelCasePlugin(),
            new SqliteJsonPlugin({ ticketing_config: ['config'] }),
            new SqlDatePlugin({
                tickets: ['openedAt', 'claimedAt', 'closedAt', 'deletedAt', 'updatedAt'],
            }),
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as Kysely<any>;

    // In this exact order: the tables the seed reads must exist before it runs.
    await createTicketingConfig(db);
    await createTickets(db);

    // Two rows, hand-inserted with raw snake_case so the fixture is written the way a
    // pre-migration process would have written it, bypassing the app's plugins.
    await sql`
        insert into ticketing_config (guild_id, config, ticket_number_inc, entity_version)
        values
            ('guild-pre', ${JSON.stringify(PRE_MIGRATION_CONFIG)}, 5, 1),
            ('guild-seeded', ${JSON.stringify(ALREADY_SEEDED_CONFIG)}, 2, 1)
    `.execute(db);

    await addIdentityAndTypes(db);
});

afterAll(async () => {
    await db.destroy();
});

describe('the identity migration’s sqlite arm', () => {
    it('adds all seven columns, nullable', async () => {
        const columns = await sql<{
            name: string;
            notnull: number;
            dflt_value: string | null;
        }>`PRAGMA table_info(tickets)`.execute(db);

        for (const expected of IDENTITY_COLUMNS) {
            const column = columns.rows.find((row) => row.name === expected);
            expect(column, `column ${expected} is missing`).toBeDefined();
            // Nullable is forced, not chosen: this altered a table with live rows, and a
            // snapshot is a fact about a write that has not happened yet for them.
            expect(column?.notnull, `column ${expected} should be nullable`).toBe(0);
            // No default either — `''` would be a username. `better-sqlite3` reports an
            // absent default as `null`, which arrives as `undefined` through Kysely's row
            // mapping, so both are accepted rather than pinning one driver's spelling.
            expect(column?.dflt_value ?? null, `column ${expected} should have no default`).toBeNull();
        }
    });
});

describe('the seed payload’s shape', () => {
    it('is the bare type record, because both arms name the ticketTypes path themselves', () => {
        // The guard for the one arm this file cannot execute. The postgres arm originally
        // used `jsonb ||` — a shallow merge of *top-level* keys with no path — so handing
        // it this bare record wrote `support` and `verification` as siblings of
        // `modTicketsDeployed` and left `config.ticketTypes` undefined. Silent: the
        // idempotency guard never cleared and every button on every existing ticket
        // refused, with nothing raising an error.
        //
        // Both arms now name the path (`jsonb_set(config, '{ticketTypes}', …)` and
        // `json_set(config, '$.ticketTypes', …)`), so the payload must NOT be wrapped.
        // Re-wrap it and postgres writes `config.ticketTypes.ticketTypes`. This assertion
        // is what fails in CI instead.
        const payload = JSON.parse(TICKET_TYPES_JSON) as Record<string, unknown>;

        expect(Object.keys(payload).sort()).toEqual(['support', 'verification']);
        expect(payload).not.toHaveProperty('ticketTypes');
        expect(payload.support).toEqual(DEFAULT_TICKET_TYPES.support);
    });
});

describe('the type seed', () => {
    it('writes ticketTypes into an existing config row and removes the four dead members', async () => {
        // Read back from the database. A fixture-object assertion here would pass even
        // with the seed's `where` guard closed, which is the false-pass shape this repo
        // has produced before.
        const config = await readConfig('guild-pre');

        expect(Object.keys(config.ticketTypes ?? {}).sort()).toEqual(['support', 'verification']);
        // Not just present — the seeded value, permission model and all, so the seed and
        // the TypeScript record cannot have drifted.
        expect(config.ticketTypes?.support).toEqual(DEFAULT_TICKET_TYPES.support);
        expect(config.ticketTypes?.verification).toEqual(DEFAULT_TICKET_TYPES.verification);

        expect(config).not.toHaveProperty('ticketChannelNameTemplate');
        expect(config).not.toHaveProperty('userTicketsDeployed');
        expect(config).not.toHaveProperty('userTicketsDeployedChannelId');
        expect(config).not.toHaveProperty('userTicketsDeployedMessageId');

        // And the members it had no business touching are still there. `json_remove`
        // takes keys, not paths into siblings.
        expect(config.supportTicketCategoryName).toBe('Support');
        expect(config.moderationRoles).toEqual(['role-1']);
    });

    it('is a no-op on a row that already has ticketTypes', async () => {
        const config = await readConfig('guild-seeded');

        // The guard is what stops a re-run from replacing an operator-authored type
        // with the two seeded ones — the outcome the asymmetric `down` was written to
        // prevent, arriving through a different door.
        expect(Object.keys(config.ticketTypes ?? {})).toEqual(['appeals']);
        // Untouched means untouched: the dead members survive on this row, because the
        // whole statement was skipped rather than half-applied.
        expect(config).toHaveProperty('ticketChannelNameTemplate');
    });
});

describe('claimIfUnclaimed, through the repo', () => {
    it('writes the claimer id and both names in one statement', async () => {
        const opened = await ticketsRepo.create({
            guildId: 'guild-claim',
            ticketNumber: 1,
            type: 'support',
            status: 'open',
            subjectId: 'subject-1',
            openerId: null,
            claimerId: null,
            channelId: 'channel-claim-1',
            subjectUsername: 'subjectuser',
            subjectNickname: null,
            openerUsername: null,
            openerNickname: null,
            claimerUsername: null,
            claimerNickname: null,
            stateMessageId: null,
            title: 'Title',
            reason: 'Reason',
            openedAt: '2026-09-23T10:00:00.000Z',
            claimedAt: null,
            closedAt: null,
            deletedAt: null,
            updatedAt: '2026-09-23T10:00:00.000Z',
        });

        const claimed = await ticketsRepo.claimIfUnclaimed(opened.id, 'mod-a', '2026-09-23T11:00:00.000Z', {
            username: 'moduser-a',
            nickname: 'Mod A',
        });

        expect(claimed?.claimerId).toBe('mod-a');
        expect(claimed?.claimerUsername).toBe('moduser-a');
        expect(claimed?.claimerNickname).toBe('Mod A');
    });

    it('leaves the winner’s id AND the winner’s names intact when a second claim is refused', async () => {
        // **True concurrency is not simulated.** A single-connection `better-sqlite3`
        // test has no interleaving, so two sequential calls cannot actually race. The
        // guard under test is therefore the `where` clause *plus* single-statement
        // atomicity — not a race.
        //
        // That is exactly why the assertion is about the *names* and not about the
        // second call returning null. Split the repo method into a guarded id update
        // plus an unguarded name update and the second caller's id write is still
        // correctly refused — but its name write lands, leaving the row holding
        // claimer A's id under claimer B's name. A test asserting only "the second
        // claim returned null" would stay green through that, which is the
        // fails-to-fail shape this repo has produced twice.
        const opened = await ticketsRepo.create({
            guildId: 'guild-claim',
            ticketNumber: 2,
            type: 'support',
            status: 'open',
            subjectId: 'subject-2',
            openerId: null,
            claimerId: null,
            channelId: 'channel-claim-2',
            subjectUsername: null,
            subjectNickname: null,
            openerUsername: null,
            openerNickname: null,
            claimerUsername: null,
            claimerNickname: null,
            stateMessageId: null,
            title: 'Title',
            reason: 'Reason',
            openedAt: '2026-09-23T10:00:00.000Z',
            claimedAt: null,
            closedAt: null,
            deletedAt: null,
            updatedAt: '2026-09-23T10:00:00.000Z',
        });

        const winner = await ticketsRepo.claimIfUnclaimed(opened.id, 'mod-a', '2026-09-23T11:00:00.000Z', {
            username: 'moduser-a',
            nickname: 'Mod A',
        });
        const loser = await ticketsRepo.claimIfUnclaimed(opened.id, 'mod-b', '2026-09-23T11:00:01.000Z', {
            username: 'moduser-b',
            nickname: 'Mod B',
        });

        expect(winner).not.toBeNull();
        // Zero rows back *is* the refusal.
        expect(loser).toBeNull();

        const settled = await ticketsRepo.getById(opened.id);
        expect(settled?.claimerId).toBe('mod-a');
        // The assertion that breaks under a split: the loser's name must not be here.
        expect(settled?.claimerUsername).toBe('moduser-a');
        expect(settled?.claimerNickname).toBe('Mod A');
    });

    it('records a null nickname without discarding the username', async () => {
        const opened = await ticketsRepo.create({
            guildId: 'guild-claim',
            ticketNumber: 3,
            type: 'support',
            status: 'open',
            subjectId: 'subject-3',
            openerId: null,
            claimerId: null,
            channelId: 'channel-claim-3',
            subjectUsername: null,
            subjectNickname: null,
            openerUsername: null,
            openerNickname: null,
            claimerUsername: null,
            claimerNickname: null,
            stateMessageId: null,
            title: 'Title',
            reason: 'Reason',
            openedAt: '2026-09-23T10:00:00.000Z',
            claimedAt: null,
            closedAt: null,
            deletedAt: null,
            updatedAt: '2026-09-23T10:00:00.000Z',
        });

        const claimed = await ticketsRepo.claimIfUnclaimed(opened.id, 'mod-c', '2026-09-23T11:00:00.000Z', {
            username: 'moduser-c',
            nickname: null,
        });

        // A moderator with no nickname is not a moderator with no name.
        expect(claimed?.claimerUsername).toBe('moduser-c');
        expect(claimed?.claimerNickname).toBeNull();
    });
});

describe('opening a ticket records its state message', () => {
    it('writes stateMessageId through the repo update the open paths call', async () => {
        const opened = await ticketsRepo.create({
            guildId: 'guild-state',
            ticketNumber: 1,
            type: 'support',
            status: 'open',
            subjectId: 'subject-1',
            openerId: 'opener-1',
            claimerId: null,
            channelId: 'channel-state-1',
            subjectUsername: 'subjectuser',
            subjectNickname: 'Kitten',
            openerUsername: 'openeruser',
            openerNickname: null,
            claimerUsername: null,
            claimerNickname: null,
            // Null at create, because the message does not exist until the channel does.
            stateMessageId: null,
            title: 'Title',
            reason: 'Reason',
            openedAt: '2026-09-23T10:00:00.000Z',
            claimedAt: null,
            closedAt: null,
            deletedAt: null,
            updatedAt: '2026-09-23T10:00:00.000Z',
        });
        expect(opened.stateMessageId).toBeNull();

        await ticketsRepo.update(opened.id, { stateMessageId: 'state-message-99' });

        const reread = await ticketsRepo.getById(opened.id);
        expect(reread?.stateMessageId).toBe('state-message-99');
        // The identity snapshots taken at open survive a later write that names none of
        // them — an `update` sets only its own keys.
        expect(reread?.subjectNickname).toBe('Kitten');
    });
});

describe('countByType and listByType, the refusal’s two queries', () => {
    it('groups counts by status and caps the examples newest-first', async () => {
        const statuses = ['open', 'open', 'closed', 'deleted'] as const;
        for (const [index, status] of statuses.entries()) {
            await sql`
                insert into tickets (
                    guild_id, ticket_number, type, status, subject_id, opener_id, claimer_id,
                    channel_id, title, reason, opened_at, claimed_at, closed_at, deleted_at, updated_at
                ) values (
                    'guild-usage', ${index + 1}, 'appeals', ${status}, 'subject-1', null, null,
                    ${`channel-usage-${index}`}, 'Title', 'Reason',
                    ${AN_INSTANT}, null, null, null, ${AN_INSTANT}
                )
            `.execute(db);
        }

        const counts = await ticketsRepo.countByType('guild-usage', 'appeals');
        // `count(*)` arrives as a number on sqlite and a string on postgres; the repo
        // coerces at the boundary so a caller never has to know which.
        expect(counts.find((row) => row.status === 'open')?.count).toBe(2);
        expect(counts.find((row) => row.status === 'closed')?.count).toBe(1);
        expect(counts.find((row) => row.status === 'deleted')?.count).toBe(1);

        const examples = await ticketsRepo.listByType('guild-usage', 'appeals', 2);
        expect(examples).toHaveLength(2);
        expect(examples[0]?.ticketNumber).toBe(4);
    });

    it('does not count another guild’s tickets of the same type', async () => {
        const counts = await ticketsRepo.countByType('guild-other', 'appeals');

        expect(counts).toEqual([]);
    });
});
