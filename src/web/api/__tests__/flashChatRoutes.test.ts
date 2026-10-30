import { ChannelType, PermissionsBitField } from 'discord.js';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/**
 * The flash chat API contract: what the routes decide (the channel check, the body's
 * bounds, the wire shape) over a mocked service. What a save or a removal does to the
 * running instance and the channel is `flashChatService.test.ts`'s.
 */

const mocks = vi.hoisted(() => ({
    listByGuild: vi.fn(),
    configure: vi.fn(),
    remove: vi.fn(),
    getInstance: vi.fn(),
}));

vi.mock('../../../features/flash-chat/data/flashChatRepo', () => ({
    flashChatRepo: { listByGuild: mocks.listByGuild },
}));
vi.mock('../../../features/flash-chat/flashChatService', () => ({
    flashChatService: { configure: mocks.configure, remove: mocks.remove },
}));
vi.mock('../../../features/flash-chat/flashChatManager', () => ({
    flashChatManager: { getInstance: mocks.getInstance },
}));

const { flashChatRoutes } = await import('../flashChatRoutes');

const GUILD_ID = 'guild-1';
const TEXT_CHANNEL = '111111111111111111';
const LOCKED_CHANNEL = '222222222222222222';
const VOICE_CHANNEL = '333333333333333333';
const GONE_CHANNEL = '444444444444444444';
const USER = { id: 'user-1', username: 'mod', avatar: null, manageableGuildIds: [GUILD_ID] };

const EVERYTHING = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
]);
const READ_ONLY = new PermissionsBitField([PermissionsBitField.Flags.ViewChannel]);

function guildStub() {
    const channel = (id: string, name: string, type: ChannelType, permissions: PermissionsBitField) => ({
        id,
        name,
        type,
        permissionsFor: () => permissions,
    });
    return {
        id: GUILD_ID,
        members: { me: { id: 'bot' } },
        channels: {
            cache: new Map([
                [TEXT_CHANNEL, channel(TEXT_CHANNEL, 'self-destruct', ChannelType.GuildText, EVERYTHING)],
                [LOCKED_CHANNEL, channel(LOCKED_CHANNEL, 'locked', ChannelType.GuildText, READ_ONLY)],
                [VOICE_CHANNEL, channel(VOICE_CHANNEL, 'moans', ChannelType.GuildVoice, EVERYTHING)],
            ]),
        },
    };
}

function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', guildStub() as never);
        c.set('user', USER);
        await next();
    });
    outer.route('/', flashChatRoutes());
    return outer;
}

function put(channelId: string, body: unknown) {
    return app().request(`/${GUILD_ID}/flash-chat/${channelId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function storedRow(channelId: string, timeoutSeconds = 300) {
    return {
        guildId: GUILD_ID,
        channelId,
        timeoutSeconds,
        preservePinned: true,
        preserveHistory: false,
        updatedByName: 'mod',
        updatedAt: new Date('2026-10-29T12:00:00.000Z'),
    };
}

const VALID = { timeoutSeconds: 300, preservePinned: true, preserveHistory: false };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getInstance.mockReturnValue(undefined);
});

describe('GET /:guildId/flash-chat', () => {
    it("lists each channel with its name, or null once it's gone, and whether it is running", async () => {
        mocks.listByGuild.mockResolvedValue([storedRow(TEXT_CHANNEL), storedRow(GONE_CHANNEL, 60)]);
        mocks.getInstance.mockImplementation((_guildId: string, channelId: string) =>
            channelId === TEXT_CHANNEL ? {} : undefined,
        );

        const response = await app().request(`/${GUILD_ID}/flash-chat`);

        expect(response.status).toBe(200);
        expect(mocks.listByGuild).toHaveBeenCalledWith(GUILD_ID);
        expect(await response.json()).toEqual({
            channels: [
                {
                    channelId: TEXT_CHANNEL,
                    channelName: 'self-destruct',
                    timeoutSeconds: 300,
                    preservePinned: true,
                    preserveHistory: false,
                    running: true,
                    updatedByName: 'mod',
                    updatedAt: '2026-10-29T12:00:00.000Z',
                },
                expect.objectContaining({ channelId: GONE_CHANNEL, channelName: null, running: false }),
            ],
        });
    });
});

describe('PUT /:guildId/flash-chat/:channelId', () => {
    it('saves through the service as the signed-in user and answers the saved channel', async () => {
        mocks.configure.mockResolvedValue(storedRow(TEXT_CHANNEL));
        mocks.getInstance.mockReturnValue({});

        const response = await put(TEXT_CHANNEL, VALID);

        expect(response.status).toBe(200);
        expect(mocks.configure).toHaveBeenCalledWith({
            channel: expect.objectContaining({ id: TEXT_CHANNEL }),
            settings: VALID,
            by: USER,
        });
        expect(await response.json()).toEqual(
            expect.objectContaining({ channelId: TEXT_CHANNEL, channelName: 'self-destruct', running: true }),
        );
    });

    it.each([
        ['a voice channel', VOICE_CHANNEL, 'Flash chat only works in a text channel in this server.'],
        ['a channel not in the server', GONE_CHANNEL, 'Flash chat only works in a text channel in this server.'],
        [
            'a channel the bot cannot delete in',
            LOCKED_CHANNEL,
            "I'm missing these permissions in #locked: Send Messages, Manage Messages, Read Message History.",
        ],
    ])('refuses %s before saving anything', async (_label, channelId, sentence) => {
        const response = await put(channelId, VALID);

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: sentence });
        expect(mocks.configure).not.toHaveBeenCalled();
    });

    it.each([
        [{ ...VALID, timeoutSeconds: 0 }, 'Give messages at least a second to live.'],
        [{ ...VALID, timeoutSeconds: 60 * 60 * 24 * 14 + 1 }, 'Fourteen days is the longest a message can wait to die.'],
        [{ ...VALID, timeoutSeconds: 1.5 }, 'A timer counts whole seconds.'],
    ])('refuses a timer out of bounds in its own words', async (body, sentence) => {
        const response = await put(TEXT_CHANNEL, body);

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: sentence });
        expect(mocks.configure).not.toHaveBeenCalled();
    });
});

describe('DELETE /:guildId/flash-chat/:channelId', () => {
    it('turns a channel off', async () => {
        mocks.remove.mockResolvedValue(storedRow(GONE_CHANNEL));

        const response = await app().request(`/${GUILD_ID}/flash-chat/${GONE_CHANNEL}`, { method: 'DELETE' });

        expect(response.status).toBe(204);
        expect(mocks.remove).toHaveBeenCalledWith(expect.objectContaining({ id: GUILD_ID }), GONE_CHANNEL);
    });

    it("answers 404 for a channel flash chat isn't on in", async () => {
        mocks.remove.mockResolvedValue(null);

        const response = await app().request(`/${GUILD_ID}/flash-chat/${TEXT_CHANNEL}`, { method: 'DELETE' });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "Flash chat isn't on in that channel." });
    });
});
