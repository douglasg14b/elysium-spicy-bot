import { ChannelType } from 'discord.js';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/**
 * The chat agent config API contract: what the route decides — the body's rules, whether each
 * channel is a text channel of this guild the bot can read, and the wire shape. As in
 * `guildSettingsRoutes.test.ts`, a guild is injected directly and the repo is mocked; storage
 * is `chatAgentConfigRepo.test.ts`'s.
 */

const repoMock = {
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
};

const NO_TEXTS = { serverNotes: '', botRules: '' };

vi.mock('../../../features/chat-agent/data/chatAgentConfigRepo', () => ({
    chatAgentConfigRepo: repoMock,
    ChatAgentConfigRepo: class {},
}));

const { guildRoutes } = await import('../guildRoutes');

const GUILD_ID = 'guild-1';
const RULES = '100000000000000001';
const KINK_101 = '100000000000000002';
const LOCKED = '100000000000000003';
const VOICE = '100000000000000004';
const BOT_ID = 'bot';

function channel(id: string, name: string, type: ChannelType, botCanRead: boolean) {
    return { id, name, type, permissionsFor: () => ({ has: () => botCanRead }) };
}

function guildStub() {
    return {
        id: GUILD_ID,
        members: { me: { id: BOT_ID } },
        roles: { cache: new Map() },
        channels: {
            cache: new Map([
                [RULES, channel(RULES, 'rules', ChannelType.GuildText, true)],
                [KINK_101, channel(KINK_101, 'kink-101', ChannelType.GuildText, true)],
                [LOCKED, channel(LOCKED, 'mods-only', ChannelType.GuildText, false)],
                [VOICE, channel(VOICE, 'Lounge', ChannelType.GuildVoice, true)],
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
    repoMock.getConfig.mockResolvedValue({ contextChannels: [], ...NO_TEXTS });
    repoMock.saveConfig.mockImplementation((_guildId: string, config: unknown) => Promise.resolve(config));
});

describe('GET /:guildId/config/chat-agent', () => {
    it('reports an unconfigured guild as nothing set rather than 404', async () => {
        const response = await app().request(CONFIG_PATH);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ contextChannels: [], ...NO_TEXTS });
    });

    it("returns the admins' notes and rules as saved", async () => {
        repoMock.getConfig.mockResolvedValue({ contextChannels: [], serverNotes: 'Munches monthly.', botRules: 'No other servers.' });

        expect(await (await app().request(CONFIG_PATH)).json()).toEqual({
            contextChannels: [],
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
            ...NO_TEXTS,
        });

        const response = await app().request(CONFIG_PATH);

        expect(await response.json()).toEqual({
            contextChannels: [
                { channelId: RULES, isRules: true, channelName: 'rules' },
                { channelId: '199999999999999999', isRules: false, channelName: null },
            ],
            ...NO_TEXTS,
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
            serverNotes: 'Munches monthly.',
            botRules: 'No other servers.',
        });
    });

    it('accepts nothing set', async () => {
        const response = await putConfig({ contextChannels: [], ...NO_TEXTS });

        expect(response.status).toBe(200);
        expect(repoMock.saveConfig).toHaveBeenCalledWith(GUILD_ID, { contextChannels: [], ...NO_TEXTS });
    });

    it("refuses a body without the texts — the config is written whole", async () => {
        const response = await putConfig({ contextChannels: [] });

        expect(response.status).toBe(400);
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it("refuses notes or rules over 2,000 characters, with the schema's sentence", async () => {
        const tooLong = 'x'.repeat(2_001);
        for (const body of [{ contextChannels: [], serverNotes: tooLong, botRules: '' }, { contextChannels: [], serverNotes: '', botRules: tooLong }]) {
            const response = await putConfig(body);
            expect(response.status).toBe(400);
            expect(((await response.json()) as ErrorBody).error).toMatch(/^Keep the (notes|rules) to 2,000 characters/);
        }
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it('counts the limit on the trimmed text, so 2,000 characters with padding around them saves, trimmed', async () => {
        const response = await putConfig({ contextChannels: [], serverNotes: `\n${'x'.repeat(2_000)}  `, botRules: '' });

        expect(response.status).toBe(200);
        expect(repoMock.saveConfig).toHaveBeenCalledWith(GUILD_ID, { contextChannels: [], serverNotes: 'x'.repeat(2_000), botRules: '' });
    });

    it('refuses a channel that is not in this guild, storing nothing', async () => {
        const response = await putConfig({ contextChannels: [{ channelId: '199999999999999999', isRules: false }], ...NO_TEXTS });

        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorBody).error).toBe(
            "That's not a text channel on this server. Pick one from the list."
        );
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it('refuses a channel that is not a text channel', async () => {
        const response = await putConfig({ contextChannels: [{ channelId: VOICE, isRules: false }], ...NO_TEXTS });

        expect(response.status).toBe(400);
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it('refuses a channel the bot cannot read, naming it, even beside good ones', async () => {
        const response = await putConfig({
            contextChannels: [
                { channelId: RULES, isRules: true },
                { channelId: LOCKED, isRules: false },
            ],
            ...NO_TEXTS,
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
            ...NO_TEXTS,
        });

        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorBody).error).toBe('#rules is on the list twice. Once is plenty.');
        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });

    it("refuses more than ten channels, and an id that is not a snowflake, with the schema's sentences", async () => {
        const tooMany = Array.from({ length: 11 }, () => ({ channelId: RULES, isRules: false }));
        const overCap = await putConfig({ contextChannels: tooMany, ...NO_TEXTS });
        expect(overCap.status).toBe(400);
        expect(((await overCap.json()) as ErrorBody).error).toBe('10 context channels is my limit. Drop one.');

        const notAnId = await putConfig({ contextChannels: [{ channelId: 'rules', isRules: true }], ...NO_TEXTS });
        expect(notAnId.status).toBe(400);
        expect(((await notAnId.json()) as ErrorBody).error).toBe("That's not a channel id. Pick one from the list.");

        expect(repoMock.saveConfig).not.toHaveBeenCalled();
    });
});
