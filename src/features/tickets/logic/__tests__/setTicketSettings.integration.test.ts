import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { up as createTicketingConfig } from '../../../../features-system/data-persistence/migrations/2025-11-10-Create_Ticketing_Config';
import { TestDiscord, type ServerGuild } from '../../../../shared/__tests__/support/testDiscord';
import type { TicketingConfig } from '../../data/ticketingSchema';

/**
 * Saving the dashboard's ticket settings, which can now create categories.
 *
 * Real discord.js against TestDiscord and a real `ticketing_config` row, so "was a
 * category made" is read from Discord's side and "was it recorded" from the database.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = new Kysely<any>({
    dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
    plugins: [new CamelCasePlugin(), new SqliteJsonPlugin({ ticketing_config: ['config'] })],
});
await createTicketingConfig(db);

vi.mock('../../../../features-system/data-persistence/database', () => ({
    get database() {
        return db;
    },
}));

const { setTicketSettings } = await import('../setTicketSettings');
const { ticketingRepo } = await import('../../data/ticketingRepo');

const running: TestDiscord[] = [];

beforeEach(async () => {
    await db.deleteFrom('ticketing_config').execute();
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

    const config: TicketingConfig = {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: 'panel-channel',
        modTicketsDeployedMessageId: 'panel-message',
        categories,
        moderationRoles: [moderator.id],
        ticketTypes: {},
    };
    await ticketingRepo.upsert({ guildId: guild.id, config: JSON.stringify(config), ticketNumberInc: 0, entityVersion: 1 });

    return { discord, guild, moderatorRoleId: moderator.id };
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
        await ticketingRepo.mutateConfig(scenario.guild.id, (row) => ({
            ...row.config,
            categories: { ...row.config.categories, open: { ...discordSide, discordId: category.id } },
        }));

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
