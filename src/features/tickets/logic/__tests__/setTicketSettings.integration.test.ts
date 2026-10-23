import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { withinDeadlockTimeout } from '../../../provisioning/__tests__/support/provisioningTestDb';
import { TestDiscord, type ServerGuild } from '../../../../shared/__tests__/support/testDiscord';
import { createTicketTestTables, seedTicketCategorySlots } from '../../__tests__/support/ticketTestTables';
import { DEFAULT_TICKET_TYPES } from '../../data/defaultTicketTypes';
import type { TicketingConfig } from '../../data/ticketingSchema';

/**
 * Saving the dashboard's ticket settings, which can now create categories.
 *
 * Real discord.js against TestDiscord and a real `ticketing_config` row with real slot
 * rows in `resource_bindings`, so "was a category made" is read from Discord's side and
 * "was it recorded" from the database.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = new Kysely<any>({
    dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
    plugins: [
        new CamelCasePlugin(),
        new SqliteJsonPlugin({ ticketing_config: ['config'], journeys: ['resources'] }),
    ],
});
await createTicketTestTables(db);

vi.mock('../../../../features-system/data-persistence/database', () => ({
    get database() {
        return db;
    },
}));

const { setTicketSettings: setTicketSettingsUnguarded } = await import('../setTicketSettings');
const { upsertTicketType } = await import('../setTicketTypes');
const { ticketingRepo } = await import('../../data/ticketingRepo');

/**
 * Every save runs a transaction on the one sqlite connection, so a singleton query from
 * inside it would hang — reported as a deadlock rather than a bare timeout.
 */
function setTicketSettings(
    input: Parameters<typeof setTicketSettingsUnguarded>[0]
): ReturnType<typeof setTicketSettingsUnguarded> {
    return withinDeadlockTimeout(setTicketSettingsUnguarded(input), 'setTicketSettings');
}

const running: TestDiscord[] = [];

beforeEach(async () => {
    await db.deleteFrom('ticketing_config').execute();
    await db.deleteFrom('resource_bindings').execute();
    await db.deleteFrom('journeys').execute();
});

afterEach(async () => {
    vi.restoreAllMocks();
    for (const discord of running.splice(0)) await discord.destroy();
});

afterAll(async () => {
    await db.destroy();
});

interface Scenario {
    readonly discord: TestDiscord;
    readonly guild: ServerGuild;
    readonly moderatorRoleId: string;
}

async function startScenario(categories: TicketingConfig['categories']): Promise<Scenario> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild({ bot: { permissions: ['ManageChannels', 'ViewChannel'] } });
    const moderator = guild.createRole({ name: 'Moderators' });
    await discord.start();

    await ticketingRepo.upsert({
        guildId: guild.id,
        config: {
            modTicketsDeployed: true,
            modTicketsDeployedChannelId: 'panel-channel',
            modTicketsDeployedMessageId: 'panel-message',
            moderationRoles: [moderator.id],
            ticketTypes: {},
        },
        ticketNumberInc: 0,
        entityVersion: 1,
    });
    await seedTicketCategorySlots(guild.id, categories);

    return { discord, guild, moderatorRoleId: moderator.id };
}

/** A journey in this guild, holding `discordId` under `resourceKey`. */
async function journeyHolding(guildId: string, journey: { key: string; name: string }, discordId: string): Promise<void> {
    const now = new Date().toISOString();
    await db
        .insertInto('journeys')
        .values({
            journeyKey: journey.key,
            guildId,
            name: journey.name,
            description: null,
            resources: JSON.stringify([{ key: 'lobby', kind: 'category', defaultName: 'Lobby' }]),
            createdForFlowId: null,
            createdAt: now,
            updatedAt: now,
        })
        .execute();
    await db
        .insertInto('resource_bindings')
        .values({
            guildId,
            ownerKind: 'journey',
            ownerKey: journey.key,
            resourceKey: 'lobby',
            kind: 'category',
            state: 'created',
            discordId,
            name: 'Lobby',
            createdAt: now,
            updatedAt: now,
        })
        .execute();
}

/** The ticket feature's slot rows, read raw. */
async function slotRows(guildId: string): Promise<{ resourceKey: string; state: string; discordId: string | null }[]> {
    return db
        .selectFrom('resource_bindings')
        .select(['resourceKey', 'state', 'discordId'])
        .where('guildId', '=', guildId)
        .where('ownerKind', '=', 'tickets')
        .orderBy('resourceKey')
        .execute();
}

async function stored(guildId: string): Promise<TicketingConfig> {
    const entity = await ticketingRepo.get(guildId);
    if (!entity) throw new Error('config row vanished');
    return entity.config;
}

function categoryCreates(discord: TestDiscord) {
    return discord.requests.filter(
        (request) =>
            request.method === 'POST' &&
            /^\/guilds\/\d+\/channels$/.test(request.path) &&
            (request.body as { type?: number }).type === 4
    );
}

describe('saving the ticket category slots', () => {
    it('adopts a picked category, creates a named one, and records which is which', async () => {
        const scenario = await startScenario({ open: null, claimed: null, closed: { name: 'Support', discordId: null } });
        const existing = scenario.guild.createCategory({ name: 'Support' });

        const result = await setTicketSettings({
            guild: scenario.discord.clientGuild(scenario.guild),
            categories: { open: { name: 'Tickets' }, claimed: { name: 'Tickets' }, closed: { discordId: existing.id } },
            moderationRoles: [scenario.moderatorRoleId],
        });

        expect(result.ok).toBe(true);
        // One category for the name typed into two slots, as name-matching used to give.
        expect(categoryCreates(scenario.discord)).toHaveLength(1);

        const saved = await stored(scenario.guild.id);
        const created = saved.categories.open;
        expect(created).toMatchObject({ name: 'Tickets', provenance: 'created' });
        expect(saved.categories.claimed).toEqual(created);
        expect(saved.categories.closed).toEqual({ name: 'Support', discordId: existing.id, provenance: 'adopted' });
        // Recorded as rows, one per slot, and the response is what was saved.
        expect(await slotRows(scenario.guild.id)).toEqual([
            { resourceKey: 'claimed', state: 'created', discordId: created?.discordId },
            { resourceKey: 'closed', state: 'adopted', discordId: existing.id },
            { resourceKey: 'open', state: 'created', discordId: created?.discordId },
        ]);
        expect(result.ok && result.config.categories).toEqual(saved.categories);

        // Made on Discord's side, hidden from everyone, open to the moderators.
        const made = scenario.guild.channel(created?.discordId ?? '');
        expect(made.name).toBe('Tickets');
        expect(made.overwriteFor(scenario.guild.everyone)?.deny).toContain('ViewChannel');
        expect(made.overwriteFor(scenario.guild.role(scenario.moderatorRoleId))?.allow).toContain('ViewChannel');
    });

    it('keeps a bound slot as it was when its own id is sent back, rather than calling it adopted', async () => {
        const discordSide = { name: 'Tickets', provenance: 'created' as const };
        const scenario = await startScenario({ open: null, claimed: null, closed: null });
        const category = scenario.guild.createCategory({ name: 'Renamed In Discord' });
        await seedTicketCategorySlots(scenario.guild.id, { open: { ...discordSide, discordId: category.id } });

        const result = await setTicketSettings({
            guild: scenario.discord.clientGuild(scenario.guild),
            categories: { open: { discordId: category.id }, claimed: null, closed: null },
            moderationRoles: [scenario.moderatorRoleId],
        });

        expect(result.ok).toBe(true);
        expect((await stored(scenario.guild.id)).categories.open).toEqual({ ...discordSide, discordId: category.id });
    });

    it('refuses an id that is not a category, and changes nothing', async () => {
        const scenario = await startScenario({ open: null, claimed: null, closed: null });
        const textChannel = scenario.guild.createTextChannel({ name: 'general' });

        const result = await setTicketSettings({
            guild: scenario.discord.clientGuild(scenario.guild),
            categories: { open: { name: 'Tickets' }, claimed: { discordId: textChannel.id }, closed: null },
            moderationRoles: [scenario.moderatorRoleId],
        });

        expect(result).toMatchObject({ ok: false, reason: 'invalid-input' });
        // Checked before anything was created.
        expect(categoryCreates(scenario.discord)).toEqual([]);
        expect((await stored(scenario.guild.id)).categories.open).toBeNull();
    });

    it('saves what it made when a later create fails, and names the one that failed', async () => {
        const scenario = await startScenario({ open: null, claimed: null, closed: null });
        const guild = scenario.discord.clientGuild(scenario.guild);
        const realCreate = guild.channels.create.bind(guild.channels);
        vi.spyOn(guild.channels, 'create')
            .mockImplementationOnce(realCreate)
            .mockRejectedValueOnce(Object.assign(new Error('Missing Permissions'), { code: 50013 }));

        const result = await setTicketSettings({
            guild,
            categories: { open: { name: 'Tickets' }, claimed: { name: 'Claimed' }, closed: null },
            moderationRoles: [scenario.moderatorRoleId],
        });

        expect(result).toMatchObject({ ok: false, reason: 'create-failed' });
        expect(result.ok ? '' : result.message).toMatch(/"Claimed" for claimed tickets/);

        const saved = await stored(scenario.guild.id);
        expect(saved.categories.open).toMatchObject({ name: 'Tickets', provenance: 'created' });
        expect(saved.categories.claimed).toBeNull();
        expect(scenario.guild.channel(saved.categories.open?.discordId ?? '').exists).toBe(true);
    });

    it('refuses to adopt a category a journey holds, naming the journey, and changes nothing', async () => {
        // Sabotage-verified: removing the step-1 `describeOtherHolder` check lets this
        // save adopt the journey's category.
        const scenario = await startScenario({ open: null, claimed: null, closed: null });
        const lobby = scenario.guild.createCategory({ name: 'Lobby' });
        await journeyHolding(scenario.guild.id, { key: 'onboarding', name: 'Onboarding' }, lobby.id);

        const result = await setTicketSettings({
            guild: scenario.discord.clientGuild(scenario.guild),
            categories: { open: { discordId: lobby.id }, claimed: { name: 'Claimed' }, closed: null },
            moderationRoles: [scenario.moderatorRoleId],
        });

        expect(result).toMatchObject({ ok: false, reason: 'invalid-input' });
        expect(result.ok ? '' : result.message).toContain('journey "Onboarding"');
        expect(categoryCreates(scenario.discord)).toEqual([]);
        expect(await slotRows(scenario.guild.id)).toEqual([]);
    });

    it('lets two slots share one existing category — that is one owner', async () => {
        const scenario = await startScenario({ open: null, claimed: null, closed: null });
        const tickets = scenario.guild.createCategory({ name: 'Tickets' });

        const result = await setTicketSettings({
            guild: scenario.discord.clientGuild(scenario.guild),
            categories: { open: { discordId: tickets.id }, claimed: { discordId: tickets.id }, closed: null },
            moderationRoles: [scenario.moderatorRoleId],
        });

        expect(result.ok).toBe(true);
        expect((await slotRows(scenario.guild.id)).map((row) => row.discordId)).toEqual([tickets.id, tickets.id]);
    });

    it('re-checks on the write, so a journey that adopted the category meanwhile still wins', async () => {
        // Step 1 passes; then, while this save is creating, a journey takes the category
        // it is about to adopt. The write's own re-check refuses that slot and saves the
        // rest, so the category this save made is still recorded.
        const scenario = await startScenario({ open: null, claimed: null, closed: null });
        const lobby = scenario.guild.createCategory({ name: 'Lobby' });
        const guild = scenario.discord.clientGuild(scenario.guild);
        const realCreate = guild.channels.create.bind(guild.channels);
        vi.spyOn(guild.channels, 'create').mockImplementationOnce(async (options) => {
            await journeyHolding(scenario.guild.id, { key: 'onboarding', name: 'Onboarding' }, lobby.id);
            return realCreate(options);
        });

        const result = await setTicketSettings({
            guild,
            categories: { open: { discordId: lobby.id }, claimed: { name: 'Claimed' }, closed: null },
            moderationRoles: [scenario.moderatorRoleId],
        });

        expect(result).toMatchObject({ ok: false, reason: 'taken-meanwhile' });
        const message = result.ok ? '' : result.message;
        // Named by key: the display names were read in step 1, before this journey
        // existed — the fallback `describeOwner` gives a journey it has no name for.
        expect(message).toContain('journey "onboarding"');
        const [claimedRow, ...others] = await slotRows(scenario.guild.id);
        expect(others).toEqual([]);
        expect(claimedRow).toMatchObject({ resourceKey: 'claimed', state: 'created' });
        // And the result is what was saved, so the page shows the open slot unchanged.
        expect(!result.ok && 'config' in result && result.config.categories.open).toBeNull();
    });

    it('refuses a second save while the first is still creating', async () => {
        const scenario = await startScenario({ open: null, claimed: null, closed: null });
        const guild = scenario.discord.clientGuild(scenario.guild);
        const input = {
            guild,
            categories: { open: { name: 'Tickets' }, claimed: null, closed: null },
            moderationRoles: [scenario.moderatorRoleId],
        };

        const [first, second] = await Promise.all([setTicketSettings(input), setTicketSettings(input)]);

        expect(first.ok).toBe(true);
        expect(second).toMatchObject({ ok: false, reason: 'busy' });
        expect(categoryCreates(scenario.discord)).toHaveLength(1);
    });
});

/*
 * The type save sets a type's own categories through the same choreography — so only
 * what is the type save's own is tested here: the keys it writes under, `null` going back
 * to the server's, the type and its categories landing together, and the shared lock.
 */
describe("saving a ticket type's own categories", () => {
    const SERVER_SLOTS = {
        open: { name: 'Tickets', discordId: '900000000000000001', provenance: 'adopted' },
        claimed: { name: 'Claimed', discordId: '900000000000000002', provenance: 'adopted' },
        closed: { name: 'Closed', discordId: '900000000000000003', provenance: 'adopted' },
    } as const;

    const verification = { ...DEFAULT_TICKET_TYPES.verification };

    it('makes a named category, adopts a picked one, and leaves the rest on the server’s', async () => {
        const scenario = await startScenario(SERVER_SLOTS);
        const existing = scenario.guild.createCategory({ name: 'Verify Claimed' });

        const result = await upsertTicketType({
            guild: scenario.discord.clientGuild(scenario.guild),
            definition: verification,
            categories: { open: { name: 'Verification' }, claimed: { discordId: existing.id }, closed: null },
        });

        expect(result.ok).toBe(true);
        expect(categoryCreates(scenario.discord)).toHaveLength(1);
        const saved = await stored(scenario.guild.id);
        expect(saved.ticketTypes?.verification).toEqual(verification);
        const own = saved.typeCategories.get('verification');
        expect(own?.open).toMatchObject({ name: 'Verification', provenance: 'created' });
        expect(own?.claimed).toEqual({ name: 'Verify Claimed', discordId: existing.id, provenance: 'adopted' });
        expect(own?.closed).toBeUndefined();
        // The server's slots are untouched, and the response is what was saved.
        expect(saved.categories).toEqual(SERVER_SLOTS);
        expect(result.ok && result.config.typeCategories).toEqual(saved.typeCategories);
        expect(scenario.guild.channel(own?.open?.discordId ?? '').name).toBe('Verification');
    });

    it('puts a slot back on the server’s category when it is sent as null, keeping the category itself', async () => {
        const scenario = await startScenario(SERVER_SLOTS);
        const own = scenario.guild.createCategory({ name: 'Verification' });
        const guild = scenario.discord.clientGuild(scenario.guild);
        await upsertTicketType({
            guild,
            definition: verification,
            categories: { open: { discordId: own.id }, claimed: null, closed: null },
        });

        const result = await upsertTicketType({
            guild,
            definition: verification,
            categories: { open: null, claimed: null, closed: null },
        });

        expect(result.ok).toBe(true);
        expect((await stored(scenario.guild.id)).typeCategories.get('verification')).toBeUndefined();
        expect((await slotRows(scenario.guild.id)).map((row) => row.resourceKey)).toEqual(['claimed', 'closed', 'open']);
        expect(own.exists).toBe(true);
    });

    it('leaves a slot it was not sent alone, so a stale save cannot undo another’s pick', async () => {
        const scenario = await startScenario(SERVER_SLOTS);
        const own = scenario.guild.createCategory({ name: 'Verify Claimed' });
        const guild = scenario.discord.clientGuild(scenario.guild);
        await upsertTicketType({ guild, definition: verification, categories: { claimed: { discordId: own.id } } });

        // A tab opened before that save changes only the open slot.
        const result = await upsertTicketType({ guild, definition: verification, categories: { open: { name: 'Verification' } } });

        expect(result.ok).toBe(true);
        const saved = (await stored(scenario.guild.id)).typeCategories.get('verification');
        expect(saved?.claimed).toEqual({ name: 'Verify Claimed', discordId: own.id, provenance: 'adopted' });
        expect(saved?.open).toMatchObject({ name: 'Verification', provenance: 'created' });
    });

    it('checks the type before making anything, so a refused type makes no category', async () => {
        const scenario = await startScenario(SERVER_SLOTS);

        const result = await upsertTicketType({
            guild: scenario.discord.clientGuild(scenario.guild),
            definition: { ...verification, nameTemplate: 'V{{user}}' },
            categories: { open: { name: 'Verification' }, claimed: null, closed: null },
        });

        expect(result).toMatchObject({ ok: false, reason: 'invalid-input' });
        expect(categoryCreates(scenario.discord)).toEqual([]);
    });

    it('names the type in a refusal about its category', async () => {
        const scenario = await startScenario(SERVER_SLOTS);
        const lobby = scenario.guild.createCategory({ name: 'Lobby' });
        await journeyHolding(scenario.guild.id, { key: 'onboarding', name: 'Onboarding' }, lobby.id);

        const result = await upsertTicketType({
            guild: scenario.discord.clientGuild(scenario.guild),
            definition: verification,
            categories: { open: { discordId: lobby.id }, claimed: null, closed: null },
        });

        expect(result.ok ? '' : result.message).toBe(
            '"Lobby" (picked for "Verification" open tickets) belongs to journey "Onboarding", so tickets can\'t use it. Pick another category, or type a name to have one made.'
        );
        expect(await stored(scenario.guild.id)).not.toHaveProperty(['ticketTypes', 'verification']);
    });

    it('is refused while the settings save is creating, sharing its lock', async () => {
        const scenario = await startScenario(SERVER_SLOTS);
        const guild = scenario.discord.clientGuild(scenario.guild);

        const [settings, type] = await Promise.all([
            setTicketSettings({
                guild,
                categories: { open: { name: 'New Tickets' }, claimed: null, closed: null },
                moderationRoles: [scenario.moderatorRoleId],
            }),
            upsertTicketType({
                guild,
                definition: verification,
                categories: { open: { name: 'Verification' }, claimed: null, closed: null },
            }),
        ]);

        expect(settings.ok).toBe(true);
        expect(type).toMatchObject({ ok: false, reason: 'busy' });
        expect(categoryCreates(scenario.discord)).toHaveLength(1);
    });
});
