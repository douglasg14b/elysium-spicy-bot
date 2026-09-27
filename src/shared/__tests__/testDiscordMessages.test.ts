import {
    ChannelType,
    Client,
    DiscordAPIError,
    EmbedBuilder,
    EmbedType,
    GatewayIntentBits,
    MessageType,
    RESTJSONErrorCodes,
    type Guild,
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
 * guess would pass every ticket test that leaned on it.
 */

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

    it('faults every message write for a client that asked for message events', async () => {
        const discord = new TestDiscord();
        started.push(discord);
        const guild = discord.createGuild();
        const channel = guild.createTextChannel({ name: 'voyeurs-corner' });
        const client = await discord.start({
            client: new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] }),
        });
        const liveChannel = client.channels.cache.get(channel.id);
        if (liveChannel?.type !== ChannelType.GuildText) throw new Error('The client holds no text channel for the fixture.');

        await expect(liveChannel.send({ content: 'Watching is a kink too.' })).rejects.toThrow(/GuildMessages intent/);
        await expect(discord.destroy()).rejects.toThrow(TestDiscordError);
    });
});
