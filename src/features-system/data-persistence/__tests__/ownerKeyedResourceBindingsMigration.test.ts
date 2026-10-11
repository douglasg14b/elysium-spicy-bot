import { Migrator, sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { database } from '../database';
import { FileMigrationProvider } from '../fileMigrationProvider';
import { up as ownerKeyResourceBindings } from '../migrations/2026-10-10-Owner_Keyed_Resource_Bindings';
import { migrateTestDatabase } from './support/migrateTestDatabase';

/**
 * `2026-10-10-Owner_Keyed_Resource_Bindings` on SQLite, through a real `Migrator` on the
 * production `database` stack — `CamelCasePlugin`, and `SqliteJsonPlugin` parsing
 * `config` — which is the stack the migration runs on when deployed, and the first
 * migration here to select, loop in TypeScript, then write.
 *
 * The old shape is seeded with raw SQL after migrating down to the one before, because
 * the typed client already describes the new columns.
 *
 * Postgres is not covered here: CI runs SQLite only. See the plan's "As built" for the
 * Docker Postgres run of the same chain.
 */

const BEFORE = '2026-10-05-Create_Flow_Schedules';

const migrator = new Migrator({ db: database, provider: new FileMigrationProvider() });

async function migrateOrThrow(run: Promise<{ error?: unknown }>): Promise<void> {
    const { error } = await run;
    if (error) throw error;
}

const OTHER_MEMBERS = {
    modTicketsDeployed: true,
    modTicketsDeployedChannelId: '1100000000000000001',
    modTicketsDeployedMessageId: '1100000000000000002',
    moderationRoles: ['1100000000000000003'],
    ticketTypes: { support: { type: 'support', label: 'Support' } },
};

/** Each seeded guild's blob, exactly as the pre-change code wrote it. */
const SEEDED_CONFIGS: Readonly<Record<string, Record<string, unknown>>> = {
    // Bound, unbound and empty slots side by side.
    'guild-mixed': {
        ...OTHER_MEMBERS,
        categories: {
            open: { name: 'Open Tickets', discordId: '1200000000000000001', provenance: 'adopted' },
            claimed: { name: 'Claimed', discordId: null },
            closed: null,
        },
    },
    // Two slots on one category: same owner, so two rows sharing an id is legal.
    'guild-shared': {
        ...OTHER_MEMBERS,
        categories: {
            open: { name: 'Tickets', discordId: '1200000000000000010', provenance: 'created' },
            claimed: { name: 'Tickets', discordId: '1200000000000000010', provenance: 'created' },
            closed: { name: 'Closed', discordId: '1200000000000000011', provenance: 'created' },
        },
    },
    // Nothing chosen yet.
    'guild-empty': {
        ...OTHER_MEMBERS,
        categories: { open: null, claimed: null, closed: null },
    },
    // Tickets pointed at a category a journey created: a cross-claim to log, not refuse.
    'guild-cross': {
        ...OTHER_MEMBERS,
        categories: {
            open: { name: 'Lobby', discordId: '1200000000000000020', provenance: 'adopted' },
            claimed: null,
            closed: null,
        },
    },
};

interface OldBindingSeed {
    readonly guildId: string;
    readonly journeyKey: string;
    readonly resourceKey: string;
    readonly kind: string;
    readonly state: string;
    readonly discordId: string | null;
    readonly name: string;
}

const SEEDED_JOURNEY_BINDINGS: readonly OldBindingSeed[] = [
    // A journey an operator called `tickets`, declaring `open`. It stays a journey's.
    {
        guildId: 'guild-mixed',
        journeyKey: 'tickets',
        resourceKey: 'open',
        kind: 'textChannel',
        state: 'created',
        discordId: '1300000000000000001',
        name: 'open',
    },
    {
        guildId: 'guild-cross',
        journeyKey: 'onboarding',
        resourceKey: 'lobby',
        kind: 'category',
        state: 'created',
        discordId: '1200000000000000020',
        name: 'Lobby',
    },
    // A guild with bindings and no ticket config at all.
    {
        guildId: 'guild-no-config',
        journeyKey: 'onboarding',
        resourceKey: 'welcome',
        kind: 'textChannel',
        state: 'intended',
        discordId: null,
        name: 'welcome',
    },
];

async function seedOldShape(): Promise<void> {
    for (const [guildId, config] of Object.entries(SEEDED_CONFIGS)) {
        await sql`
            INSERT INTO ticketing_config (guild_id, config, ticket_number_inc, entity_version)
            VALUES (${guildId}, ${JSON.stringify(config)}, 3, 1)
        `.execute(database);
    }
    const at = '2026-10-09T12:00:00.000Z';
    for (const seed of SEEDED_JOURNEY_BINDINGS) {
        await sql`
            INSERT INTO resource_bindings (guild_id, journey_key, resource_key, kind, state, discord_id, name, created_at, updated_at)
            VALUES (${seed.guildId}, ${seed.journeyKey}, ${seed.resourceKey}, ${seed.kind}, ${seed.state}, ${seed.discordId}, ${seed.name}, ${at}, ${at})
        `.execute(database);
    }
}

async function clearSeeds(): Promise<void> {
    await sql`DELETE FROM ticketing_config`.execute(database);
    await sql`DELETE FROM resource_bindings`.execute(database);
}

interface BindingRow {
    readonly guildId: string;
    readonly ownerKind: string;
    readonly ownerKey: string;
    readonly resourceKey: string;
    readonly kind: string;
    readonly state: string;
    readonly discordId: string | null;
    readonly name: string;
}

async function bindingRows(): Promise<BindingRow[]> {
    const rows = await database
        .selectFrom('resource_bindings')
        .select(['guildId', 'ownerKind', 'ownerKey', 'resourceKey', 'kind', 'state', 'discordId', 'name'])
        .orderBy('guildId')
        .orderBy('ownerKind')
        .orderBy('ownerKey')
        .orderBy('resourceKey')
        .execute();
    return rows;
}

/** Each guild's blob as stored, parsed by the production stack's JSON plugin. */
async function storedConfigs(): Promise<Record<string, unknown>> {
    const { rows } = await sql<{ guildId: string; config: unknown }>`
        SELECT guild_id, config FROM ticketing_config
    `.execute(database);
    return Object.fromEntries(rows.map((row) => [row.guildId, row.config]));
}

async function bindingColumns(): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`SELECT name FROM pragma_table_info('resource_bindings')`.execute(database);
    return rows.map((row) => row.name);
}

beforeAll(async () => {
    await migrateTestDatabase();
});

afterEach(async () => {
    vi.restoreAllMocks();
    // Every case leaves the schema at latest and the tables empty, whatever it did.
    await migrateOrThrow(migrator.migrateToLatest());
    await clearSeeds();
});

describe('2026-10-10-Owner_Keyed_Resource_Bindings (sqlite, through Migrator)', () => {
    it('moves each slot into an owner-keyed row, following the mapping', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await migrateOrThrow(migrator.migrateToLatest());

        const rows = await bindingRows();
        const ticketRows = rows.filter((row) => row.ownerKind === 'tickets');

        expect(ticketRows.filter((row) => row.guildId === 'guild-mixed')).toEqual([
            {
                guildId: 'guild-mixed',
                ownerKind: 'tickets',
                ownerKey: 'tickets',
                resourceKey: 'claimed',
                kind: 'category',
                state: 'intended',
                discordId: null,
                name: 'Claimed',
            },
            {
                guildId: 'guild-mixed',
                ownerKind: 'tickets',
                ownerKey: 'tickets',
                resourceKey: 'open',
                kind: 'category',
                state: 'adopted',
                discordId: '1200000000000000001',
                name: 'Open Tickets',
            },
        ]);

        // Two slots, one category: two rows under one owner with the same id.
        expect(
            ticketRows
                .filter((row) => row.guildId === 'guild-shared')
                .map((row) => [row.resourceKey, row.state, row.discordId])
        ).toEqual([
            ['claimed', 'created', '1200000000000000010'],
            ['closed', 'created', '1200000000000000011'],
            ['open', 'created', '1200000000000000010'],
        ]);

        // All-null slots and no config row both leave no ticket rows.
        expect(ticketRows.some((row) => row.guildId === 'guild-empty')).toBe(false);
        expect(ticketRows.some((row) => row.guildId === 'guild-no-config')).toBe(false);

        // Every existing row is a journey's, under its old key — including the journey
        // called `tickets`, whose `open` sits beside the ticket feature's `open`.
        expect(rows.filter((row) => row.ownerKind === 'journey').map((row) => [row.guildId, row.ownerKey, row.resourceKey])).toEqual([
            ['guild-cross', 'onboarding', 'lobby'],
            ['guild-mixed', 'tickets', 'open'],
            ['guild-no-config', 'onboarding', 'welcome'],
        ]);

        expect(await bindingColumns()).not.toContain('journey_key');
    });

    it('removes `categories` from every blob and leaves every other member alone', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await migrateOrThrow(migrator.migrateToLatest());

        const configs = await storedConfigs();
        for (const guildId of Object.keys(SEEDED_CONFIGS)) {
            expect(configs[guildId]).toEqual(OTHER_MEMBERS);
        }
    });

    it('logs an id held by more than one owner, naming the guild', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await migrateOrThrow(migrator.migrateToLatest());

        const logged = warn.mock.calls.map((call) => String(call[0]));
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain('guild-cross');
        expect(logged[0]).toContain('1200000000000000020');
        expect(logged[0]).toContain('journey:onboarding');
        expect(logged[0]).toContain('tickets:tickets');
    });

    it('is a no-op when run again', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await migrateOrThrow(migrator.migrateToLatest());

        const rowsBefore = await bindingRows();
        const configsBefore = await storedConfigs();

        await ownerKeyResourceBindings(database);

        expect(await bindingRows()).toEqual(rowsBefore);
        expect(await storedConfigs()).toEqual(configsBefore);
    });

    it('goes down to the old shape with every blob as it was, and back up', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await migrateOrThrow(migrator.migrateToLatest());

        await migrateOrThrow(migrator.migrateTo(BEFORE));

        expect(await storedConfigs()).toEqual(SEEDED_CONFIGS);
        expect(await bindingColumns()).toContain('journey_key');
        expect(await bindingColumns()).not.toContain('owner_kind');

        // Only the ticket feature's rows went — deleted by kind, so the journey keyed
        // `tickets` survives.
        const { rows } = await sql<{ guildId: string; journeyKey: string; resourceKey: string }>`
            SELECT guild_id, journey_key, resource_key FROM resource_bindings ORDER BY guild_id, journey_key, resource_key
        `.execute(database);
        expect(rows.map((row) => [row.guildId, row.journeyKey, row.resourceKey])).toEqual([
            ['guild-cross', 'onboarding', 'lobby'],
            ['guild-mixed', 'tickets', 'open'],
            ['guild-no-config', 'onboarding', 'welcome'],
        ]);

        await migrateOrThrow(migrator.migrateToLatest());
        expect(await storedConfigs()).toEqual(
            Object.fromEntries(Object.keys(SEEDED_CONFIGS).map((guildId) => [guildId, OTHER_MEMBERS]))
        );
    });

    it('throws on a slot it does not recognise, naming the guild and slot, and changes nothing', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        const malformed = { ...OTHER_MEMBERS, categories: { open: null, claimed: { discordId: '1' }, closed: null } };
        await sql`
            INSERT INTO ticketing_config (guild_id, config, ticket_number_inc, entity_version)
            VALUES ('guild-malformed', ${JSON.stringify(malformed)}, 0, 1)
        `.execute(database);

        const { error } = await migrator.migrateToLatest();

        expect(String(error)).toMatch(/guild-malformed/);
        expect(String(error)).toMatch(/"claimed"/);
        // The sqlite arm's own transaction rolled back: still the old shape, blob intact.
        expect(await bindingColumns()).toContain('journey_key');
        expect((await storedConfigs())['guild-malformed']).toEqual(malformed);

        await sql`DELETE FROM ticketing_config`.execute(database);
    });
});
