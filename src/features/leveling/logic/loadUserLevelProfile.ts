import { levelingActivityEventRepo } from '../data/levelingActivityEventRepo';
import { levelingProgressRepo } from '../data/levelingProgressRepo';
import { buildUserLevelProfile, getRecentActivitySince, type UserLevelProfile } from './userLevelProfile';

export async function loadUserLevelProfile(guildId: string, userId: string): Promise<UserLevelProfile> {
    const [progress, recentActivity, totalActivity] = await Promise.all([
        levelingProgressRepo.get(guildId, userId),
        levelingActivityEventRepo.getUserActivityTotals(guildId, userId, {
            since: getRecentActivitySince(),
        }),
        levelingActivityEventRepo.getUserActivityTotals(guildId, userId),
    ]);

    return buildUserLevelProfile({
        userId,
        progress,
        recentActivity,
        totalActivity,
    });
}
