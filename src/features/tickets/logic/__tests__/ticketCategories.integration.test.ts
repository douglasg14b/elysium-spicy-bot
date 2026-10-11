import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { TestDiscord, type ServerChannel, type ServerGuild } from '../../../../shared/__tests__/support/testDiscord';
import { createTicketTestTables, seedTicketCategorySlots } from '../../__tests__/support/ticketTestTables';
import type { ConfiguredTicketingConfig } from '../../data/ticketingSchema';

/**
 * Issue #22 at runtime: a category slot resolves by id, and only Discord's own
 * `Unknown Channel` makes the bot create a replacement.
 *
 * Real discord.js against TestDiscord, and a real `ticketing_config` row with real slot
 * rows in `resource_bindings`, so the compare-and-set write and the cache-then-fetch
 * lookup are the production code paths. Every claim about what Discord holds is read
 * from a server-side handle or the request log, never from the client cache.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = new Kysely<any>({
    dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
    plugins: [new CamelCasePlugin(), new SqliteJsonPlugin({ ticketing_config: ['config'] })],
});
await createTicketTestTables(db);

vi.mock('../../../../features-system/data-persistence/database', () => ({
    get database() {
        return db;
    },
}));

const { resolveTicketCategory } = await import('../ticketCategories');
const { ticketingRepo } = await import('../../data/ticketingRepo');

interface Scenario {
    readonly discord: TestDiscord;
    readonly guild: ServerGuild;
    readonly open: ServerChannel;
    readonly claimed: ServerChannel;
    readonly closed: ServerChannel;
    readonly moderatorRoleId: string;
}

const running: TestDiscord[] = [];

beforeEach(async () => {
    await db.deleteFrom('ticketing_config').execute();
    await db.deleteFrom('resource_bindings').execute();
});

afterEach(async () => {
    vi.restoreAllMocks();
    for (const discord of running.splice(0)) await discord.destroy();
});

afterAll(async () => {
    await db.destroy();
});

/** Three real categories, bound in a real config row. `shareOpenAndClaimed` points two slots at one. */
async function startScenario(options: { readonly shareOpenAndClaimed?: boolean } = {}): Promise<Scenario> {
    const discord = new TestDiscord();
    running.push(discord);

    const guild = discord.createGuild({ bot: { permissions: ['ManageChannels', 'ViewChannel'] } });
    const moderator = guild.createRole({ name: 'Moderators' });
    const open = guild.createCategory({ name: 'Tickets' });
    const claimed = options.shareOpenAndClaimed ? open : guild.createCategory({ name: 'Claimed' });
    const closed = guild.createCategory({ name: 'Closed' });
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
    await seedTicketCategorySlots(guild.id, {
        open: { name: 'Tickets', discordId: open.id, provenance: 'adopted' },
        claimed: { name: claimed.name, discordId: claimed.id, provenance: 'adopted' },
        closed: { name: 'Closed', discordId: closed.id, provenance: 'created' },
    });

    return { discord, guild, open, claimed, closed, moderatorRoleId: moderator.id };
}

/** An operator re-picking the open slot on the dashboard, as a slot row write. */
async function repickOpen(guildId: string, discordId: string): Promise<void> {
    await seedTicketCategorySlots(guildId, { open: { name: 'Picked', discordId, provenance: 'adopted' } });
}

async function storedConfig(guildId: string): Promise<ConfiguredTicketingConfig> {
    const entity = await ticketingRepo.get(guildId);
    if (!entity) throw new Error('config row vanished');
    return entity.config as ConfiguredTicketingConfig;
}

function categoryCreates(discord: TestDiscord) {
    return discord.requests.filter(
        (request) =>
            request.method === 'POST' &&
            /^\/guilds\/\d+\/channels$/.test(request.path) &&
            (request.body as { type?: number }).type === 4
    );
}

describe('resolving a ticket category slot', () => {
    it('still finds a category that was renamed in Discord, and makes nothing new', async () => {
        const scenario = await startScenario();
        scenario.open.rename('Help Desk');

        const result = await resolveTicketCategory({
            guild: scenario.discord.clientGuild(scenario.guild),
            config: await storedConfig(scenario.guild.id),
            slot: 'open',
        });

        expect(result.ok && result.value.id).toBe(scenario.open.id);
        expect(categoryCreates(scenario.discord)).toEqual([]);
    });

    it('recreates a deleted category once, under its expected name, even with two tickets racing', async () => {
        const scenario = await startScenario({ shareOpenAndClaimed: true });
        scenario.open.delete();
        scenario.discord.flushGateway();

        const guild = scenario.discord.clientGuild(scenario.guild);
        const config = await storedConfig(scenario.guild.id);
        const [first, second] = await Promise.all([
            resolveTicketCategory({ guild, config, slot: 'open' }),
            resolveTicketCategory({ guild, config, slot: 'claimed' }),
        ]);

        expect(first.ok && second.ok).toBe(true);
        const recreatedId = first.ok ? first.value.id : '';
        expect(second.ok && second.value.id).toBe(recreatedId);

        // One category, on the server, with the expected name — not one per slot.
        expect(categoryCreates(scenario.discord)).toHaveLength(1);
        const recreated = scenario.guild.channel(recreatedId);
        expect(recreated.name).toBe('Tickets');
        expect(recreated.overwriteFor(scenario.guild.role(scenario.moderatorRoleId))).toBeDefined();

        // Both slots that shared the deleted category now point at the new one, as `created`.
        const saved = await storedConfig(scenario.guild.id);
        expect(saved.categories.open).toEqual({ name: 'Tickets', discordId: recreatedId, provenance: 'created' });
        expect(saved.categories.claimed).toEqual({ name: 'Tickets', discordId: recreatedId, provenance: 'created' });
        // The slot that was never deleted is untouched.
        expect(saved.categories.closed.discordId).toBe(scenario.closed.id);
    });

    it('repoints only the ticket rows on the deleted id, leaving a journey row on it alone', async () => {
        // Accepted in the plan: the journey's row stays dead, and its next install offers
        // the recreate. Repointing it would hand the journey a category the tickets made.
        const scenario = await startScenario({ shareOpenAndClaimed: true });
        const now = new Date().toISOString();
        await db
            .insertInto('resource_bindings')
            .values({
                guildId: scenario.guild.id,
                ownerKind: 'journey',
                ownerKey: 'onboarding',
                resourceKey: 'lobby',
                kind: 'category',
                state: 'created',
                discordId: scenario.open.id,
                name: 'Tickets',
                createdAt: now,
                updatedAt: now,
            })
            .execute();
        scenario.open.delete();
        scenario.discord.flushGateway();

        const result = await resolveTicketCategory({
            guild: scenario.discord.clientGuild(scenario.guild),
            config: await storedConfig(scenario.guild.id),
            slot: 'open',
        });
        const recreatedId = result.ok ? result.value.id : 'no category';

        const rows = await db
            .selectFrom('resource_bindings')
            .select(['ownerKind', 'resourceKey', 'state', 'discordId'])
            .where('guildId', '=', scenario.guild.id)
            .orderBy('ownerKind')
            .orderBy('resourceKey')
            .execute();
        expect(rows).toEqual([
            { ownerKind: 'journey', resourceKey: 'lobby', state: 'created', discordId: scenario.open.id },
            { ownerKind: 'tickets', resourceKey: 'claimed', state: 'created', discordId: recreatedId },
            { ownerKind: 'tickets', resourceKey: 'closed', state: 'created', discordId: scenario.closed.id },
            { ownerKind: 'tickets', resourceKey: 'open', state: 'created', discordId: recreatedId },
        ]);
    });

    it('does not recreate twice for a ticket that read the config before the first replacement was saved', async () => {
        // Not overlapping: the first recreate has finished and left the in-flight map
        // before the second caller — holding a config read earlier, as a ticket open does
        // across its member fetches and row writes — asks for the same deleted id.
        const scenario = await startScenario();
        scenario.open.delete();
        scenario.discord.flushGateway();

        const guild = scenario.discord.clientGuild(scenario.guild);
        const staleConfig = await storedConfig(scenario.guild.id);

        const first = await resolveTicketCategory({ guild, config: staleConfig, slot: 'open' });
        const second = await resolveTicketCategory({ guild, config: staleConfig, slot: 'open' });

        expect(first.ok && second.ok).toBe(true);
        expect(second.ok && second.value.id).toBe(first.ok ? first.value.id : 'no first');
        expect(categoryCreates(scenario.discord)).toHaveLength(1);
    });

    it('fails, and creates nothing, when Discord cannot be reached rather than saying the category is gone', async () => {
        const scenario = await startScenario();
        scenario.open.delete();
        scenario.discord.flushGateway();

        const guild = scenario.discord.clientGuild(scenario.guild);
        vi.spyOn(guild.channels, 'fetch').mockRejectedValueOnce(new Error('Request timed out'));

        const result = await resolveTicketCategory({
            guild,
            config: await storedConfig(scenario.guild.id),
            slot: 'open',
        });

        expect(result.ok).toBe(false);
        expect(result.ok ? '' : String(result.error)).toMatch(/Could not reach the open tickets category "Tickets"/);
        expect(categoryCreates(scenario.discord)).toEqual([]);
        expect((await storedConfig(scenario.guild.id)).categories.open.discordId).toBe(scenario.open.id);
    });

    it('follows an operator re-pick made after the ticket read the config, and makes nothing', async () => {
        const scenario = await startScenario();
        scenario.open.delete();
        scenario.discord.flushGateway();

        const guild = scenario.discord.clientGuild(scenario.guild);
        const staleConfig = await storedConfig(scenario.guild.id);

        const picked = scenario.guild.createCategory({ name: 'Picked' });
        await repickOpen(scenario.guild.id, picked.id);

        const result = await resolveTicketCategory({ guild, config: staleConfig, slot: 'open' });

        expect(result.ok && result.value.id).toBe(picked.id);
        expect(categoryCreates(scenario.discord)).toEqual([]);
    });

    it('deletes its replacement again when a re-pick lands between the re-read and the save', async () => {
        const scenario = await startScenario();
        scenario.open.delete();
        scenario.discord.flushGateway();

        const guild = scenario.discord.clientGuild(scenario.guild);
        const staleEntity = await ticketingRepo.get(scenario.guild.id);
        if (!staleEntity) throw new Error('no config row');

        const picked = scenario.guild.createCategory({ name: 'Picked' });
        await repickOpen(scenario.guild.id, picked.id);
        // The re-read still sees the deleted id: the re-pick has not committed yet from its
        // point of view, so the recreate goes ahead and its compare-and-set misses.
        vi.spyOn(ticketingRepo, 'get').mockResolvedValueOnce(staleEntity);

        const result = await resolveTicketCategory({
            guild,
            config: staleEntity.config as ConfiguredTicketingConfig,
            slot: 'open',
        });

        expect(result.ok).toBe(false);
        expect((await storedConfig(scenario.guild.id)).categories.open.discordId).toBe(picked.id);
        // The category it made was deleted again rather than left as an orphan.
        const [made] = categoryCreates(scenario.discord);
        expect(made).toBeDefined();
        const madeId = scenario.discord.requests.find(
            (request) => request.method === 'DELETE' && request.path.startsWith('/channels/')
        )?.path.split('/')[2];
        expect(madeId).toBeDefined();
        expect(madeId).not.toBe(picked.id);
        expect(() => scenario.guild.channel(madeId ?? '')).toThrow();
        expect(picked.exists).toBe(true);
    });
});
