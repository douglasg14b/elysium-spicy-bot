import { DiscordAPIError, RESTJSONErrorCodes, type Guild, type GuildMember } from 'discord.js';
import { isUnknownMember } from '../../../utils/isUnknownMember';
import { cardAvatarUrlFromUser } from '../cards/shared/cardAvatarUrl';
import type { GuildMemberSnapshot } from './belowThresholdReport';

/**
 * Discord's cap on ids per `members.fetch({ user })` call.
 *
 * Not a tuning knob: exceeding it is rejected by the gateway rather than truncated, so
 * the batching below is a requirement of the API, not an optimisation.
 */
const MEMBER_ID_FETCH_BATCH_SIZE = 100;

export function toMemberSnapshot(member: GuildMember): GuildMemberSnapshot {
    return {
        userId: member.id,
        displayName: member.displayName,
        username: member.user.username,
        isBot: member.user.bot,
        avatarUrl: cardAvatarUrlFromUser(member.user, 128),
    };
}

/**
 * Resolve display details for a set of user ids, in batches Discord will accept.
 *
 * Shared by the staff report command and — through {@link fetchMemberSnapshotsById}, which
 * puts a cache in front of it — the web leveling routes, because both hold progress rows,
 * which carry only a snowflake, and both need a name to show. A second copy would be a
 * second answer to "what is this member called". Every call sends a gateway member request.
 *
 * Ids that no longer resolve are simply absent from the result: a member who left still
 * has progress rows, and their row is a fact about the past that should not fail a read.
 * Callers keyed by id therefore have to tolerate a miss, which is why this returns
 * snapshots rather than a parallel array.
 */
export async function fetchMemberSnapshots(
    guild: Guild,
    userIds: readonly string[]
): Promise<GuildMemberSnapshot[]> {
    if (userIds.length === 0) {
        return [];
    }

    const snapshots: GuildMemberSnapshot[] = [];

    for (let offset = 0; offset < userIds.length; offset += MEMBER_ID_FETCH_BATCH_SIZE) {
        const batch = userIds.slice(offset, offset + MEMBER_ID_FETCH_BATCH_SIZE);

        /*
         * Deliberately not caught. `members.fetch({ user: [...] })` tolerates ids that no
         * longer resolve — they are simply missing from the collection it returns — so a
         * rejection here means the fetch itself failed, which is a real fault and the
         * caller's to report. Swallowing it would render a report or a ranking that
         * silently omits members, and a short list is indistinguishable from a correct one.
         */
        const fetched = await guild.members.fetch({ user: batch });
        snapshots.push(...fetched.map(toMemberSnapshot));
    }

    return snapshots;
}

/**
 * How long Discord's "not a member" is trusted.
 *
 * Only absence is cached here. A member Discord found lands in the gateway member cache —
 * `members.fetch` caches what it fetches, and no member sweeper is configured — which the
 * `GuildMembers` intent keeps current, so it stays the one answer to "is this member here".
 * Absence has no such home, and it is the half that matters: a leaderboard holds members who
 * left, and without this every dashboard load would ask Discord about them again.
 */
export const MEMBER_LOOKUP_TTL_MS = 60 * 1000;

/** Per guild, per user id: when Discord last said they are not a member. */
const absentSince = new Map<string, Map<string, number>>();

/**
 * Per guild, per user id: the request already asking Discord about them, so concurrent
 * page loads share one request rather than each sending their own. Entries are removed in
 * `finally`, so a failed request does not poison later ones.
 */
const inFlight = new Map<string, Map<string, Promise<ReadonlyMap<string, GuildMemberSnapshot>>>>();

/** Test seam: forget every cached lookup. */
export function clearMemberSnapshotCache(): void {
    absentSince.clear();
    inFlight.clear();
}

function perGuild<Value>(maps: Map<string, Map<string, Value>>, guildId: string): Map<string, Value> {
    let guildMap = maps.get(guildId);
    if (!guildMap) {
        guildMap = new Map();
        maps.set(guildId, guildMap);
    }
    return guildMap;
}

/** 10013 Unknown User: the id was never a Discord user. */
function isUnknownUser(error: unknown): boolean {
    return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownUser;
}

/**
 * Ask Discord about members the cache cannot answer for.
 *
 * One id goes over REST (`members.fetch({ user: id })` routes to `GET /guilds/{id}/members/{user}`),
 * whose rate limits discord.js queues properly, and which answers a departed member with
 * Unknown Member. More go over the gateway in batches, as {@link fetchMemberSnapshots}
 * does: one REST call per member of a leaderboard would be worse than one gateway request.
 * So a member page — the lookup somebody could loop over distinct ids — never sends a
 * gateway member request at all.
 */
async function fetchUncached(guild: Guild, userIds: readonly string[]): Promise<ReadonlyMap<string, GuildMemberSnapshot>> {
    if (userIds.length === 1) {
        const [userId] = userIds;
        try {
            const member = await guild.members.fetch({ user: userId });
            return new Map([[userId, toMemberSnapshot(member)]]);
        } catch (error) {
            // "Not a member" and "not a user at all" are answers — the gateway batch leaves
            // both out silently; anything else is a real fault, as below.
            if (isUnknownMember(error) || isUnknownUser(error)) {
                return new Map();
            }
            throw error;
        }
    }

    const snapshots = await fetchMemberSnapshots(guild, userIds);
    return new Map(snapshots.map((snapshot) => [snapshot.userId, snapshot]));
}

/**
 * Display details for a set of user ids, keyed by id, for the dashboard's leveling pages.
 *
 * `fetchMemberSnapshots` alone would send a gateway member request on every call — a
 * leaderboard is two of them — and discord.js does not handle that request's rate limit:
 * a limited one hangs for minutes and then throws, while every other member fetch on the
 * shard waits behind it. A page anybody can refresh must not be able to do that. So:
 *
 *  1. a member in the gateway cache is answered from it, with no request — a *partial*
 *     member (`Partials.GuildMember`) is not, as it may lack the user it is described by;
 *  2. a member Discord said within {@link MEMBER_LOOKUP_TTL_MS} is not in the guild is
 *     left out, with no request;
 *  3. a member another call is already asking about waits for that request;
 *  4. only the rest are fetched, together.
 *
 * Ids that do not resolve are absent from the result, as with {@link fetchMemberSnapshots}.
 */
export async function fetchMemberSnapshotsById(
    guild: Guild,
    userIds: readonly string[]
): Promise<Map<string, GuildMemberSnapshot>> {
    const now = Date.now();
    const guildAbsent = perGuild(absentSince, guild.id);
    const guildInFlight = perGuild(inFlight, guild.id);

    // Expired answers are dropped on every call, so the map holds at most about a minute's
    // worth of departed ids per guild.
    for (const [userId, since] of guildAbsent) {
        if (now - since >= MEMBER_LOOKUP_TTL_MS) {
            guildAbsent.delete(userId);
        }
    }

    const found = new Map<string, GuildMemberSnapshot>();
    const waits: Promise<void>[] = [];
    const missing: string[] = [];

    for (const userId of new Set(userIds)) {
        const cached = guild.members.cache.get(userId);
        if (cached && !cached.partial) {
            found.set(userId, toMemberSnapshot(cached));
            continue;
        }

        if (guildAbsent.has(userId)) {
            continue;
        }

        const pending = guildInFlight.get(userId);
        if (pending) {
            waits.push(
                pending.then((resolved) => {
                    const snapshot = resolved.get(userId);
                    if (snapshot) found.set(userId, snapshot);
                })
            );
            continue;
        }

        missing.push(userId);
    }

    if (missing.length > 0) {
        const request = (async () => {
            try {
                const resolved = await fetchUncached(guild, missing);
                const resolvedAt = Date.now();
                for (const userId of missing) {
                    if (!resolved.has(userId)) guildAbsent.set(userId, resolvedAt);
                }
                return resolved;
            } finally {
                for (const userId of missing) {
                    guildInFlight.delete(userId);
                }
            }
        })();

        for (const userId of missing) {
            guildInFlight.set(userId, request);
        }

        waits.push(
            request.then((resolved) => {
                for (const [userId, snapshot] of resolved) found.set(userId, snapshot);
            })
        );
    }

    await Promise.all(waits);
    return found;
}
