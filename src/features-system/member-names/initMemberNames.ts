import { Events, type Client, type Guild, type GuildMember, type PartialGuildMember, type User } from 'discord.js';
import { DISCORD_CLIENT } from '../../discordClient';
import { ALLOWED_GUILD_IDS } from '../../environment';
import { isGuildAllowed } from '../guild-allowlist';
import { memberNamesRepo } from './data/memberNamesRepo';
import { sameNames, seenMember, seenUser } from './logic/seenNames';
import { memberAvatarDownloads } from './memberAvatarDownloads';
import { memberNamesQueue } from './memberNamesQueue';
import { queueGuildSweep, sweepAllGuilds } from './memberNamesSweep';

let memberNamesInitialized = false;

/**
 * Keep `member_names` current from the gateway, and sweep every server's members once the
 * client is ready. Call once, before login.
 */
export function initMemberNames(): void {
    if (memberNamesInitialized) return;
    memberNamesInitialized = true;
    watchMemberNames(DISCORD_CLIENT, ALLOWED_GUILD_IDS);
}

/**
 * The listeners and the startup sweep, for `client` and the servers `allowedGuildIds`
 * allows (`isGuildAllowed`) — an unlisted server is not recorded, as the dashboard does
 * not serve it.
 *
 * Each listener queues its write on the guild's queue and logs a failure; none throws
 * into the gateway. Requires the GuildMembers intent, and the GuildMember partial for a
 * leave by somebody the bot never cached (`discordClient.ts`).
 */
export function watchMemberNames(client: Client, allowedGuildIds: readonly string[]): void {
    const allowed = (guildId: string): boolean => isGuildAllowed(guildId, allowedGuildIds);

    client.on(Events.GuildMemberAdd, (member) => {
        if (!allowed(member.guild.id)) return;
        void recordMembers(member).catch((error: unknown) => {
            console.error('[member-names] Error recording a member join:', error);
        });
    });

    // Written from the new member only: the old one may be partial, and the new one is the
    // whole member as it is now. A whole old member with the same names means a role, boost
    // or timeout changed — nothing this records — so nothing is written. (discord.js gives
    // both one shared User, already updated, so an account rename or a new account avatar
    // compares equal here: it is the UserUpdate listener's to record.)
    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
        if (!allowed(newMember.guild.id)) return;
        if (!oldMember.partial && sameNames(seenMember(oldMember), seenMember(newMember))) return;
        void recordMembers(newMember).catch((error: unknown) => {
            console.error('[member-names] Error recording a member update:', error);
        });
    });

    client.on(Events.GuildMemberRemove, (member) => {
        if (!allowed(member.guild.id)) return;
        void recordLeave(member).catch((error: unknown) => {
            console.error('[member-names] Error recording a member leave:', error);
        });
    });

    // discord.js emits this for any cached account whose names or avatar changed (`User._equals`),
    // heard through any server; every server's row for them takes the new ones.
    client.on(Events.UserUpdate, (_oldUser, newUser) => {
        void recordUserChange(newUser, allowed).catch((error: unknown) => {
            console.error('[member-names] Error recording a user update:', error);
        });
    });

    // A server joined while running, and one back from an outage (skipped at ready while it
    // was unavailable), are swept like the startup ones, on the same one-at-a-time path.
    const sweepOne = (guild: Guild): void => {
        if (allowed(guild.id)) void queueGuildSweep(guild);
    };
    client.on(Events.GuildCreate, sweepOne);
    client.on(Events.GuildAvailable, sweepOne);

    const sweep = (readyClient: Client<true>): void => {
        void sweepAllGuilds(readyClient, allowedGuildIds).catch((error: unknown) => {
            console.error('[member-names] Startup sweep failed:', error);
        });
    };
    if (client.isReady()) {
        sweep(client);
    } else {
        client.once(Events.ClientReady, sweep);
    }
}

// Each records the names first, then hands the avatar to the download queue, which fetches
// the picture in the background only if it is not the one held.

async function recordMembers(member: GuildMember): Promise<void> {
    const seen = seenMember(member);
    await memberNamesQueue(member.guild.id, () => memberNamesRepo.recordPresent(member.guild.id, [seen]));
    memberAvatarDownloads.note([seen]);
}

/** A leave is the last sighting of them there: the user it carries is whole even when the member is partial. */
async function recordLeave(member: GuildMember | PartialGuildMember): Promise<void> {
    const leftAt = new Date();
    const seen = seenMember(member);
    await memberNamesQueue(member.guild.id, () => memberNamesRepo.recordLeft(member.guild.id, seen, leftAt));
    memberAvatarDownloads.note([seen]);
}

/**
 * Every allowed server's row for `user` takes their new names and avatar; a server since
 * taken off the list keeps its rows as they were. An account no allowed server holds a row
 * for downloads nothing.
 */
async function recordUserChange(user: User, allowed: (guildId: string) => boolean): Promise<void> {
    const seen = seenUser(user);
    const guildIds = (await memberNamesRepo.guildIdsFor(user.id)).filter(allowed);
    if (guildIds.length === 0) return;
    await Promise.all(
        guildIds.map((guildId) => memberNamesQueue(guildId, () => memberNamesRepo.recordUser(guildId, seen)))
    );
    memberAvatarDownloads.note([seen]);
}
