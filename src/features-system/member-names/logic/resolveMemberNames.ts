import { DiscordAPIError, RESTJSONErrorCodes, type Guild } from 'discord.js';
import { memberNamesRepo, type SeenMember, type SeenUser } from '../data/memberNamesRepo';
import type { MemberNameRow } from '../data/memberNamesSchema';
import { memberNamesQueue } from '../memberNamesQueue';
import { seenMember, seenUser } from './seenNames';

/**
 * How many ids one call asks Discord about. The rest come back unknown this time and are
 * looked up on a later call, so a page full of strangers fills in over a few loads rather
 * than one request queueing a hundred lookups.
 */
export const MEMBER_NAME_LOOKUP_CAP = 25;

/** 10013 Unknown User: no account by that id. */
function isUnknownUser(error: unknown): boolean {
    return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownUser;
}

/**
 * Who each of `userIds` is in `guild`, for the dashboard: the stored row where there is one.
 *
 * An id with no row is recorded first. Somebody in the guild's member cache is recorded as
 * the member they are, at no cost. Anyone else — up to {@link MEMBER_NAME_LOOKUP_CAP} of
 * them — is looked up from Discord as an account (`users.fetch`, which knows any user,
 * member or not, but never a server nickname) and recorded as not in the server. An id
 * Discord has no account for is left out; so is one past the cap, until a later call.
 *
 * A lookup that fails any other way is logged and its id left out too — "unknown for now",
 * as the wire contract says of every missing id — rather than failing the whole answer and
 * taking the names already stored with it.
 */
export async function resolveMemberNames(guild: Guild, userIds: readonly string[]): Promise<MemberNameRow[]> {
    // Before anything is read: a leave or update heard while the lookups run is newer than
    // the cached members taken here, and the write below leaves it be.
    const readAt = new Date();
    const stored = await memberNamesRepo.findByUserIds(guild.id, userIds);
    const known = new Set(stored.map((row) => row.userId));
    const unknown = userIds.filter((userId) => !known.has(userId));
    if (unknown.length === 0) return stored;

    const members: SeenMember[] = [];
    const toLookUp: string[] = [];
    for (const userId of unknown) {
        const member = guild.members.cache.get(userId);
        if (member && !member.partial) {
            members.push(seenMember(member));
        } else {
            toLookUp.push(userId);
        }
    }

    const lookedUp = await Promise.all(toLookUp.slice(0, MEMBER_NAME_LOOKUP_CAP).map((userId) => lookUpUser(guild, userId)));
    const users = lookedUp.filter((user): user is SeenUser => user !== null);

    if (members.length === 0 && users.length === 0) return stored;

    await memberNamesQueue(guild.id, async () => {
        if (members.length > 0) await memberNamesRepo.recordPresent(guild.id, members, readAt);
        if (users.length > 0) await memberNamesRepo.recordLookedUp(guild.id, users);
    });

    const recorded = await memberNamesRepo.findByUserIds(
        guild.id,
        [...members, ...users].map((seen) => seen.userId)
    );
    return [...stored, ...recorded];
}

async function lookUpUser(guild: Guild, userId: string): Promise<SeenUser | null> {
    try {
        // Not cached: these are any ids a page shows, mostly strangers, and the client's user
        // cache has no sweeper — the answer is kept in `member_names` instead.
        return seenUser(await guild.client.users.fetch(userId, { cache: false }));
    } catch (error) {
        if (!isUnknownUser(error)) {
            console.error(`[member-names] Looking up user ${userId} for guild ${guild.id} failed; leaving them out:`, error);
        }
        return null;
    }
}
