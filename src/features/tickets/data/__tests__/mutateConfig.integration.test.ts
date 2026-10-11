import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { withinDeadlockTimeout } from '../../../provisioning/__tests__/support/provisioningTestDb';
import type { ResourceBindingTable } from '../../../provisioning/data/resourceBindingsSchema';
import { createTicketTestTables, seedTicketCategorySlots } from '../../__tests__/support/ticketTestTables';
import type { StoredTicketingConfig, TicketingConfig, TicketingConfigTable } from '../ticketingSchema';

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
 * And since the category slots moved into `resource_bindings` (2026-10-10): the mutator
 * is handed them assembled on the transaction, the result is re-assembled from the rows,
 * and **no write puts `categories` back into the blob** — read off the raw column.
 *
 * In-memory, so it costs nothing and cannot touch the dev database. **Only the sqlite arm
 * runs**; the postgres `FOR UPDATE` path stays hand-reviewed and unexercised, which is
 * recorded honestly rather than claimed as covered.
 */

interface TestDatabase {
    ticketing_config: TicketingConfigTable;
    resource_bindings: ResourceBindingTable;
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

const SLOTS: TicketingConfig['categories'] = {
    open: { name: 'Tickets', discordId: '900000000000000001', provenance: 'adopted' },
    claimed: { name: 'Claimed', discordId: '900000000000000002', provenance: 'adopted' },
    closed: { name: 'Closed', discordId: '900000000000000003', provenance: 'adopted' },
};

function baseConfig(): StoredTicketingConfig {
    return {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: 'panel-channel',
        modTicketsDeployedMessageId: 'panel-message',
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

/**
 * The blob as the database holds it — the **raw** column, re-read rather than taken from a
 * return value, with nothing assembled into it.
 */
async function storedConfig(): Promise<Record<string, unknown> | null> {
    const row = await db
        .selectFrom('ticketing_config')
        .selectAll()
        .where('guildId', '=', GUILD_ID)
        .executeTakeFirst();
    return (row?.config as Record<string, unknown> | undefined) ?? null;
}

// The config's two tables, once: its blob, and the category slot rows.
await createTicketTestTables(db as unknown as Kysely<unknown>);

beforeEach(async () => {
    await db.deleteFrom('ticketing_config').execute();
    await db.deleteFrom('resource_bindings').execute();
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
    await seedTicketCategorySlots(GUILD_ID, SLOTS);
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
            moderationRoles: ['other-role'],
        }));

        expect(result).not.toBeNull();
        expect((await storedConfig())?.moderationRoles).toEqual(['other-role']);
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

describe('the category slots, which live in resource_bindings', () => {
    it('hands the mutator the slots, assembled from the rows on its transaction', async () => {
        let seen: unknown = 'not called';
        await withinDeadlockTimeout(
            ticketingRepo.mutateConfig(GUILD_ID, (current) => {
                seen = current.config.categories;
                return current.config;
            }),
            'mutateConfig'
        );

        expect(seen).toEqual(SLOTS);
    });

    it('never writes `categories` into the blob, through a spread mutateConfig or upsert', async () => {
        // Sabotage-verified: removing the strip in `serializeStoredConfig` puts the
        // assembled slots back into the raw column on both paths.
        await withinDeadlockTimeout(
            ticketingRepo.mutateConfig(GUILD_ID, (current) => ({ ...current.config, moderationRoles: ['other-role'] })),
            'mutateConfig'
        );
        expect(await storedConfig()).not.toHaveProperty('categories');

        const assembled = await ticketingRepo.get(GUILD_ID);
        if (!assembled) throw new Error('config row vanished');
        await ticketingRepo.upsert({ guildId: GUILD_ID, config: assembled.config, ticketNumberInc: 0, entityVersion: 1 });
        expect(await storedConfig()).not.toHaveProperty('categories');
        expect(await storedConfig()).toMatchObject({ moderationRoles: ['other-role'] });
    });

    it('returns the slots as the mutator left them, re-read from the rows', async () => {
        const replacement = { name: 'Fresh', discordId: '900000000000000099', provenance: 'created' as const };

        const result = await withinDeadlockTimeout(
            ticketingRepo.mutateConfig(GUILD_ID, async (current, transaction) => {
                await ticketingRepo.writeCategorySlots(GUILD_ID, { open: replacement }, transaction);
                return current.config;
            }),
            'mutateConfig'
        );

        // What the settings PUT renders, so it must show the slot as saved.
        expect(result?.categories.open).toEqual(replacement);
        expect(result?.categories.claimed).toEqual(SLOTS.claimed);
    });

    it('reads a slot with no row as null, and an unbound one as a name with no category', async () => {
        await db.deleteFrom('resource_bindings').execute();
        await seedTicketCategorySlots(GUILD_ID, { open: { name: 'Remembered', discordId: null } });

        const entity = await ticketingRepo.get(GUILD_ID);

        expect(entity?.config.categories).toEqual({
            open: { name: 'Remembered', discordId: null },
            claimed: null,
            closed: null,
        });
    });
});
