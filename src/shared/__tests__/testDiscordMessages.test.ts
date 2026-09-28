import {
    ChannelType,
    Client,
    DiscordAPIError,
    EmbedBuilder,
    EmbedType,
    Events,
    GatewayIntentBits,
    MessageType,
    RESTJSONErrorCodes,
    Status,
    type Guild,
    type Message,
    type PartialMessage,
    type TextChannel,
} from 'discord.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
    TestDiscord,
    TestDiscordError,
    type ServerChannel,
    type ServerGuild,
    type ServerMember,
} from './support/testDiscord';

/**
 * TestDiscord's message routes, proven: send, fetch, edit and pin, plus the channel read
 * product code uses to find out a channel is gone.
 *
 * Each test answers one of two questions — does the harness answer the way Discord does,
 * and does it refuse what it cannot know — because a message route that answered a
 * guess would pass every ticket test that leaned on it. The last group asks the same of
 * the message events Discord sends a client that asked for them, checked against what
 * that client's cache ends up holding.
 */

/** What a client needs to be sent MESSAGE_CREATE and MESSAGE_UPDATE in a guild. */
const MESSAGE_EVENT_INTENTS: readonly GatewayIntentBits[] = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];

const started: TestDiscord[] = [];

afterEach(async () => {
    for (const discord of started.splice(0)) await discord.destroy();
});

interface StartedChannel {
    readonly discord: TestDiscord;
    readonly guild: ServerGuild;
    readonly channel: ServerChannel;
    readonly member: ServerMember;
    readonly liveGuild: Guild;
    readonly liveChannel: TextChannel;
}

async function startedChannel(): Promise<StartedChannel> {
    const discord = new TestDiscord();
    started.push(discord);

    const guild = discord.createGuild({ bot: { permissions: ['ManageChannels', 'ManageRoles'] } });
    const channel = guild.createTextChannel({ name: 'dungeon-rules' });
    const member = guild.createMember({ username: 'rope_bunny' });
    await discord.start();
    const liveGuild = discord.clientGuild(guild);
    const liveChannel = liveGuild.channels.cache.get(channel.id);
    if (liveChannel?.type !== ChannelType.GuildText) throw new Error('The client holds no text channel for the fixture.');
    return { discord, guild, channel, member, liveGuild, liveChannel };
}

describe('TestDiscord answers message writes the way Discord does', () => {
    it('stores a sent message, answers with the members Discord adds, and moves last_message_id', async () => {
        const { channel, member, liveGuild, liveChannel } = await startedChannel();

        const sent = await liveChannel.send({
            content: `<@${member.id}> read the pinned rules before you kneel.`,
            embeds: [new EmbedBuilder().setTitle('House rules').setColor(0xff0000)],
            allowedMentions: { parse: ['users'] },
        });

        expect(channel.messages).toEqual([
            {
                id: sent.id,
                type: MessageType.Default,
                authorId: liveGuild.client.user.id,
                content: `<@${member.id}> read the pinned rules before you kneel.`,
                embeds: [{ title: 'House rules', color: 0xff0000, type: EmbedType.Rich }],
                components: [],
                pinned: false,
                edited: false,
                referencedMessageId: null,
            },
        ]);
        // The reply is what discord.js builds its `Message` from, mentions included.
        expect(sent.mentions.users.map((user) => user.id)).toEqual([member.id]);
        // Nothing announced it: the harness client does not hold the GuildMessages intent.
        const refetched = await liveGuild.channels.fetch(channel.id, { force: true });
        expect(refetched?.isTextBased() ? refetched.lastMessageId : null).toBe(sent.id);
    });

    it("replaces what an edit names, leaves the rest, and marks the message edited", async () => {
        const { channel, liveChannel } = await startedChannel();
        const sent = await liveChannel.send({ content: 'Safeword is red.', embeds: [new EmbedBuilder().setTitle('Before')] });

        const edited = await sent.edit({ embeds: [new EmbedBuilder().setTitle('After')] });

        const held = channel.message(sent.id);
        expect(held.content).toBe('Safeword is red.');
        expect(held.embeds).toEqual([{ title: 'After', type: EmbedType.Rich }]);
        expect(held.edited).toBe(true);
        expect(edited.editedTimestamp).not.toBeNull();
    });

    it('answers a fetch past the cache, and 10008 for a message it does not hold', async () => {
        const { liveChannel } = await startedChannel();
        const sent = await liveChannel.send({ content: 'Aftercare snacks are in the kitchen.' });

        const fetched = await liveChannel.messages.fetch({ message: sent.id, force: true });
        const missing = await liveChannel.messages
            .fetch({ message: '100000000000000999', force: true })
            .catch((caught: unknown) => caught);

        expect(fetched.content).toBe('Aftercare snacks are in the kitchen.');
        expect(missing).toBeInstanceOf(DiscordAPIError);
        expect(missing).toMatchObject({ code: RESTJSONErrorCodes.UnknownMessage, status: 404 });
    });

    it('answers a channel fetch for a deleted channel with 10003', async () => {
        const { channel, liveGuild } = await startedChannel();

        channel.delete();
        const missing = await liveGuild.channels.fetch(channel.id).catch((caught: unknown) => caught);

        expect(missing).toBeInstanceOf(DiscordAPIError);
        expect(missing).toMatchObject({ code: RESTJSONErrorCodes.UnknownChannel, status: 404 });
    });

    it('pins with a system notice, and holds CHANNEL_PINS_UPDATE back until the gateway is flushed', async () => {
        const { discord, channel, liveChannel } = await startedChannel();
        const sent = await liveChannel.send({ content: 'Consent is sexy. Ask first.' });

        await sent.pin();

        const [pinned, notice] = channel.messages;
        expect(pinned).toMatchObject({ id: sent.id, pinned: true });
        expect(notice).toMatchObject({ type: MessageType.ChannelPinnedMessage, referencedMessageId: sent.id });
        // Never set: the fixture channel was created before any pin, and nothing has told the client since.
        expect(liveChannel.lastPinTimestamp ?? null).toBeNull();

        discord.flushGateway();

        // The gateway's self-check has already held the value to the event's; this is that it arrived.
        expect(liveChannel.lastPinTimestamp).toEqual(expect.any(Number));
    });

    it('refuses a message write on a channel told to reject writes, and still answers a read of it', async () => {
        const { discord, channel, liveGuild, liveChannel } = await startedChannel();
        channel.rejectWrites({ code: RESTJSONErrorCodes.MissingPermissions });

        const refused = await liveChannel.send({ content: 'Nobody hears this.' }).catch((caught: unknown) => caught);
        const read = await liveGuild.channels.fetch(channel.id, { force: true });

        expect(refused).toMatchObject({ code: RESTJSONErrorCodes.MissingPermissions, status: 403 });
        expect(read?.id).toBe(channel.id);
        expect(channel.messages).toEqual([]);
        expect(discord.faults).toEqual([]);
    });
});

describe('TestDiscord refuses message behaviour it does not know', () => {
    it('refuses role and @everyone mentions, and a user mention allowed_mentions suppresses', async () => {
        const { discord, member, liveChannel } = await startedChannel();

        await expect(liveChannel.send({ content: '@everyone play party tonight' })).rejects.toThrow(/role, @everyone or @here/);
        await expect(
            liveChannel.send({ content: `<@${member.id}> shh`, allowedMentions: { parse: [] } })
        ).rejects.toThrow(/suppressing users/);
        await expect(discord.destroy()).rejects.toThrow(/faulted 2 time/);
    });

    it('refuses a second pin of the same message, and listing pins through the single-message route', async () => {
        const { discord, liveChannel } = await startedChannel();
        const sent = await liveChannel.send({ content: 'Pinned once, pinned forever.' });
        await sent.pin();

        await expect(liveChannel.messages.pin(sent.id)).rejects.toThrow(/already pinned/);
        await expect(liveChannel.messages.fetch({ message: 'pins', force: true })).rejects.toThrow(
            /does not name a message/
        );
        await expect(discord.destroy()).rejects.toThrow(TestDiscordError);
    });

    it('refuses an edit replacing the content of a message that mentions somebody', async () => {
        const { discord, member, liveChannel } = await startedChannel();
        const sent = await liveChannel.send({ content: `<@${member.id}> kneel.`, allowedMentions: { parse: ['users'] } });

        await expect(sent.edit({ content: 'Never mind.' })).rejects.toThrow(/replacing the content/);
        await expect(discord.destroy()).rejects.toThrow(/faulted 1 time/);
    });
});

type HeardUpdate = readonly [before: Message | PartialMessage, after: Message];

interface HeardChannel extends StartedChannel {
    /** Every MESSAGE_CREATE the client applied, as `Events.MessageCreate` handed it over. */
    readonly created: Message[];
    readonly updated: HeardUpdate[];
}

/** A started guild driving a client built with exactly these intents, plus every message event it hears. */
async function channelHeardBy(intents: readonly GatewayIntentBits[]): Promise<HeardChannel> {
    const discord = new TestDiscord();
    started.push(discord);
    const guild = discord.createGuild();
    const channel = guild.createTextChannel({ name: 'voyeurs-corner' });
    const member = guild.createMember({ username: 'rope_bunny' });
    const client = await discord.start({ client: new Client({ intents: [...intents] }) });
    const liveGuild = discord.clientGuild(guild);
    const liveChannel = liveGuild.channels.cache.get(channel.id);
    if (liveChannel?.type !== ChannelType.GuildText) throw new Error('The client holds no text channel for the fixture.');

    const created: Message[] = [];
    const updated: HeardUpdate[] = [];
    client.on(Events.MessageCreate, (message) => created.push(message));
    client.on(Events.MessageUpdate, (before, after) => updated.push([before, after]));
    return { discord, guild, channel, member, liveGuild, liveChannel, created, updated };
}

describe('TestDiscord dispatches message events to a client that asked for them', () => {
    it('announces a send as MESSAGE_CREATE once the gateway is flushed', async () => {
        const { discord, liveChannel, created } = await channelHeardBy(MESSAGE_EVENT_INTENTS);

        const sent = await liveChannel.send({ content: 'Watching is a kink too.' });
        // Held like every event a REST write causes.
        expect(created).toEqual([]);

        discord.flushGateway();

        expect(created.map((message) => message.id)).toEqual([sent.id]);
        expect(liveChannel.messages.cache.get(sent.id)?.content).toBe('Watching is a kink too.');
        expect(liveChannel.lastMessageId).toBe(sent.id);
    });

    it('carries the author and each mentioned user as guild members, which discord.js caches from the event', async () => {
        const { discord, member, liveGuild, liveChannel } = await channelHeardBy(MESSAGE_EVENT_INTENTS);
        const botId = liveChannel.client.user.id;
        // `@everyone` plus the integration role — which only the event's `member.roles` can bring back.
        const botRoleIds = [...(liveGuild.members.me?.roles.cache.keys() ?? [])].sort();
        expect(botRoleIds).toHaveLength(2);
        const sent = await liveChannel.send({
            content: `<@${member.id}> on your knees.`,
            allowedMentions: { parse: ['users'] },
        });
        // discord.js reads the event's members only when it builds the message from the
        // event, and it caches members from elsewhere too — so forget all three first,
        // leaving the event as the only place they can come back from.
        liveChannel.messages.cache.delete(sent.id);
        liveGuild.members.cache.delete(botId);
        liveGuild.members.cache.delete(member.id);

        discord.flushGateway();

        const rebuilt = liveChannel.messages.cache.get(sent.id);
        expect(rebuilt?.guildId).toBe(liveGuild.id);
        expect([...(liveGuild.members.cache.get(botId)?.roles.cache.keys() ?? [])].sort()).toEqual(botRoleIds);
        expect(liveGuild.members.cache.has(member.id)).toBe(true);
        expect(rebuilt?.mentions.members?.map((mentioned) => mentioned.id)).toEqual([member.id]);
    });

    it("announces an edit as MESSAGE_UPDATE, which is what brings the client's cached message up to date", async () => {
        const { discord, liveChannel, updated } = await channelHeardBy(MESSAGE_EVENT_INTENTS);
        const sent = await liveChannel.send({ content: 'Safeword is red.' });
        discord.flushGateway();

        await sent.edit({ content: 'Safeword is red. Yellow means slow down.' });
        // discord.js answers an edit with a patched copy and leaves its cache alone.
        expect(liveChannel.messages.cache.get(sent.id)?.content).toBe('Safeword is red.');

        discord.flushGateway();

        expect(updated.map(([before, after]) => [before.content, after.content])).toEqual([
            ['Safeword is red.', 'Safeword is red. Yellow means slow down.'],
        ]);
        const cached = liveChannel.messages.cache.get(sent.id);
        expect(cached?.content).toBe('Safeword is red. Yellow means slow down.');
        expect(cached?.editedTimestamp).toEqual(expect.any(Number));
    });

    it('announces a pin as MESSAGE_UPDATE of the pinned message and MESSAGE_CREATE of the notice', async () => {
        const { discord, liveChannel, created, updated } = await channelHeardBy(MESSAGE_EVENT_INTENTS);
        const sent = await liveChannel.send({ content: 'Consent is sexy. Ask first.' });
        discord.flushGateway();

        await sent.pin();
        discord.flushGateway();

        expect(updated.map(([, after]) => [after.id, after.pinned])).toEqual([[sent.id, true]]);
        expect(created.map((message) => message.type)).toEqual([MessageType.Default, MessageType.ChannelPinnedMessage]);
        expect(liveChannel.messages.cache.get(sent.id)?.pinned).toBe(true);
    });

    it('throws when a MESSAGE_CREATE or MESSAGE_UPDATE does not reach the client, instead of passing silently', async () => {
        const { discord, liveChannel } = await channelHeardBy(MESSAGE_EVENT_INTENTS);
        const { ws } = liveChannel.client;
        const sent = await liveChannel.send({ content: 'Seen by everyone but the client.' });

        // The trap the self-check exists for: discord.js queues both without error while not Ready.
        ws.status = Status.Idle;
        try {
            expect(() => discord.flushGateway()).toThrow(/MESSAGE_CREATE but the client's cache does not reflect it/);
        } finally {
            ws.status = Status.Ready;
        }

        await sent.edit({ content: 'Edited where the client cannot see.' });
        ws.status = Status.Idle;
        try {
            expect(() => discord.flushGateway()).toThrow(/MESSAGE_UPDATE but the client's cache does not reflect it/);
        } finally {
            ws.status = Status.Ready;
        }
    });

    it('throws on a queued MESSAGE_CREATE even when the cache already looks as if it applied', async () => {
        const { discord, channel, liveGuild, liveChannel } = await channelHeardBy(MESSAGE_EVENT_INTENTS);
        const { ws } = liveChannel.client;
        const sent = await liveChannel.send({ content: 'Already the last word.' });
        // A channel refresh reads `last_message_id` off Discord, so the one thing the cache
        // check looks at agrees before the event has done anything.
        await liveGuild.channels.fetch(channel.id, { force: true });
        expect(liveChannel.lastMessageId).toBe(sent.id);

        ws.status = Status.Idle;
        try {
            expect(() => discord.flushGateway()).toThrow(/MESSAGE_CREATE .*queued the dispatch/);
        } finally {
            ws.status = Status.Ready;
        }
    });

    it('holds an update to its edit time only when it carries one, as discord.js does', async () => {
        const { discord, liveChannel } = await channelHeardBy(MESSAGE_EVENT_INTENTS);
        const sent = await liveChannel.send({ content: 'Pin me, then change me.' });
        discord.flushGateway();

        // The pin's MESSAGE_UPDATE carries no edit time; the edit's does. A fetch before
        // either arrives teaches the client the edit first, and discord.js then keeps that
        // edit time through the pin's update rather than clearing it.
        await sent.pin();
        await sent.edit({ content: 'Pinned and changed.' });
        await liveChannel.messages.fetch({ message: sent.id, force: true });

        expect(() => discord.flushGateway()).not.toThrow();
        expect(liveChannel.messages.cache.get(sent.id)).toMatchObject({ content: 'Pinned and changed.', pinned: true });
    });

    it('dispatches no message event to a client without the GuildMessages intent', async () => {
        const { discord, liveChannel, created, updated } = await channelHeardBy([GatewayIntentBits.Guilds]);

        const sent = await liveChannel.send({ content: 'Nobody is watching. Or are they?' });
        await sent.edit({ content: 'Nobody is watching.' });
        await sent.pin();
        discord.flushGateway();

        expect(created).toEqual([]);
        expect(updated).toEqual([]);
        // The REST reply cached it, and nothing since has touched that copy.
        expect(liveChannel.messages.cache.get(sent.id)?.content).toBe('Nobody is watching. Or are they?');
    });
});
