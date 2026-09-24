import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { up as createTicketingConfig } from '../../../../features-system/data-persistence/migrations/2025-11-10-Create_Ticketing_Config';
import type { TicketingConfig, TicketingConfigTable } from '../ticketingSchema';

/**
 * `mutateConfig` against real SQLite, on the migration's own table.
 *
 * It exists to make a read-modify-write of the `config` blob atomic, and that claim is
 * only true if the database says so — the unit tests around it inject a fake whose whole
 * body is "call the mutator, keep what it returns", which proves the calling convention
 * and nothing about SQL.
 *
 * Three things are checked here that nothing else can see:
 *
 *   - the statement it builds is one **sqlite accepts**. The postgres arm adds
 *     `FOR UPDATE`, which `better-sqlite3` rejects outright with `near "for": syntax
 *     error` — so an unconditional lock would break every config save on the only arm
 *     CI runs, and this test is what would have caught that;
 *   - a mutator returning null writes **nothing**, which is what makes a refusal a
 *     refusal rather than a message attached to a completed write;
 *   - the blob round-trips through `SqliteJsonPlugin` as an object, not a JSON string.
 *
 * In-memory, so it costs nothing and cannot touch the dev database. **Only the sqlite arm
 * runs**; the postgres `FOR UPDATE` path stays hand-reviewed and unexercised, which is
 * recorded honestly rather than claimed as covered.
 */

interface TestDatabase {
    ticketing_config: TicketingConfigTable;
}

const sqliteFile = new SqliteDatabase(':memory:');

const db = new Kysely<TestDatabase>({
    dialect: new SqliteDialect({ database: sqliteFile }),
    // Mirrors `database.ts`'s sqlite arm: `config` is a JSON *string* in the column and
    // an object in TypeScript, and without this plugin every read comes back as text —
    // so `current.config.ticketTypes` would be undefined and every mutation would bail.
    plugins: [new CamelCasePlugin(), new SqliteJsonPlugin<TestDatabase>({ ticketing_config: ['config'] })],
});

// The repo binds the module-level singleton, so the in-memory instance is injected in
// its place. Same approach the sibling identity-snapshot integration test uses.
vi.mock('../../../../features-system/data-persistence/database', () => ({
    get database() {
        return db;
    },
}));

const { ticketingRepo } = await import('../ticketingRepo');

const GUILD_ID = 'guild-1';

function baseConfig(): TicketingConfig {
    return {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: 'panel-channel',
        modTicketsDeployedMessageId: 'panel-message',
        supportTicketCategoryName: 'Tickets',
        claimedTicketCategoryName: 'Claimed',
        closedTicketCategoryName: 'Closed',
        moderationRoles: ['mod-role'],
        ticketTypes: {
            support: {
                type: 'support',
                label: 'Support',
                nameTemplate: 'S{{####}}-{{subject}}',
                permissions: {
                    subject: { view: true, send: true, readHistory: true, manageMessages: false },
                    opener: { view: true, send: true, readHistory: true, manageMessages: false },
                    staff: { view: true, send: true, readHistory: true, manageMessages: true },
                },
                autoClaimOnOpen: true,
            },
        },
    };
}

/** The row as the database holds it, re-read rather than taken from a return value. */
async function storedConfig(): Promise<TicketingConfig | null> {
    const row = await db
        .selectFrom('ticketing_config')
        .selectAll()
        .where('guildId', '=', GUILD_ID)
        .executeTakeFirst();
    return (row?.config as TicketingConfig | undefined) ?? null;
}

beforeEach(async () => {
    await db.schema.dropTable('ticketing_config').ifExists().execute();
    await createTicketingConfig(db as unknown as Kysely<unknown>);
    await db
        .insertInto('ticketing_config')
        .values({
            guildId: GUILD_ID,
            // The column takes the serialized string on insert and yields an object on
            // read — `JSONColumnType`'s whole point — so the seed writes text here.
            config: JSON.stringify(baseConfig()),
            ticketNumberInc: 7,
            entityVersion: 1,
        })
        .execute();
});

afterAll(async () => {
    await db.destroy();
});

describe('ticketingRepo.mutateConfig against real sqlite', () => {
    it('runs on sqlite at all — the statement it builds is one the driver accepts', async () => {
        // The regression guard for the dialect branch. `FOR UPDATE` is postgres-only and
        // `better-sqlite3` raises a syntax error on it, so if the lock were applied
        // unconditionally this test would fail rather than every config save failing in
        // production.
        const result = await ticketingRepo.mutateConfig(GUILD_ID, (current) => ({
            ...current.config,
            supportTicketCategoryName: 'Renamed',
        }));

        expect(result).not.toBeNull();
        expect((await storedConfig())?.supportTicketCategoryName).toBe('Renamed');
    });

    it('persists only the members the mutator changed, leaving the rest of the blob alone', async () => {
        await ticketingRepo.mutateConfig(GUILD_ID, (current) => ({
            ...current.config,
            moderationRoles: ['other-role'],
        }));

        const stored = await storedConfig();
        expect(stored?.moderationRoles).toEqual(['other-role']);
        // The declared types survive a write that never mentions them. This is the
        // clobber the config modal shipped for a while, asserted against real SQL rather
        // than against a fake that could not lose it.
        expect(stored?.ticketTypes).toHaveProperty('support');
        expect(stored?.modTicketsDeployedChannelId).toBe('panel-channel');
    });

    it('hands the mutator the row as an object, not a JSON string', async () => {
        let seen: unknown = 'not called';
        await ticketingRepo.mutateConfig(GUILD_ID, (current) => {
            seen = current.config.ticketTypes;
            return current.config;
        });

        // Without `SqliteJsonPlugin` this arrives as text and every `.ticketTypes` lookup
        // in `setTicketTypes` silently returns undefined — on sqlite only.
        expect(seen).toHaveProperty('support');
    });

    it('writes nothing when the mutator refuses', async () => {
        const result = await ticketingRepo.mutateConfig(GUILD_ID, () => null);

        expect(result).toBeNull();
        // A refusal has to leave the row exactly as it was, or "refused" is just a word
        // attached to a write that happened anyway.
        expect(await storedConfig()).toEqual(baseConfig());
    });

    it('returns null for a guild with no row, without inserting one', async () => {
        const result = await ticketingRepo.mutateConfig('guild-with-no-row', (current) => current.config);

        expect(result).toBeNull();
        const rows = await db.selectFrom('ticketing_config').selectAll().execute();
        // Creating a config row is `/deploy-ticket-system`'s job. A mutation inventing one
        // would hand a guild a half-configured ticket system it never asked for.
        expect(rows).toHaveLength(1);
    });

    it('leaves the row untouched when the mutator throws', async () => {
        await expect(
            ticketingRepo.mutateConfig(GUILD_ID, () => {
                throw new Error('mutator exploded');
            })
        ).rejects.toThrow('mutator exploded');

        // The transaction rolls back, so a mutator that fails halfway cannot leave a
        // partially-written blob behind.
        expect(await storedConfig()).toEqual(baseConfig());
    });
});
