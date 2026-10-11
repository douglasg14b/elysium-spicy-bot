import { ChannelType } from 'discord.js';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/**
 * `GET /:guildId/channels` — the directory every channel picker draws from.
 *
 * **This route had no tests at all**, which is the fact that shaped this file. It was
 * safe to change freely while three browser call sites quietly changed behaviour, and
 * the helper it was built on (`textChannels`) was never exercised by anything.
 *
 * What it reports is now load-bearing in a way `{id, name}` never was. Categories are
 * in the list so they can be adopted, which means a consumer that must not offer one as
 * somewhere to post has to filter — and `type` is the only thing it can filter on. The
 * cases below pin the discriminator, the parent, and the exclusions, because getting
 * any of them wrong produces a config that fails in a live guild after publish rather
 * than at any point a test or a typecheck would notice.
 */

vi.mock('../../../features-system/guild-settings', () => ({
    guildSettingsRepo: { get: vi.fn(), upsert: vi.fn(), getStaffRoleIds: vi.fn() },
}));

vi.mock('../../../features/warnings/data/warningsConfigRepo', () => ({
    warningsConfigRepo: { get: vi.fn(), upsert: vi.fn() },
}));

vi.mock('../../../features/warnings/logic/setWarningsModChannel', () => ({
    setWarningsModChannel: vi.fn(),
}));

// Who holds what: the guild's bindings and its journeys' names, the directory's two reads.
const resourceBindingsRepoMock = { listByGuild: vi.fn() };
const journeysRepoMock = { listNamesByGuildId: vi.fn() };
vi.mock('../../../features/provisioning/data/resourceBindingsRepo', () => ({
    resourceBindingsRepo: resourceBindingsRepoMock,
}));
vi.mock('../../../features/provisioning/data/journeysRepo', () => ({ journeysRepo: journeysRepoMock }));

const { guildRoutes } = await import('../guildRoutes');

beforeEach(() => {
    resourceBindingsRepoMock.listByGuild.mockResolvedValue([]);
    journeysRepoMock.listNamesByGuildId.mockResolvedValue([]);
});

const GUILD_ID = 'guild-1';
const SUPPORT_CATEGORY = '200000000000000001';
const LOUNGE_CATEGORY = '200000000000000002';

interface ChannelStub {
    readonly id: string;
    readonly name: string;
    readonly type: ChannelType;
    readonly parentId: string | null;
}

/**
 * A guild whose channel cache holds one of everything that matters.
 *
 * Two channels named `general` under different categories is the motivating case — the
 * pair an operator could not tell apart — so it is the fixture rather than an extra.
 */
function channels(): ChannelStub[] {
    return [
        { id: SUPPORT_CATEGORY, name: 'Support', type: ChannelType.GuildCategory, parentId: null },
        { id: LOUNGE_CATEGORY, name: 'Lounge', type: ChannelType.GuildCategory, parentId: null },
        { id: '1', name: 'general', type: ChannelType.GuildText, parentId: SUPPORT_CATEGORY },
        { id: '2', name: 'general', type: ChannelType.GuildText, parentId: LOUNGE_CATEGORY },
        { id: '3', name: 'rules', type: ChannelType.GuildText, parentId: null },
        { id: '4', name: 'news', type: ChannelType.GuildAnnouncement, parentId: SUPPORT_CATEGORY },
        { id: '5', name: 'Voice Chat', type: ChannelType.GuildVoice, parentId: SUPPORT_CATEGORY },
        { id: '6', name: 'Stage', type: ChannelType.GuildStageVoice, parentId: null },
        { id: '7', name: 'help-forum', type: ChannelType.GuildForum, parentId: null },
    ];
}

interface RoleStub {
    readonly id: string;
    readonly name: string;
    readonly color: number;
    readonly position: number;
    readonly managed: boolean;
}

function app(stubs: readonly ChannelStub[] = channels(), roles: readonly RoleStub[] = []) {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set(
            'guild',
            {
                id: GUILD_ID,
                roles: { cache: new Map(roles.map((role) => [role.id, role])) },
                channels: { cache: new Map(stubs.map((stub) => [stub.id, stub])) },
            } as never
        );
        await next();
    });
    outer.route('/', guildRoutes());
    return outer;
}

interface ChannelRow {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly parentId: string | null;
    readonly parentName: string | null;
    readonly owner: { readonly kind: string; readonly key: string; readonly label: string } | null;
}

async function listChannels(stubs?: readonly ChannelStub[]): Promise<ChannelRow[]> {
    const response = await app(stubs).request(`/${GUILD_ID}/channels`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { channels: ChannelRow[] }).channels;
}

function byId(rows: readonly ChannelRow[], id: string): ChannelRow {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`No channel ${id} in the response`);
    return row;
}

describe('GET /:guildId/channels', () => {
    it('distinguishes two channels of the same name by their category', async () => {
        // The whole reason the shape was widened. These two rendered as two identical
        // `#general` rows; an operator picked one and learned later which.
        const rows = await listChannels();

        expect(byId(rows, '1').parentName).toBe('Support');
        expect(byId(rows, '2').parentName).toBe('Lounge');
    });

    it('reports a top-level channel as having no parent', async () => {
        const rules = byId(await listChannels(), '3');

        expect(rules.parentId).toBeNull();
        expect(rules.parentName).toBeNull();
    });

    it('carries the type discriminator every consumer filters on', async () => {
        const rows = await listChannels();

        expect(byId(rows, '1').type).toBe('text');
        expect(byId(rows, SUPPORT_CATEGORY).type).toBe('category');
    });

    it('includes categories, which it used to filter out', async () => {
        // They are here so a category declaration can be adopted at all. A consumer
        // that must not post in one filters on `type`.
        const rows = await listChannels();

        expect(rows.map((row) => row.id)).toContain(SUPPORT_CATEGORY);
    });

    /**
     * The regression this endpoint briefly shipped.
     *
     * An announcement channel was reported as its own type, which made the adoption
     * picker offer one — and `existsInGuildAs` accepts nothing but `GuildText`, so the
     * declaration passed every save-time check and threw in `requireAdoptable` partway
     * through the apply, with earlier resources already created.
     *
     * The point is not that an announcement channel is unusable: `actionSendMessage`
     * would post in one happily, because it asks `isTextBased()` rather than the type.
     * It is that **this endpoint is not where that disagreement gets settled**, and a
     * directory offering what provisioning rejects turns a validation failure into a
     * half-applied guild.
     */
    it('excludes announcement channels, which provisioning refuses to adopt', async () => {
        const ids = (await listChannels()).map((row) => row.id);

        expect(ids).not.toContain('4');
    });

    it('excludes voice, stage and forum channels', async () => {
        // Nothing in the product can target one, so labelling them would offer a
        // choice that cannot be honoured.
        const ids = (await listChannels()).map((row) => row.id);

        expect(ids).not.toContain('5');
        expect(ids).not.toContain('6');
        expect(ids).not.toContain('7');
    });

    it('never gives a category a parent', async () => {
        // A category holding a category cannot exist, and reporting one would read as
        // a nesting the product does not have.
        const support = byId(await listChannels(), SUPPORT_CATEGORY);

        expect(support.parentId).toBeNull();
        expect(support.parentName).toBeNull();
    });

    it('reports a null parent name when the parent is not in the cache', async () => {
        // A partially populated cache is a real state, and guessing a name would be
        // worse than admitting there is none.
        const rows = await listChannels([
            { id: '1', name: 'general', type: ChannelType.GuildText, parentId: 'missing-parent' },
        ]);

        expect(rows[0]!.parentId).toBe('missing-parent');
        expect(rows[0]!.parentName).toBeNull();
    });

    it('sorts by name, as it always did', async () => {
        const names = (await listChannels()).map((row) => row.name);

        expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
    });

    it('answers an empty guild with an empty list', async () => {
        expect(await listChannels([])).toEqual([]);
    });
});

describe('GET /:guildId/channels — who holds each channel', () => {
    function bindingRow(overrides: Record<string, unknown>) {
        return {
            id: 1,
            guildId: GUILD_ID,
            ownerKind: 'journey',
            ownerKey: 'onboarding',
            resourceKey: 'welcome',
            kind: 'textChannel',
            state: 'created',
            discordId: '3',
            name: 'rules',
            createdAt: new Date(),
            updatedAt: new Date(),
            ...overrides,
        };
    }

    it('names the ticket system on a category it holds, and a journey by its display name', async () => {
        resourceBindingsRepoMock.listByGuild.mockResolvedValue([
            bindingRow({ ownerKind: 'tickets', ownerKey: 'tickets', resourceKey: 'open', kind: 'category', discordId: SUPPORT_CATEGORY }),
            bindingRow({ discordId: '3' }),
        ]);
        journeysRepoMock.listNamesByGuildId.mockResolvedValue([{ journeyKey: 'onboarding', name: 'Onboarding' }]);

        const rows = await listChannels();

        expect(byId(rows, SUPPORT_CATEGORY).owner).toEqual({ kind: 'tickets', key: 'tickets', label: 'the ticket system' });
        expect(byId(rows, '3').owner).toEqual({ kind: 'journey', key: 'onboarding', label: 'journey "Onboarding"' });
        expect(byId(rows, LOUNGE_CATEGORY).owner).toBeNull();
    });

    it('names who holds a role too, so the role picker can agree with install', async () => {
        resourceBindingsRepoMock.listByGuild.mockResolvedValue([
            bindingRow({ ownerKey: 'appeals', resourceKey: 'approver', kind: 'role', discordId: 'role-held' }),
        ]);
        journeysRepoMock.listNamesByGuildId.mockResolvedValue([{ journeyKey: 'appeals', name: 'Appeals' }]);

        const response = await app([], [
            { id: 'role-held', name: 'Approver', color: 0, position: 2, managed: false },
            { id: 'role-free', name: 'Member', color: 0, position: 1, managed: false },
        ]).request(`/${GUILD_ID}/roles`);
        const { roles } = (await response.json()) as { roles: { id: string; owner: unknown }[] };

        expect(roles).toEqual([
            expect.objectContaining({ id: 'role-held', owner: { kind: 'journey', key: 'appeals', label: 'journey "Appeals"' } }),
            expect.objectContaining({ id: 'role-free', owner: null }),
        ]);
    });

    it('reports no owner for an object only an intent names', async () => {
        // An `intended` row has no id; it holds nothing yet.
        resourceBindingsRepoMock.listByGuild.mockResolvedValue([bindingRow({ state: 'intended', discordId: null })]);

        expect(byId(await listChannels(), '3').owner).toBeNull();
    });
});
