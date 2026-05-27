import { database } from '../../../features-system/data-persistence/database';
import { getLevelFromTotalXp } from '../logic/xpCalculator';
import { computeXpGrant, getRecordedActivityXpAmount, toTimestampValue, XpActivityType } from '../logic/xpGrant';
import { levelingActivityEventRepo } from './levelingActivityEventRepo';
import { LevelingProgress } from './levelingProgressSchema';

export type GrantXpResult = {
    progress: LevelingProgress;
    previousTotalXp: number;
    newTotalXp: number;
    xpGranted: number;
};

export type GrantXpInput = {
    guildId: string;
    userId: string;
    xpAmount: number;
    activityType: XpActivityType;
    cooldownMs: number;
    grantedAt?: Date;
    incrementMessageCount?: boolean;
    incrementReactionCount?: boolean;
    incrementPhotoUploadCount?: boolean;
    messageLength?: number | null;
    photoBonusApplied?: boolean;
};

export class LevelingProgressRepo {
    async get(guildId: string, userId: string): Promise<LevelingProgress | null> {
        const progress = await database
            .selectFrom('leveling_progress')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .executeTakeFirst();

        return progress || null;
    }

    async getGuildTopByTotalXp(guildId: string, limit: number): Promise<LevelingProgress[]> {
        return database
            .selectFrom('leveling_progress')
            .selectAll()
            .where('guildId', '=', guildId)
            .orderBy('totalXp', 'desc')
            .orderBy('updatedAt', 'asc')
            .limit(limit)
            .execute();
    }

    async countGuildRankedMembers(guildId: string): Promise<number> {
        const result = await database
            .selectFrom('leveling_progress')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('guildId', '=', guildId)
            .executeTakeFirst();

        return Number(result?.count ?? 0);
    }

    async grantXp(input: GrantXpInput): Promise<GrantXpResult | null> {
        return this.grantXpOnce(input, false);
    }

    private async grantXpOnce(input: GrantXpInput, isRetry: boolean): Promise<GrantXpResult | null> {
        const grantedAt = input.grantedAt ?? new Date();

        try {
            return await database.transaction().execute(async (transaction) => {
                const existing = await transaction
                    .selectFrom('leveling_progress')
                    .selectAll()
                    .where('guildId', '=', input.guildId)
                    .where('userId', '=', input.userId)
                    .executeTakeFirst();

                const computation = computeXpGrant({
                    existing: existing ?? null,
                    xpAmount: input.xpAmount,
                    activityType: input.activityType,
                    cooldownMs: input.cooldownMs,
                    grantedAt,
                    incrementMessageCount: input.incrementMessageCount,
                    incrementReactionCount: input.incrementReactionCount,
                    incrementPhotoUploadCount: input.incrementPhotoUploadCount,
                });

                await levelingActivityEventRepo.recordActivityEvent(transaction, {
                    guildId: input.guildId,
                    userId: input.userId,
                    activityType: input.activityType,
                    xpAmount: getRecordedActivityXpAmount(computation, input.xpAmount),
                    messageLength: input.messageLength,
                    photoBonusApplied: input.photoBonusApplied,
                    occurredAt: grantedAt,
                });

                if (!computation) {
                    return null;
                }

                const now = grantedAt.toISOString();
                const level = getLevelFromTotalXp(computation.newTotalXp);

                if (existing) {
                    await transaction
                        .updateTable('leveling_progress')
                        .set({
                            totalXp: computation.newTotalXp,
                            level,
                            messageCount: computation.messageCount,
                            reactionCount: computation.reactionCount,
                            photoUploadCount: computation.photoUploadCount,
                            lastMessageXpAt: toTimestampValue(computation.lastMessageXpAt),
                            lastReactionXpAt: toTimestampValue(computation.lastReactionXpAt),
                            updatedAt: now,
                        })
                        .where('guildId', '=', input.guildId)
                        .where('userId', '=', input.userId)
                        .execute();
                } else {
                    await transaction
                        .insertInto('leveling_progress')
                        .values({
                            guildId: input.guildId,
                            userId: input.userId,
                            totalXp: computation.newTotalXp,
                            level,
                            messageCount: computation.messageCount,
                            reactionCount: computation.reactionCount,
                            photoUploadCount: computation.photoUploadCount,
                            lastMessageXpAt: toTimestampValue(computation.lastMessageXpAt),
                            lastReactionXpAt: toTimestampValue(computation.lastReactionXpAt),
                            createdAt: now,
                            updatedAt: now,
                        })
                        .execute();
                }

                const progress = await transaction
                    .selectFrom('leveling_progress')
                    .selectAll()
                    .where('guildId', '=', input.guildId)
                    .where('userId', '=', input.userId)
                    .executeTakeFirstOrThrow();

                return {
                    progress,
                    previousTotalXp: computation.previousTotalXp,
                    newTotalXp: computation.newTotalXp,
                    xpGranted: input.xpAmount,
                };
            });
        } catch (error) {
            if (!isRetry && isUniqueConstraintViolation(error)) {
                return this.grantXpOnce(input, true);
            }

            throw error;
        }
    }
}

export const levelingProgressRepo = new LevelingProgressRepo();

function isUniqueConstraintViolation(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('unique') || message.includes('constraint');
}
