import { levelingXpGrantRepo } from '../data/levelingXpGrantRepo';
import { levelingProgressRepo } from '../data/levelingProgressRepo';
import { buildUserLevelProfile, getRecentActivitySince, type UserLevelProfile } from './userLevelProfile';

export async function loadUserLevelProfile(guildId: string, userId: string): Promise<UserLevelProfile> {
    const [progress, recentActivity, totalActivity] = await Promise.all([
        levelingProgressRepo.get(guildId, userId),
        levelingXpGrantRepo.getUserActivityTotals(guildId, userId, {
            since: getRecentActivitySince(),
        }),
        levelingXpGrantRepo.getUserActivityTotals(guildId, userId),
    ]);

    return buildUserLevelProfile({
        userId,
        progress,
        recentActivity,
        totalActivity,
    });
}
