import { levelingProgressRepo } from '../data/levelingProgressRepo';

export const DEFAULT_GUILD_RANKINGS_LIMIT = 10;

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
};

function getLastActiveAt(
    lastMessageXpAt: Date | string | null,
    lastReactionXpAt: Date | string | null
): Date | null {
    const timestamps = [lastMessageXpAt, lastReactionXpAt]
        .filter((value): value is Date | string => value != null)
        .map((value) => (value instanceof Date ? value : new Date(value)));

    if (timestamps.length === 0) {
        return null;
    }

    return new Date(Math.max(...timestamps.map((date) => date.getTime())));
}

export async function loadGuildLevelRankings(
    input: LoadGuildLevelRankingsInput
): Promise<GuildLevelRankings> {
    const limit = input.limit ?? DEFAULT_GUILD_RANKINGS_LIMIT;

    const [rows, totalRankedMembers] = await Promise.all([
        levelingProgressRepo.getGuildTopByTotalXp(input.guildId, limit),
        levelingProgressRepo.countGuildRankedMembers(input.guildId),
    ]);

    const entries = rows.map((row, index) => ({
        rank: index + 1,
        userId: row.userId,
        totalXp: row.totalXp,
        level: row.level,
        messageCount: row.messageCount,
        reactionCount: row.reactionCount,
        photoUploadCount: row.photoUploadCount,
        lastActiveAt: getLastActiveAt(row.lastMessageXpAt, row.lastReactionXpAt),
    }));

    return {
        entries,
        totalRankedMembers,
    };
}
