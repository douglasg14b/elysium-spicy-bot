import { ChannelType } from 'discord.js';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/**
 * The chat agent config API contract: what the route decides — the body's rules, whether each
 * channel is a text channel of this guild the bot can read, whether each newly added staff role
 * is a real role of it, and the wire shape. As in `guildSettingsRoutes.test.ts`, a guild is
 * injected directly and the repo is mocked; storage is `chatAgentConfigRepo.test.ts`'s.
 */

const repoMock = {
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
};

const introsChannelSaved = vi.fn();

/** Everything but the context channels, unset — as a body sends it and the repo holds it. */
const NOTHING_ELSE = { serverNotes: '', botRules: '', staffRoleIds: [], introsChannelId: null };
/** The same, as the GET answers it: with the names the ids resolve to. */
const NOTHING_ELSE_SENT = { ...NOTHING_ELSE, staffRoles: [], introsChannelName: null };

vi.mock('../../../features/chat-agent/data/chatAgentConfigRepo', () => ({
    chatAgentConfigRepo: repoMock,
    ChatAgentConfigRepo: class {},
}));
vi.mock('../../../features/chat-agent/intros/introsSync', () => ({ introsChannelSaved }));

const { guildRoutes } = await import('../guildRoutes');

const GUILD_ID = '100000000000000000';
const RULES = '100000000000000001';
const KINK_101 = '100000000000000002';
const LOCKED = '100000000000000003';
const VOICE = '100000000000000004';
const INTROS = '100000000000000005';
const MODERATOR = '300000000000000001';
const HELPER = '300000000000000002';
const BOT_ROLE = '300000000000000003';
const BOT_ID = 'bot';

function channel(id: string, name: string, type: ChannelType, botCanRead: boolean) {
    return { id, name, type, permissionsFor: () => ({ has: () => botCanRead }) };
}

function role(id: string, name: string, managed = false) {
    return { id, name, managed };
}

function guildStub() {
    return {
        id: GUILD_ID,
        members: { me: { id: BOT_ID } },
        roles: {
            cache: new Map([
                [GUILD_ID, role(GUILD_ID, '@everyone')],
                [MODERATOR, role(MODERATOR, 'Moderator')],
                [HELPER, role(HELPER, 'Helper')],
                [BOT_ROLE, role(BOT_ROLE, 'BrattyBot', true)],
            ]),
        },
        channels: {
            cache: new Map([
                [RULES, channel(RULES, 'rules', ChannelType.GuildText, true)],
                [KINK_101, channel(KINK_101, 'kink-101', ChannelType.GuildText, true)],
                [LOCKED, channel(LOCKED, 'mods-only', ChannelType.GuildText, false)],
                [VOICE, channel(VOICE, 'Lounge', ChannelType.GuildVoice, true)],
                [INTROS, channel(INTROS, 'introductions', ChannelType.GuildText, true)],
            ]),
        },
    };
}

function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', guildStub() as never);
        await next();
    });
    outer.route('/', guildRoutes());
    return outer;
}

const CONFIG_PATH = `/${GUILD_ID}/config/chat-agent`;

function putConfig(body: unknown) {
    return app().request(CONFIG_PATH, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

interface ErrorBody {
    error: string;
}

beforeEach(() => {
    vi.clearAllMocks();
    repoMock.getConfig.mockResolvedValue({ contextChannels: [], ...NOTHING_ELSE });
    repoMock.saveConfig.mockImplementation((_guildId: string, config: unknown) => Promise.resolve(config));
});

describe('GET /:guildId/config/chat-agent', () => {
    it('reports an unconfigured guild as nothing set rather than 404', async () => {
        const response = await app().request(CONFIG_PATH);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ contextChannels: [], ...NOTHING_ELSE_SENT });
    });

    it("returns the admins' notes and rules as saved", async () => {
        repoMock.getConfig.mockResolvedValue({ contextChannels: [], ...NOTHING_ELSE, serverNotes: 'Munches monthly.', botRules: 'No other servers.' });

        expect(await (await app().request(CONFIG_PATH)).json()).toEqual({
            contextChannels: [],
            ...NOTHING_ELSE_SENT,
            serverNotes: 'Munches monthly.',
            botRules: 'No other servers.',
        });
    });

    it('names each saved channel, and still reports one deleted since, nameless', async () => {
        repoMock.getConfig.mockResolvedValue({
            contextChannels: [
                { channelId: RULES, isRules: true },
                { channelId: '199999999999999999', isRules: false },
            ],
            ...NOTHING_ELSE,
        });

        const response = await app().request(CONFIG_PATH);

        expect(await response.json()).toEqual({
            contextChannels: [
                { channelId: RULES, isRules: true, channelName: 'rules' },
                { channelId: '199999999999999999', isRules: false, channelName: null },
            ],
            ...NOTHING_ELSE_SENT,
        });
    });

    it('reports the staff roles as saved, naming those that still exist, and the intros channel by name', async () => {
        repoMock.getConfig.mockResolvedValue({
            contextChannels: [],
            ...NOTHING_ELSE,
            staffRoleIds: [MODERATOR, '399999999999999999'],
            introsChannelId: INTROS,
        });

        expect(await (await app().request(CONFIG_PATH)).json()).toEqual({
            contextChannels: [],
            ...NOTHING_ELSE_SENT,
            staffRoleIds: [MODERATOR, '399999999999999999'],
            staffRoles: [{ id: MODERATOR, name: 'Moderator' }],
            introsChannelId: INTROS,
            introsChannelName: 'introductions',
        });
    });
});

describe('PUT /:guildId/config/chat-agent', () => {
    it('stores readable text channels in order, and the texts, and answers with the channels named', async () => {
        const config = {
            contextChannels: [
                { channelId: KINK_101, isRules: false },
                { channelId: RULES, isRules: true },
            ],
            ...NOTHING_ELSE,
            serverNotes: 'Munches monthly.',
            botRules: 'No other servers.',
        };

        const response = await putConfig(config);

        expect(response.status).toBe(200);
        expect(repoMock.saveConfig).toHaveBeenCalledWith(GUILD_ID, config);
        expect(await response.json()).toEqual({
            contextChannels: [
                { channelId: KINK_101, isRules: false, channelName: 'kink-101' },
                { channelId: RULES, isRules: true, channelName: 'rules' },
            ],
            ...NOTHING_ELSE_SENT,
            serverNotes: 'Munches monthly.',
            botRules: 'No other servers.',
        });
    });

    it('accepts nothing set', async () => {
        const response = await putConfig({ contextChannels: [], ...NOTHING_ELSE });

        expect(response.status).toBe(200);
        expect(repoMock.saveConfig).toHaveBeenCalledWith(GUILD_ID, { contextChannels: [], ...NOTHING_ELSE });
    });

    it('refuses a body without every field — the config is written whole', async () => {
        for (const missing of ['serverNotes', 'staffRoleIds', 'introsChannelId'] as const) {
            const body: Record<string, unknown> = { contextChannels: [], ...NOTHING_ELSE };
            delete body[missing];
            expect((await putConfig(body)).status).toBe(400);
        }
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it("refuses notes or rules over 2,000 characters, with the schema's sentence", async () => {
        const tooLong = 'x'.repeat(2_001);
        for (const body of [
            { contextChannels: [], ...NOTHING_ELSE, serverNotes: tooLong },
            { contextChannels: [], ...NOTHING_ELSE, botRules: tooLong },
        ]) {
            const response = await putConfig(body);
            expect(response.status).toBe(400);
            expect(((await response.json()) as ErrorBody).error).toMatch(/^Keep the (notes|rules) to 2,000 characters/);
        }
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it('counts the limit on the trimmed text, so 2,000 characters with padding around them saves, trimmed', async () => {
        const response = await putConfig({ contextChannels: [], ...NOTHING_ELSE, serverNotes: `\n${'x'.repeat(2_000)}  ` });

        expect(response.status).toBe(200);
        expect(repoMock.saveConfig).toHaveBeenCalledWith(GUILD_ID, { contextChannels: [], ...NOTHING_ELSE, serverNotes: 'x'.repeat(2_000) });
    });

    it('refuses a channel that is not in this guild, storing nothing', async () => {
        const response = await putConfig({ contextChannels: [{ channelId: '199999999999999999', isRules: false }], ...NOTHING_ELSE });

        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorBody).error).toBe(
            "That's not a text channel on this server. Pick one from the list."
        );
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it('refuses a channel that is not a text channel', async () => {
        const response = await putConfig({ contextChannels: [{ channelId: VOICE, isRules: false }], ...NOTHING_ELSE });

        expect(response.status).toBe(400);
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it('refuses a channel the bot cannot read, naming it, even beside good ones', async () => {
        const response = await putConfig({
            contextChannels: [
                { channelId: RULES, isRules: true },
                { channelId: LOCKED, isRules: false },
            ],
            ...NOTHING_ELSE,
        });

        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorBody).error).toBe(
            "I can't read #mods-only. Give me View Channel and Read Message History there first."
        );
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it('refuses a channel listed twice', async () => {
        const response = await putConfig({
            contextChannels: [
                { channelId: RULES, isRules: true },
                { channelId: RULES, isRules: false },
            ],
            ...NOTHING_ELSE,
        });

        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorBody).error).toBe('#rules is on the list twice. Once is plenty.');
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it("refuses more than ten channels, and an id that is not a snowflake, with the schema's sentences", async () => {
        const tooMany = Array.from({ length: 11 }, () => ({ channelId: RULES, isRules: false }));
        const overCap = await putConfig({ contextChannels: tooMany, ...NOTHING_ELSE });
        expect(overCap.status).toBe(400);
        expect(((await overCap.json()) as ErrorBody).error).toBe('10 context channels is my limit. Drop one.');

        const notAnId = await putConfig({ contextChannels: [{ channelId: 'rules', isRules: true }], ...NOTHING_ELSE });
        expect(notAnId.status).toBe(400);
        expect(((await notAnId.json()) as ErrorBody).error).toBe("That's not a channel id. Pick one from the list.");

        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it('stores staff roles once each, and names them in the answer', async () => {
        const response = await putConfig({ contextChannels: [], ...NOTHING_ELSE, staffRoleIds: [MODERATOR, HELPER, MODERATOR] });

        expect(response.status).toBe(200);
        expect(repoMock.saveConfig).toHaveBeenCalledWith(GUILD_ID, { contextChannels: [], ...NOTHING_ELSE, staffRoleIds: [MODERATOR, HELPER] });
        expect(((await response.json()) as { staffRoles: unknown }).staffRoles).toEqual([
            { id: MODERATOR, name: 'Moderator' },
            { id: HELPER, name: 'Helper' },
        ]);
    });

    it('refuses a newly added staff role that is @everyone, a bot-managed role or no role here, storing nothing', async () => {
        for (const roleId of [GUILD_ID, BOT_ROLE, '399999999999999999']) {
            const response = await putConfig({ contextChannels: [], ...NOTHING_ELSE, staffRoleIds: [MODERATOR, roleId] });
            expect(response.status).toBe(400);
            expect(((await response.json()) as ErrorBody).error).toMatch(/^These can't be the chat agent's staff roles: /);
        }
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it('keeps a staff role saved before and deleted since, so the page stays saveable', async () => {
        const deleted = '399999999999999999';
        repoMock.getConfig.mockResolvedValue({ contextChannels: [], ...NOTHING_ELSE, staffRoleIds: [deleted] });

        const response = await putConfig({ contextChannels: [], ...NOTHING_ELSE, staffRoleIds: [deleted, HELPER] });

        expect(response.status).toBe(200);
        expect(repoMock.saveConfig).toHaveBeenCalledWith(GUILD_ID, { contextChannels: [], ...NOTHING_ELSE, staffRoleIds: [deleted, HELPER] });
    });

    it('stores a readable intros channel and has the copy start reading it — only when it changed', async () => {
        const response = await putConfig({ contextChannels: [], ...NOTHING_ELSE, introsChannelId: INTROS });

        expect(response.status).toBe(200);
        expect(((await response.json()) as { introsChannelName: unknown }).introsChannelName).toBe('introductions');
        expect(introsChannelSaved).toHaveBeenCalledWith(expect.objectContaining({ id: GUILD_ID }), INTROS);

        introsChannelSaved.mockClear();
        repoMock.getConfig.mockResolvedValue({ contextChannels: [], ...NOTHING_ELSE, introsChannelId: INTROS });
        await putConfig({ contextChannels: [], ...NOTHING_ELSE, introsChannelId: INTROS, serverNotes: 'Munches monthly.' });
        expect(introsChannelSaved).not.toHaveBeenCalled();
    });

    it('refuses an intros channel the bot cannot read, or that is not a text channel, storing nothing', async () => {
        for (const [introsChannelId, error] of [
            [LOCKED, "I can't read #mods-only. Give me View Channel and Read Message History there first."],
            [VOICE, "That's not a text channel on this server. Pick one from the list."],
        ] as const) {
            const response = await putConfig({ contextChannels: [], ...NOTHING_ELSE, introsChannelId });
            expect(response.status).toBe(400);
            expect(((await response.json()) as ErrorBody).error).toBe(error);
        }
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
        expect(introsChannelSaved).not.toHaveBeenCalled();
    });

    it('keeps an intros channel saved before and deleted since, so the page stays saveable', async () => {
        const deleted = '199999999999999999';
        repoMock.getConfig.mockResolvedValue({ contextChannels: [], ...NOTHING_ELSE, introsChannelId: deleted });

        const response = await putConfig({ contextChannels: [], ...NOTHING_ELSE, introsChannelId: deleted, serverNotes: 'Munches monthly.' });

        expect(response.status).toBe(200);
        expect(((await response.json()) as { introsChannelName: unknown }).introsChannelName).toBeNull();
    });
});
