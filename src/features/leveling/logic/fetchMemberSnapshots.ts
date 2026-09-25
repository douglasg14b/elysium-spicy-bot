import type { Guild, GuildMember } from 'discord.js';
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
 * Shared by the staff report command and the web leveling routes because both hold
 * progress rows — which carry only a snowflake — and both need a name to show. A second
 * copy would be a second answer to "what is this member called".
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

/** The same, keyed by user id for callers that look members up one at a time. */
export async function fetchMemberSnapshotsById(
    guild: Guild,
    userIds: readonly string[]
): Promise<Map<string, GuildMemberSnapshot>> {
    const snapshots = await fetchMemberSnapshots(guild, userIds);
    return new Map(snapshots.map((snapshot) => [snapshot.userId, snapshot]));
}
