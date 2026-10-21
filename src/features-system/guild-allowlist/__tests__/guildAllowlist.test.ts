import { Client, GatewayIntentBits, Guild } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestDiscord } from '../../../shared/__tests__/support/testDiscord';
import { isGuildAllowed } from '../guildAllowlist';
import { leaveIfNotAllowed, watchGuildAllowlist } from '../initGuildAllowlist';

/**
 * The bot keeps to the servers in `ALLOWED_GUILD_IDS`. Leaving a server needs a re-invite
 * to undo, so the one thing that must never happen is the bot leaving a server it was
 * already in when it started — only a server that newly adds it is left.
 *
 * The wiring runs against real discord.js through TestDiscord, so "a new join" is
 * discord.js's own idea of one, not this test's. `Guild.prototype.leave` is spied rather
 * than sent: what is asserted is which guild the bot asked to leave.
 */

const started: TestDiscord[] = [];

afterEach(async () => {
    for (const discord of started.splice(0)) await discord.destroy();
    vi.restoreAllMocks();
});

/** Record every `guild.leave()` by guild id, answering without a request to Discord. */
function spyOnLeave(): { readonly leftGuildIds: string[] } {
    const leftGuildIds: string[] = [];
    vi.spyOn(Guild.prototype, 'leave').mockImplementation(function (this: Guild) {
        leftGuildIds.push(this.id);
        return Promise.resolve(this);
    });
    return { leftGuildIds };
}

/** A client watched by the allowlist and connected to `discord`, with the guilds created so far already in it. */
async function startWatched(discord: TestDiscord, allowedGuildIds: readonly string[]): Promise<Client<true>> {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    watchGuildAllowlist(client, allowedGuildIds);
    started.push(discord);
    return discord.start({ client });
}

describe('isGuildAllowed', () => {
    it('allows every guild when the list is empty', () => {
        expect(isGuildAllowed('900000000000000001', [])).toBe(true);
    });

    it('allows a listed guild and refuses any other', () => {
        expect(isGuildAllowed('900000000000000001', ['900000000000000001'])).toBe(true);
        expect(isGuildAllowed('900000000000000002', ['900000000000000001'])).toBe(false);
    });
});

describe('watchGuildAllowlist', () => {
    it('leaves nothing at startup, logging each unlisted server it is already in', async () => {
        const { leftGuildIds } = spyOnLeave();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const discord = new TestDiscord();
        const listed = discord.createGuild({ name: 'Brat Palace' });
        const unlisted = discord.createGuild({ name: 'Somebody Else’s Dungeon' });

        const client = await startWatched(discord, [listed.id]);

        expect(client.guilds.cache.has(unlisted.id)).toBe(true);
        expect(leftGuildIds).toEqual([]);
        const logged = warn.mock.calls.map(([line]) => String(line));
        expect(logged.filter((line) => line.includes(unlisted.id))).toHaveLength(1);
        expect(logged.some((line) => line.includes(listed.id))).toBe(false);
    });

    it('leaves a server that newly adds it and is not on the list', async () => {
        const { leftGuildIds } = spyOnLeave();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const discord = new TestDiscord();
        const listed = discord.createGuild();
        await startWatched(discord, [listed.id]);

        const stranger = discord.createGuild({ name: 'Random Public Server' });

        await vi.waitFor(() => expect(leftGuildIds).toEqual([stranger.id]));
    });

    it('leaves nothing when the list holds something that is not a guild id, and says so', async () => {
        const { leftGuildIds } = spyOnLeave();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const discord = new TestDiscord();
        const listed = discord.createGuild();
        await startWatched(discord, [listed.id, '"12345']);

        discord.createGuild({ name: 'Random Public Server' });
        await Promise.resolve();

        expect(leftGuildIds).toEqual([]);
        expect(error.mock.calls.map(([line]) => String(line)).some((line) => line.includes('"\\"12345"'))).toBe(true);
    });

    it('names a listed id the bot is not in, at ready', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const discord = new TestDiscord();
        const listed = discord.createGuild();
        const typo = '900000000000000099';

        await startWatched(discord, [listed.id, typo]);

        const logged = warn.mock.calls.map(([line]) => String(line));
        expect(logged.filter((line) => line.includes(typo))).toHaveLength(1);
        expect(logged.some((line) => line.includes(listed.id))).toBe(false);
    });

    it('watches nothing when the list is empty: every server stays', async () => {
        const { leftGuildIds } = spyOnLeave();
        const discord = new TestDiscord();
        discord.createGuild();
        await startWatched(discord, []);

        discord.createGuild();
        await Promise.resolve();

        expect(leftGuildIds).toEqual([]);
    });
});

describe('leaveIfNotAllowed', () => {
    it('stays in a listed server that newly adds it', async () => {
        const leave = vi.fn();

        await leaveIfNotAllowed({ id: '900000000000000001', name: 'Brat Palace', leave }, ['900000000000000001']);

        expect(leave).not.toHaveBeenCalled();
    });

    it('logs a failed leave rather than throwing into the gateway listener', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const leave = vi.fn().mockRejectedValue(new Error('Discord said no'));

        await expect(
            leaveIfNotAllowed({ id: '900000000000000002', name: 'Elsewhere', leave }, ['900000000000000001'])
        ).resolves.toBeUndefined();

        expect(leave).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledOnce();
    });
});
