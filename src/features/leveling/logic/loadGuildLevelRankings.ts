import type { LevelingProgress } from '../data/levelingProgressSchema';
import { levelingProgressRepo } from '../data/levelingProgressRepo';

export const DEFAULT_GUILD_RANKINGS_LIMIT = 10;

/** Extra rows scanned per batch when filtering out departed members. */
const RANKINGS_MEMBER_FILTER_BATCH_SIZE = 50;

/** Cap on ranked rows scanned so a large departed-member backlog cannot loop forever. */
const RANKINGS_MEMBER_FILTER_MAX_SCAN = 500;

export type GuildLevelRankingEntry = {
    rank: number;
    userId: string;
    totalXp: number;
    level: number;
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    lastActiveAt: Date | null;
};

export type GuildLevelRankings = {
    entries: GuildLevelRankingEntry[];
    totalRankedMembers: number;
};

export type LoadGuildLevelRankingsInput = {
    guildId: string;
    limit?: number;
    /** When set, only members still in the guild are included (backfills past departed users). */
    isCurrentMember?: (userId: string) => Promise<boolean>;
};

function getLastActiveAt(
    lastMessageXpAt: Date | string | null,
    lastReactionXpAt: Date | string | null,
    lastVoiceXpAt: Date | string | null
): Date | null {
    const timestamps = [lastMessageXpAt, lastReactionXpAt, lastVoiceXpAt]
        .filter((value): value is Date | string => value != null)
        .map((value) => (value instanceof Date ? value : new Date(value)));

    if (timestamps.length === 0) {
        return null;
    }

    return new Date(Math.max(...timestamps.map((date) => date.getTime())));
}

function mapProgressToRankingEntry(row: LevelingProgress, rank: number): GuildLevelRankingEntry {
    return {
        rank,
        userId: row.userId,
        totalXp: row.totalXp,
        level: row.level,
        messageCount: row.messageCount,
        reactionCount: row.reactionCount,
        photoUploadCount: row.photoUploadCount,
        lastActiveAt: getLastActiveAt(row.lastMessageXpAt, row.lastReactionXpAt, row.lastVoiceXpAt),
    };
}

export async function loadGuildLevelRankings(
    input: LoadGuildLevelRankingsInput
): Promise<GuildLevelRankings> {
    const limit = input.limit ?? DEFAULT_GUILD_RANKINGS_LIMIT;
    const totalRankedMembers = await levelingProgressRepo.countGuildRankedMembers(input.guildId);

    if (!input.isCurrentMember) {
        const rows = await levelingProgressRepo.getGuildTopByTotalXp(input.guildId, limit);

        return {
            entries: rows.map((row, index) => mapProgressToRankingEntry(row, index + 1)),
            totalRankedMembers,
        };
    }

    const entries: GuildLevelRankingEntry[] = [];
    let offset = 0;

    while (entries.length < limit && offset < RANKINGS_MEMBER_FILTER_MAX_SCAN) {
        const batchLimit = Math.min(RANKINGS_MEMBER_FILTER_BATCH_SIZE, RANKINGS_MEMBER_FILTER_MAX_SCAN - offset);
        const rows = await levelingProgressRepo.getGuildTopByTotalXp(input.guildId, batchLimit, offset);

        if (rows.length === 0) {
            break;
        }

        for (const row of rows) {
            if (!(await input.isCurrentMember(row.userId))) {
                continue;
            }

            entries.push(mapProgressToRankingEntry(row, entries.length + 1));

            if (entries.length >= limit) {
                break;
            }
        }

        offset += rows.length;

        if (rows.length < batchLimit) {
            break;
        }
    }

    return {
        entries,
        totalRankedMembers,
    };
}
