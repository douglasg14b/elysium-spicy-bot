import { DiscordAPIError, RESTJSONErrorCodes, type Guild } from 'discord.js';
import { memberAvatarsRepo } from '../data/memberAvatarsRepo';
import { memberNamesRepo, type SeenMember, type SeenUser } from '../data/memberNamesRepo';
import type { MemberNameRow } from '../data/memberNamesSchema';
import { memberAvatarDownloads } from '../memberAvatarDownloads';
import { memberNamesQueue } from '../memberNamesQueue';
import { seenMember, seenUser } from './seenNames';

/**
 * How many ids one call asks Discord about — ids nobody has seen first, then departed rows
 * to refresh. The rest come back as they are this time and are looked up on a later call,
 * so a page full of strangers fills in over a few loads rather than one request queueing a
 * hundred lookups.
 */
export const MEMBER_NAME_LOOKUP_CAP = 25;

/** What asking Discord about one account found. */
type AccountLookup =
    | { readonly kind: 'found'; readonly user: SeenUser }
    /** 10013 Unknown User: no account by that id — never one, or deleted. */
    | { readonly kind: 'noAccount' }
    /** Anything else: logged, and the id left as it was. */
    | { readonly kind: 'failed' };

/**
 * Departed rows this process has already refreshed, by guild and user: each is asked about
 * at most once a process, whatever came of it — a refresh whose picture then failed to
 * download is not asked again on every load. Bounded by the departed rows there are, and
 * forgotten on restart, which is the retry.
 */
const refreshedThisProcess = new Set<string>();

function refreshKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
}

/**
 * Who each of `userIds` is in `guild`, for the dashboard: the stored row where there is one.
 *
 * An id with no row is recorded first. Somebody in the guild's member cache is recorded as
 * the member they are, at no cost. Anyone else is looked up from Discord as an account
 * (`users.fetch`, which knows any user, member or not, but never a server nickname) and
 * recorded as not in the server. An id Discord has no account for is left out.
 *
 * A row for somebody no longer in the server is refreshed the same way when its avatar
 * needs it ({@link needsAvatarRefresh}) — nothing else will see them again — taking their
 * current names and avatar hash and queueing the picture; a deleted account is marked
 * checked with no avatar. The picture downloads in the background, so the answer that
 * refreshes them may come without it and a later one has it.
 *
 * Lookups and refreshes share {@link MEMBER_NAME_LOOKUP_CAP}, unknown ids first; the rest
 * wait for a later call. A lookup that fails any other way is logged and its id left as it
 * was — "unknown for now", as the wire contract says of every missing id — rather than
 * failing the whole answer and taking the names already stored with it.
 */
export async function resolveMemberNames(guild: Guild, userIds: readonly string[]): Promise<MemberNameRow[]> {
    // Before anything is read: a leave or update heard while the lookups run is newer than
    // the cached members taken here, and the write below leaves it be.
    const readAt = new Date();
    const stored = await memberNamesRepo.findByUserIds(guild.id, userIds);
    const known = new Set(stored.map((row) => row.userId));

    const members: SeenMember[] = [];
    const toLookUp: string[] = [];
    for (const userId of userIds.filter((id) => !known.has(id))) {
        const member = guild.members.cache.get(userId);
        if (member && !member.partial) {
            members.push(seenMember(member));
        } else {
            toLookUp.push(userId);
        }
    }

    const lookUps = toLookUp.slice(0, MEMBER_NAME_LOOKUP_CAP);
    const toRefresh = (await departedNeedingRefresh(guild.id, stored)).slice(0, MEMBER_NAME_LOOKUP_CAP - lookUps.length);
    for (const userId of toRefresh) refreshedThisProcess.add(refreshKey(guild.id, userId));

    const [lookedUp, refreshed] = await Promise.all([
        Promise.all(lookUps.map((userId) => lookUpAccount(guild, userId))),
        Promise.all(toRefresh.map(async (userId) => ({ userId, lookup: await lookUpAccount(guild, userId) }))),
    ]);
    const users = lookedUp.flatMap((lookup) => (lookup.kind === 'found' ? [lookup.user] : []));
    const refreshedUsers = refreshed.flatMap(({ lookup }) => (lookup.kind === 'found' ? [lookup.user] : []));
    const deleted = refreshed.filter(({ lookup }) => lookup.kind === 'noAccount').map(({ userId }) => userId);

    const changed = new Set([...members, ...users, ...refreshedUsers].map((seen) => seen.userId).concat(deleted));
    if (changed.size === 0) return stored;

    await memberNamesQueue(guild.id, async () => {
        if (members.length > 0) await memberNamesRepo.recordPresent(guild.id, members, readAt);
        if (users.length > 0) await memberNamesRepo.recordLookedUp(guild.id, users);
        for (const user of refreshedUsers) await memberNamesRepo.recordUser(guild.id, user);
        for (const userId of deleted) await memberNamesRepo.recordNoAccount(guild.id, userId);
    });
    // In the background: this answer carries no picture for them yet, a later one does.
    memberAvatarDownloads.note([...members, ...users, ...refreshedUsers]);

    const recorded = await memberNamesRepo.findByUserIds(guild.id, [...changed]);
    return [...stored.filter((row) => !changed.has(row.userId)), ...recorded];
}

/**
 * Whether a departed row's avatar needs reading from Discord again: it was never checked
 * (a row from before avatars were kept), or it names an avatar whose picture is not held —
 * its download failed, or never ran. `heldAvatarHash` is the hash of the picture held for
 * the account, if any.
 */
export function needsAvatarRefresh(row: MemberNameRow, heldAvatarHash: string | undefined): boolean {
    if (row.inServer) return false;
    if (row.avatarCheckedAt === null) return true;
    return row.avatarHash !== null && heldAvatarHash !== row.avatarHash;
}

/** The departed rows among `stored` whose avatar needs refreshing and that this process has not refreshed. */
async function departedNeedingRefresh(guildId: string, stored: readonly MemberNameRow[]): Promise<string[]> {
    const candidates = stored.filter(
        (row) => !row.inServer && !refreshedThisProcess.has(refreshKey(guildId, row.userId))
    );
    if (candidates.length === 0) return [];
    const withHash = candidates.filter((row) => row.avatarHash !== null).map((row) => row.userId);
    const held = withHash.length > 0 ? await memberAvatarsRepo.storedHashes(withHash) : new Map<string, string>();
    return candidates.filter((row) => needsAvatarRefresh(row, held.get(row.userId))).map((row) => row.userId);
}

async function lookUpAccount(guild: Guild, userId: string): Promise<AccountLookup> {
    try {
        // Not cached: these are any ids a page shows, mostly strangers, and the client's user
        // cache has no sweeper — the answer is kept in `member_names` instead.
        return { kind: 'found', user: seenUser(await guild.client.users.fetch(userId, { cache: false })) };
    } catch (error) {
        if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownUser) {
            return { kind: 'noAccount' };
        }
        console.error(`[member-names] Looking up user ${userId} for guild ${guild.id} failed; leaving them as they were:`, error);
        return { kind: 'failed' };
    }
}
