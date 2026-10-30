import type { Client, Guild } from 'discord.js';
import { isGuildAllowed } from '../guild-allowlist';
import { memberNamesRepo } from './data/memberNamesRepo';
import { seenMember } from './logic/seenNames';
import { memberNamesQueue } from './memberNamesQueue';

/** What one guild's sweep found and changed. */
export interface GuildSweepResult {
    readonly members: number;
    readonly markedGone: number;
}

/**
 * Record everyone in `guild` now, and mark whoever was recorded as here but is not as gone.
 *
 * The member list is fetched outside the queue — on a large server it is the slow part,
 * and the listeners must not wait on it — and written inside it as one task. Anything
 * written after the fetch began is newer than the list, so the writes skip it: a leave
 * heard while the list was in flight stays a leave, a join stays a join.
 */
export async function sweepGuildMembers(guild: Guild): Promise<GuildSweepResult> {
    const startedAt = new Date();
    const members = await guild.members.fetch();
    const seen = [...members.values()].map(seenMember);

    return memberNamesQueue(guild.id, async () => {
        await memberNamesRepo.recordPresent(guild.id, seen, startedAt);
        const markedGone = await memberNamesRepo.markMissingAsGone(
            guild.id,
            new Set(seen.map((member) => member.userId)),
            startedAt
        );
        return { members: seen.length, markedGone };
    });
}

/** The sweep running or last queued, whichever guild it is for. */
let sweeps: Promise<void> = Promise.resolve();

/**
 * Sweep `guild` once every sweep already queued has finished, whichever guild each is for:
 * one at a time across the bot — each is a gateway member request, and discord.js does not
 * handle that request's rate limit (see `fetchMemberSnapshotsById`). The startup sweep,
 * a server joined while running and a server back from an outage all queue here. A sweep
 * that fails is logged, never thrown, and the next one runs; nothing retries it.
 */
export function queueGuildSweep(guild: Guild): Promise<void> {
    const sweep = sweeps.then(async () => {
        try {
            const result = await sweepGuildMembers(guild);
            console.log(
                `👥 [member-names] Recorded ${result.members} member(s) of ${guild.name} (${guild.id}); ${result.markedGone} no longer there.`
            );
        } catch (error) {
            console.error(`❌ [member-names] Failed to record the members of ${guild.name} (${guild.id}):`, error);
        }
    });
    sweeps = sweep;
    return sweep;
}

/**
 * At ready: queue a sweep of every allowed guild the client holds. One Discord has
 * unavailable now is skipped here; it is swept when it comes back (`GuildAvailable`).
 */
export async function sweepAllGuilds(client: Client<true>, allowedGuildIds: readonly string[]): Promise<void> {
    const queued = [...client.guilds.cache.values()]
        .filter((guild) => guild.available && isGuildAllowed(guild.id, allowedGuildIds))
        .map(queueGuildSweep);
    await Promise.all(queued);
}
