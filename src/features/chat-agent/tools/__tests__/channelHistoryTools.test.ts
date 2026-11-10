import { ChannelType, Collection, type Guild, type GuildMember, type GuildTextBasedChannel, type Message } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { HISTORY_PAGE_BUDGET, HISTORY_PAGE_SIZE, readChannelMessagesTool } from '../channelHistoryTools';
import { parseMessageLink } from '../channelReferences';
import type { ChatToolContext } from '../chatToolContext';
import type { Viewers } from '../visibleChannels';

const STAFF_ROLE = '300000000000000001';
const GUILD_ID = '100000000000000000';
const LOG_ID = '200000000000000001';
const SECRET_ID = '200000000000000002';

function fakeMessage(index: number): Message {
    return {
        id: `4000000000000${String(index).padStart(5, '0')}`,
        createdTimestamp: index,
        createdAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
        system: false,
        content: `message ${index}`,
        author: { id: 'vex', bot: false, displayName: 'Vex' },
        member: { displayName: 'Vex' },
        reference: null,
        mentions: { members: new Collection(), users: new Collection(), roles: new Collection(), repliedUser: null },
        attachments: new Collection(),
        embeds: [],
    } as unknown as Message;
}

/** `count` messages, newest first, as Discord hands them over. */
function page(count: number, from = 0): Collection<string, Message> {
    const messages = Array.from({ length: count }, (_unused, offset) => fakeMessage(from + count - offset));
    return new Collection(messages.map((message) => [message.id, message]));
}

function fakeChannel(id: string, name: string, seenBy: readonly string[], fetch: ReturnType<typeof vi.fn>) {
    return {
        id,
        name,
        type: ChannelType.GuildText,
        isTextBased: () => true,
        isThread: () => false,
        permissionsFor: (who: { id: string }) => ({ has: () => seenBy.includes(who.id) }),
        messages: { fetch },
    };
}

/** What a read answers, loosely: every arm has `found`, a page has the rest. */
type ReadAnswer = {
    readonly found: boolean;
    readonly messages?: readonly { readonly author: string; readonly at: string; readonly text: string; readonly linked?: true }[];
    readonly continueBefore?: string | null;
};

const THREAD_ID = '200000000000000003';

function setup(options: { askerRoles?: string[]; fetch?: ReturnType<typeof vi.fn>; channelsFetch?: ReturnType<typeof vi.fn> } = {}) {
    const fetch = options.fetch ?? vi.fn(async () => page(HISTORY_PAGE_SIZE));
    const me = { id: 'bot' };
    const guild = {
        id: GUILD_ID,
        ownerId: 'owner',
        memberCount: 1,
        members: { me, cache: { size: 1 } },
        channels: {
            cache: new Collection<string, unknown>([
                [LOG_ID, fakeChannel(LOG_ID, 'ticket-0042-vex', ['mod', 'bot'], fetch)],
                [SECRET_ID, fakeChannel(SECRET_ID, 'admin-only', ['bot'], fetch)],
            ]),
            fetch: options.channelsFetch ?? vi.fn(async () => null),
        },
    };
    const asker = {
        id: 'mod',
        guild,
        permissions: { has: () => false },
        roles: { cache: new Map((options.askerRoles ?? [STAFF_ROLE]).map((roleId) => [roleId, { id: roleId }])) },
    } as unknown as GuildMember;
    const viewers: Viewers = [asker];
    const context = {
        guild: guild as unknown as Guild,
        channel: { id: 'staff-room' } as unknown as GuildTextBasedChannel,
        asker,
        viewers,
        staffRoleIds: [STAFF_ROLE],
    } as unknown as ChatToolContext;
    const execute = readChannelMessagesTool(context).execute;
    if (!execute) throw new Error('readChannelMessages has no execute');
    const read = async (input: { channel: string; before?: string }): Promise<ReadAnswer> =>
        (await execute(input, { toolCallId: 'call-1', messages: [], context: undefined } as never)) as ReadAnswer;
    return { read, fetch, guild };
}

describe('parseMessageLink', () => {
    it("reads Discord's message and channel links, from any of its hosts", () => {
        expect(parseMessageLink(`https://discord.com/channels/${GUILD_ID}/${LOG_ID}/400000000000000007`)).toEqual({
            guildId: GUILD_ID,
            channelId: LOG_ID,
            messageId: '400000000000000007',
        });
        expect(parseMessageLink(`<https://ptb.discordapp.com/channels/${GUILD_ID}/${LOG_ID}>`)).toEqual({
            guildId: GUILD_ID,
            channelId: LOG_ID,
            messageId: null,
        });
        expect(parseMessageLink('#ticket-0042-vex')).toBeNull();
        expect(parseMessageLink(`https://evil.example/channels/${GUILD_ID}/${LOG_ID}`)).toBeNull();
    });
});

describe('readChannelMessages', () => {
    it('reads a page oldest first and says where to carry on from', async () => {
        const { read, fetch } = setup();
        const answer = await read({ channel: '#ticket-0042-vex' });

        expect(fetch).toHaveBeenCalledWith({ limit: HISTORY_PAGE_SIZE });
        expect(answer).toMatchObject({ found: true, channel: '#ticket-0042-vex', pagesLeft: HISTORY_PAGE_BUDGET - 1 });
        expect(answer.messages?.[0]).toMatchObject({ author: 'Vex', at: '2026-11-01T00:01Z', text: 'message 1' });
        expect(answer.continueBefore).toBe(fakeMessage(1).id);
    });

    it('pages further back from continueBefore, and says when the channel has no more', async () => {
        const { read, fetch } = setup({ fetch: vi.fn(async () => page(3)) });
        const answer = await read({ channel: '#ticket-0042-vex', before: '400000000000000009' });

        expect(fetch).toHaveBeenCalledWith({ limit: HISTORY_PAGE_SIZE, before: '400000000000000009' });
        expect(answer).toMatchObject({ found: true, continueBefore: null });
    });

    it('starts a link at its message, with the ones around it, and marks it', async () => {
        const { read, fetch } = setup({ fetch: vi.fn(async () => page(5)) });
        const linked = fakeMessage(3).id;
        const answer = await read({ channel: `https://discord.com/channels/${GUILD_ID}/${LOG_ID}/${linked}` });

        expect(fetch).toHaveBeenCalledWith({ around: linked, limit: HISTORY_PAGE_SIZE });
        expect(answer.messages?.find((message) => message.text === 'message 3')).toMatchObject({ linked: true });
        // Only two messages are older than the link: the channel starts there.
        expect(answer.continueBefore).toBeNull();
    });

    it("refuses a link to another server, and a channel not every reader can see, reading nothing", async () => {
        const { read, fetch } = setup();
        expect(await read({ channel: `https://discord.com/channels/999999999999999999/${LOG_ID}/1` })).toMatchObject({
            found: false,
            note: 'That link is to another server.',
        });
        expect(await read({ channel: '#admin-only' })).toMatchObject({ found: false });
        expect(await read({ channel: `https://discord.com/channels/${GUILD_ID}/${SECRET_ID}` })).toMatchObject({ found: false });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("refuses a member who isn't staff before reading anything", async () => {
        const { read, fetch } = setup({ askerRoles: [] });
        const answer = await read({ channel: '#ticket-0042-vex' });

        expect(answer).toMatchObject({ found: false, reason: 'Only staff can ask this.' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it(`stops after ${HISTORY_PAGE_BUDGET} pages in a turn`, async () => {
        const { read, fetch } = setup();
        for (let pageIndex = 0; pageIndex < HISTORY_PAGE_BUDGET; pageIndex += 1) await read({ channel: '#ticket-0042-vex' });
        const answer = await read({ channel: '#ticket-0042-vex' });

        expect(answer).toMatchObject({ found: false, note: expect.stringContaining('Answer with what you have') });
        expect(fetch).toHaveBeenCalledTimes(HISTORY_PAGE_BUDGET);
    });

    it('spends a page as its read starts, so calls made together cannot overrun the budget', async () => {
        const { read, fetch } = setup();
        await Promise.all(Array.from({ length: HISTORY_PAGE_BUDGET + 5 }, () => read({ channel: '#ticket-0042-vex' })));
        expect(fetch).toHaveBeenCalledTimes(HISTORY_PAGE_BUDGET);
    });

    it("reads a thread from a link though the bot hasn't seen it since starting, named under its channel", async () => {
        const fetch = vi.fn(async () => page(3));
        const channelsFetch = vi.fn(async () => thread);
        const { read, guild } = setup({ fetch, channelsFetch });
        const parent = guild.channels.cache.get(LOG_ID) as { name: string };
        const thread = { ...fakeChannel(THREAD_ID, 'the-damon-thing', ['mod', 'bot'], fetch), isThread: () => true, parent };

        const answer = await read({ channel: `https://discord.com/channels/${GUILD_ID}/${THREAD_ID}` });

        expect(channelsFetch).toHaveBeenCalledWith(THREAD_ID);
        expect(answer).toMatchObject({ found: true, channel: '#ticket-0042-vex', thread: 'the-damon-thing' });
    });

    it('answers "no channel" for one Discord says is gone or hidden from the bot, rather than its error', async () => {
        for (const code of [RESTJSONErrorCodes.UnknownChannel, RESTJSONErrorCodes.MissingAccess]) {
            const error = new DiscordAPIError({ code, message: 'nope' }, code, 404, 'GET', '/channels/x', {});
            const { read } = setup({ channelsFetch: vi.fn(async () => Promise.reject(error)) });
            expect(await read({ channel: `<#${THREAD_ID}>` })).toMatchObject({ found: false, note: expect.stringContaining('No channel matching') });
        }
    });
});
