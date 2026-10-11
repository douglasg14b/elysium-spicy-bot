import net from 'node:net';
import {
    ChannelType,
    DiscordAPIError,
    RESTJSONErrorCodes,
    Status,
    type Client,
    type Guild,
    type GuildBasedChannel,
    type TextChannel,
} from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    TestDiscord,
    TestDiscordError,
    type ServerChannel,
    type ServerGuild,
} from './support/testDiscord';

/**
 * The harness's own claims, proven.
 *
 * Every provisioning integration test rests on TestDiscord telling the truth about two
 * things: what Discord holds, and whether the client saw it. These tests are the ones
 * that would fail if either became a comfortable fiction — a gap answered with a plausible
 * default, or a dispatch discord.js quietly dropped.
 */

const started: TestDiscord[] = [];

afterEach(async () => {
    for (const discord of started.splice(0)) await discord.destroy();
});

interface StartedGuild {
    readonly discord: TestDiscord;
    readonly guild: ServerGuild;
    readonly category: ServerChannel;
    readonly channel: ServerChannel;
    readonly client: Client<true>;
    readonly liveGuild: Guild;
}

async function startedGuild(): Promise<StartedGuild> {
    const discord = new TestDiscord();
    started.push(discord);

    const guild = discord.createGuild({ bot: { permissions: ['ManageChannels', 'ManageRoles'] } });
    const category = guild.createCategory({ name: 'Lobby' });
    const channel = guild.createTextChannel({ name: 'general', parent: category });
    const client = await discord.start();
    return { discord, guild, category, channel, client, liveGuild: discord.clientGuild(guild) };
}

function cachedChannel(guild: Guild, channelId: string): GuildBasedChannel {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) throw new Error(`The client holds no channel ${channelId}.`);
    return channel;
}

function cachedTextChannel(guild: Guild, channelId: string): TextChannel {
    const channel = cachedChannel(guild, channelId);
    if (channel.type !== ChannelType.GuildText) throw new Error(`${channelId} is not a text channel.`);
    return channel;
}

describe('TestDiscord refuses what it does not model', () => {
    it('throws on a route it has no handler for, naming the method and path', async () => {
        const { discord, guild, liveGuild } = await startedGuild();

        await expect(liveGuild.setName('renamed-guild')).rejects.toThrow(
            `TestDiscord has no handler for PATCH /guilds/${guild.id}`
        );

        // Recorded as well as thrown, so a gap product code swallowed still fails the test.
        await expect(discord.destroy()).rejects.toThrow(/faulted 1 time/);
    });

    it('fails at destroy when product code swallows the gap', async () => {
        const { discord, liveGuild } = await startedGuild();

        await liveGuild.setName('renamed-guild').catch(() => undefined);

        await expect(discord.destroy()).rejects.toThrow(/no handler for PATCH/);
    });

    it('refuses to delete a category that still holds channels, rather than guessing at the orphaning', async () => {
        const { discord, category, liveGuild } = await startedGuild();

        await expect(cachedChannel(liveGuild, category.id).delete()).rejects.toThrow(/would orphan its channels/);
        expect(category.exists).toBe(true);
        await expect(discord.destroy()).rejects.toThrow(TestDiscordError);
    });

    it('throws on a body field its handler does not model', async () => {
        const { discord, channel, liveGuild } = await startedGuild();

        await expect(cachedTextChannel(liveGuild, channel.id).setTopic('not modelled')).rejects.toThrow(
            /does not model this request body/
        );
        await expect(discord.destroy()).rejects.toThrow(TestDiscordError);
    });

    it('refuses a channel created under a category with its overwrites omitted', async () => {
        const { discord, category, liveGuild } = await startedGuild();

        await expect(
            liveGuild.channels.create({ name: 'inherits', type: ChannelType.GuildText, parent: category.id })
        ).rejects.toThrow(/syncs the category's overwrites/);
        await expect(discord.destroy()).rejects.toThrow(TestDiscordError);
    });
});

describe('TestDiscord stores channel names the way Discord does', () => {
    it("lowercases a text channel's name and turns each space between words into a hyphen, on create and rename", async () => {
        const { guild, category, liveGuild } = await startedGuild();

        const created = await liveGuild.channels.create({
            name: 'Welcome Mat Now',
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: [],
        });
        expect(guild.channel(created.id).name).toBe('welcome-mat-now');
        expect(created.name).toBe('welcome-mat-now');

        await created.setName('Front Desk');
        expect(guild.channel(created.id).name).toBe('front-desk');
        expect(cachedChannel(liveGuild, created.id).name).toBe('front-desk');
    });

    it('refuses a text channel name whose whitespace Discord rewrites in a way nobody here has seen', async () => {
        const { discord, guild, channel, liveGuild } = await startedGuild();
        const liveChannel = cachedTextChannel(liveGuild, channel.id);

        for (const name of [' leading', 'trailing ', 'two  spaces', 'tab\there', 'no break']) {
            expect(() => guild.createTextChannel({ name })).toThrow(/whitespace Discord rewrites/);
        }
        await expect(liveChannel.setName('Upper  Case')).rejects.toThrow(/whitespace Discord rewrites/);
        expect(channel.name).toBe('general');
        await expect(discord.destroy()).rejects.toThrow(/faulted 1 time/);
    });

    it('stores an operator rename of a text channel rewritten too, and the client hears the stored name', async () => {
        const { channel, liveGuild } = await startedGuild();

        channel.rename('After Care');

        expect(channel.name).toBe('after-care');
        expect(cachedChannel(liveGuild, channel.id).name).toBe('after-care');
    });

    it("keeps a category's name exactly as sent", async () => {
        const { category, liveGuild } = await startedGuild();

        const created = await liveGuild.channels.create({ name: 'Tickets — Open', type: ChannelType.GuildCategory });
        await cachedChannel(liveGuild, category.id).setName('Play Rooms');

        expect(created.name).toBe('Tickets — Open');
        expect(category.name).toBe('Play Rooms');
    });
});

describe('TestDiscord keeps the client in step with the server', () => {
    it('applies an operator rename after start to the client cache', async () => {
        const { channel, liveGuild } = await startedGuild();

        channel.rename('renamed-by-hand');

        expect(channel.name).toBe('renamed-by-hand');
        expect(cachedChannel(liveGuild, channel.id).name).toBe('renamed-by-hand');
    });

    it('delivers a channel, role, member and guild created after start', async () => {
        const { discord, guild, category, client, liveGuild } = await startedGuild();

        const late = guild.createTextChannel({ name: 'late', parent: category });
        const role = guild.createRole({ name: 'Latecomer' });
        const member = guild.createMember({ username: 'alice', roles: [role] });
        const secondGuild = discord.createGuild();

        expect(cachedChannel(liveGuild, late.id).parentId).toBe(category.id);
        expect(liveGuild.roles.cache.get(role.id)?.name).toBe('Latecomer');
        expect(liveGuild.members.cache.get(member.id)?.roles.cache.has(role.id)).toBe(true);
        expect(client.guilds.cache.get(secondGuild.id)?.members.me?.id).toBe(client.user.id);
    });

    it('takes a message the bot posts into a thread, as Discord does', async () => {
        const discord = new TestDiscord();
        started.push(discord);
        const guild = discord.createGuild();
        const channel = guild.createTextChannel({ name: 'general' });
        const thread = guild.createThread({ parent: channel, name: 'aside' });
        const client = await discord.start();

        const liveThread = await client.channels.fetch(thread.id);
        if (!liveThread?.isThread()) throw new Error('The client holds no thread.');
        await liveThread.send({ content: 'psst', allowedMentions: { parse: [] } });

        expect(thread.messages.map((message) => [message.authorId, message.content])).toEqual([[client.user.id, 'psst']]);
        expect(channel.messages).toEqual([]);
    });

    it('holds back the event for a 204 permission write until the gateway is flushed', async () => {
        const { discord, guild, channel, liveGuild } = await startedGuild();
        const role = guild.createRole({ name: 'Staff' });
        const liveChannel = cachedTextChannel(liveGuild, channel.id);

        await liveChannel.permissionOverwrites.edit(role.id, { ViewChannel: false });

        // Discord holds it at once; the client learns of it only from the gateway event.
        expect(channel.overwriteFor(role)).toEqual({ id: role.id, type: 'role', allow: [], deny: ['ViewChannel'] });
        expect(liveChannel.permissionOverwrites.cache.has(role.id)).toBe(false);

        discord.flushGateway();

        expect(liveChannel.permissionOverwrites.cache.get(role.id)?.deny.toArray()).toEqual(['ViewChannel']);
    });

    it('removes a deleted channel from the client cache', async () => {
        const { channel, liveGuild } = await startedGuild();

        channel.delete();

        expect(channel.exists).toBe(false);
        expect(liveGuild.channels.cache.has(channel.id)).toBe(false);
    });

    it('deletes a channel the bot asks to delete, and the held CHANNEL_DELETE agrees', async () => {
        const { discord, category, channel, liveGuild } = await startedGuild();

        await cachedChannel(liveGuild, channel.id).delete('tidying up');
        // Children first, then the category, which is what lets the category go.
        await cachedChannel(liveGuild, category.id).delete('tidying up');
        discord.flushGateway();

        expect(channel.exists).toBe(false);
        expect(category.exists).toBe(false);
        expect(liveGuild.channels.cache.has(channel.id)).toBe(false);
        expect(discord.writesTo(channel)).toEqual([
            { method: 'DELETE', path: `/channels/${channel.id}`, body: undefined, status: 200 },
        ]);
    });

    it('throws when a dispatch does not reach the cache, instead of passing silently', async () => {
        const { channel, client, liveGuild } = await startedGuild();

        // The trap itself: discord.js queues CHANNEL_UPDATE without error while not Ready.
        client.ws.status = Status.Idle;
        try {
            expect(() => channel.rename('never-seen')).toThrow(/does not reflect it.*status is Idle/s);
            expect(cachedChannel(liveGuild, channel.id).name).toBe('general');
        } finally {
            client.ws.status = Status.Ready;
        }
    });
});

describe('TestDiscord failure injection', () => {
    it('surfaces an injected rejection as a real DiscordAPIError 50013 and changes nothing', async () => {
        const { discord, channel, liveGuild } = await startedGuild();
        channel.rejectWrites({ code: RESTJSONErrorCodes.MissingPermissions });

        const error = await cachedChannel(liveGuild, channel.id)
            .setName('refused')
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(DiscordAPIError);
        expect(error).toMatchObject({ code: RESTJSONErrorCodes.MissingPermissions, status: 403 });
        expect(channel.name).toBe('general');
        expect(discord.writesTo(channel)).toEqual([
            { method: 'PATCH', path: `/channels/${channel.id}`, body: { name: 'refused' }, status: 403 },
        ]);
    });

    it('can refuse one route while the rest still succeed', async () => {
        const { guild, channel, liveGuild } = await startedGuild();
        const role = guild.createRole({ name: 'Staff' });
        channel.rejectWrites({
            code: RESTJSONErrorCodes.MissingPermissions,
            route: 'PUT /channels/:channelId/permissions/:overwriteId',
        });
        const liveChannel = cachedTextChannel(liveGuild, channel.id);

        await liveChannel.setName('renamed-by-bot');
        await expect(liveChannel.permissionOverwrites.edit(role.id, { ViewChannel: false })).rejects.toBeInstanceOf(
            DiscordAPIError
        );

        expect(channel.name).toBe('renamed-by-bot');
        expect(channel.overwriteFor(role)).toBeUndefined();
    });

    it('still refuses an unmodelled request on a channel told to reject writes', async () => {
        const { discord, channel, liveGuild } = await startedGuild();
        channel.rejectWrites({ code: RESTJSONErrorCodes.MissingPermissions });
        const liveChannel = cachedTextChannel(liveGuild, channel.id);

        // A clean 403 here would let a new field, or a name the harness cannot store, pass unnoticed.
        await expect(liveChannel.setTopic('not modelled')).rejects.toBeInstanceOf(TestDiscordError);
        await expect(liveChannel.setName('Upper  Case')).rejects.toBeInstanceOf(TestDiscordError);
        await expect(discord.destroy()).rejects.toThrow(/faulted 2 time/);
    });
});

describe('TestDiscord stays offline', () => {
    it('answers every request itself and opens no socket', async () => {
        const connect = vi.spyOn(net.Socket.prototype, 'connect');
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        try {
            const { discord, guild, category, client, liveGuild } = await startedGuild();

            const role = await liveGuild.roles.create({ name: 'made-by-bot' });
            const created = await liveGuild.channels.create({
                name: 'made-by-bot',
                type: ChannelType.GuildText,
                parent: category.id,
                permissionOverwrites: [{ id: role.id, deny: ['ViewChannel'] }],
            });
            await created.setName('renamed-by-bot');
            await created.permissionOverwrites.edit(role.id, { ViewChannel: true });

            expect(guild.role(role.id).id).toBe(role.id);
            expect(guild.channel(created.id).name).toBe('renamed-by-bot');
            expect(discord.requests.map((request) => request.status)).toEqual([200, 201, 200, 204]);
            expect(connect).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
            // No gateway socket either: the client was never logged in.
            expect(client.ws.shards.size).toBe(0);
        } finally {
            connect.mockRestore();
            fetchSpy.mockRestore();
        }
    });
});
