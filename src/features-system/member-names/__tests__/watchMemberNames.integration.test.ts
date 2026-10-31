import { Events } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DISCORD_CLIENT } from '../../../discordClient';
import { TestDiscord, type ServerGuild, type ServerMember } from '../../../shared/__tests__/support/testDiscord';
import { database } from '../../data-persistence/database';
import { migrateTestDatabase } from '../../data-persistence/__tests__/support/migrateTestDatabase';
import { memberNamesRepo } from '../data/memberNamesRepo';
import { watchMemberNames } from '../initMemberNames';
import { memberNamesQueue } from '../memberNamesQueue';

/**
 * The startup sweep and the gateway listeners, driven through the bot's own `DISCORD_CLIENT`
 * against TestDiscord, onto an in-memory SQLite built by the real migrations — so the
 * client's real partials decide whether a leave arrives, and the rows are what sqlite
 * really hands back.
 *
 * One harness for the file: `DISCORD_CLIENT` is a singleton, and a discord.js client cannot
 * be handshaken again once destroyed. Each test brings its own member.
 */

const discord = new TestDiscord();
let guild: ServerGuild;
let unlisted: ServerGuild;
let alice: ServerMember;
let unlistedMember: ServerMember;

/** Somebody recorded as in the server whom the sweep will not find there. */
const GHOST_ID = '400000000000000099';

async function rowFor(guildId: string, userId: string) {
    const [row] = await memberNamesRepo.findByUserIds(guildId, [userId]);
    return row;
}

/** Wait for the listener's write to land, then return the row. */
async function eventually(guildId: string, userId: string, expected: Record<string, unknown>) {
    await vi.waitFor(async () => {
        expect(await rowFor(guildId, userId)).toMatchObject(expected);
    });
}

beforeAll(async () => {
    await migrateTestDatabase();
    guild = discord.createGuild();
    unlisted = discord.createGuild();
    alice = guild.createMember({ username: 'alice', globalName: 'Alice', nickname: 'Al' });
    unlistedMember = unlisted.createMember({ username: 'stranger' });
    await memberNamesRepo.recordPresent(guild.id, [
        { userId: GHOST_ID, username: 'ghost', globalName: null, nickname: 'Boo', isBot: false },
    ]);

    const client = await discord.start({ client: DISCORD_CLIENT });
    // Ready already, so the sweep starts here rather than on a ClientReady.
    watchMemberNames(client, [guild.id]);
    await eventually(guild.id, GHOST_ID, { inServer: false });
});

afterAll(async () => {
    DISCORD_CLIENT.removeAllListeners(Events.GuildMemberAdd);
    DISCORD_CLIENT.removeAllListeners(Events.GuildMemberUpdate);
    DISCORD_CLIENT.removeAllListeners(Events.GuildMemberRemove);
    DISCORD_CLIENT.removeAllListeners(Events.UserUpdate);
    DISCORD_CLIENT.removeAllListeners(Events.GuildCreate);
    DISCORD_CLIENT.removeAllListeners(Events.GuildAvailable);
    await discord.destroy();
});

describe('the startup sweep', () => {
    it("records every member of an allowed server, the bot included, with their names and nickname", async () => {
        expect(await rowFor(guild.id, alice.id)).toMatchObject({
            username: 'alice',
            globalName: 'Alice',
            nickname: 'Al',
            nicknames: ['Al'],
            isBot: false,
            inServer: true,
        });
        expect(await rowFor(guild.id, guild.bot.id)).toMatchObject({ isBot: true, inServer: true });
    });

    it('marks somebody recorded as here but no longer in the server as gone, with no date', async () => {
        expect(await rowFor(guild.id, GHOST_ID)).toMatchObject({
            inServer: false,
            leftAt: null,
            username: 'ghost',
            nickname: 'Boo',
        });
    });

    it('records nothing for a server off the allowlist', async () => {
        const rows = await database.selectFrom('member_names').select('userId').where('guildId', '=', unlisted.id).execute();
        expect(rows).toEqual([]);
    });
});

describe('the listeners', () => {
    it('records a join', async () => {
        const joiner = guild.createMember({ username: 'newbie', nickname: 'Fresh Meat' });

        await eventually(guild.id, joiner.id, { username: 'newbie', nickname: 'Fresh Meat', inServer: true });
    });

    it("merges a nickname change into the ones seen, newest first", async () => {
        const member = guild.createMember({ username: 'shifty', nickname: 'Brat' });
        await eventually(guild.id, member.id, { nickname: 'Brat' });

        guild.setNickname(member, 'Pet');
        await eventually(guild.id, member.id, { nickname: 'Pet', nicknames: ['Pet', 'Brat'] });

        guild.setNickname(member, null);
        await eventually(guild.id, member.id, { nickname: null, nicknames: ['Pet', 'Brat'] });
    });

    it("takes an account's new names, keeping its nicknames", async () => {
        const member = guild.createMember({ username: 'oldhandle', nickname: 'Kitten' });
        await eventually(guild.id, member.id, { username: 'oldhandle' });

        discord.renameUser(member, { username: 'newhandle', globalName: 'Kitty' });

        await eventually(guild.id, member.id, {
            username: 'newhandle',
            globalName: 'Kitty',
            nickname: 'Kitten',
            nicknames: ['Kitten'],
        });
    });

    it('records a leave by somebody the bot never cached, keeping the names it had', async () => {
        const member = guild.createMember({ username: 'drifter', nickname: 'Wanderer' });
        await eventually(guild.id, member.id, { nickname: 'Wanderer' });
        // A large server's GUILD_CREATE carries only some members; this one is not among them.
        discord.clientGuild(guild).members.cache.delete(member.id);

        guild.removeMember(member);

        await eventually(guild.id, member.id, { inServer: false, username: 'drifter', nickname: 'Wanderer' });
        expect((await rowFor(guild.id, member.id))?.leftAt).toBeInstanceOf(Date);
    });

    it('writes nothing for a member update that changes none of the names — a role, a boost', async () => {
        const member = guild.createMember({ username: 'steady', nickname: 'Same Old' });
        await eventually(guild.id, member.id, { nickname: 'Same Old' });
        const before = (await rowFor(guild.id, member.id))?.updatedAt;
        await new Promise((resolve) => setTimeout(resolve, 5));
        // The harness models no role change, so the update discord.js would emit for one is
        // emitted by hand: a whole old member, names unchanged.
        const cached = discord.clientGuild(guild).members.cache.get(member.id);
        if (!cached) throw new Error('The client holds no member to update.');

        DISCORD_CLIENT.emit(Events.GuildMemberUpdate, cached, cached);
        await memberNamesQueue(guild.id, async () => undefined);

        expect((await rowFor(guild.id, member.id))?.updatedAt).toEqual(before);
    });

    it("leaves a server off the allowlist alone when an account it holds a row for is renamed", async () => {
        const outsider = unlisted.createMember({ username: 'outsider' });
        // Written while the server was still listed, say.
        await memberNamesRepo.recordPresent(unlisted.id, [
            { userId: outsider.id, username: 'outsider', globalName: null, nickname: null, isBot: false },
        ]);

        discord.renameUser(outsider, { username: 'renamed' });
        // The rename's listener reads which servers hold the account, then writes; let it finish.
        for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));
        await memberNamesQueue(unlisted.id, async () => undefined);

        expect(await rowFor(unlisted.id, outsider.id)).toMatchObject({ username: 'outsider' });
    });

    it('records nothing for a server off the allowlist', async () => {
        unlisted.setNickname(unlistedMember, 'Ignored');
        unlisted.removeMember(unlistedMember);
        // A listener queues its write as the event arrives, so one it did queue has run by now.
        await memberNamesQueue(unlisted.id, async () => undefined);

        expect(await rowFor(unlisted.id, unlistedMember.id)).toBeUndefined();
    });
});
