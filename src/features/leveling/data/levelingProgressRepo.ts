import { database } from '../../../features-system/data-persistence/database';
import { getLevelFromTotalXp } from '../logic/xpCalculator';
import {
    computeXpGrant,
    getRecordedActivityXpAmount,
    toTimestampValue,
    type XpActivityType,
    type XpGrantComputation,
} from '../logic/xpGrant';
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
    incrementVoiceSessionCount?: boolean;
    addVoiceSeconds?: number;
    messageLength?: number | null;
    photoBonusApplied?: boolean;
    voiceEligibleSeconds?: number | null;
    voiceSessionStartedAt?: Date | null;
    voiceSessionEndedAt?: Date | null;
    voiceChannelId?: string | null;
    voiceEligibilityRule?: string | null;
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

    async getGuildTopByTotalXp(
        guildId: string,
        limit: number,
        offset: number = 0
    ): Promise<LevelingProgress[]> {
        return database
            .selectFrom('leveling_progress')
            .selectAll()
            .where('guildId', '=', guildId)
            .orderBy('totalXp', 'desc')
            .orderBy('updatedAt', 'asc')
            .offset(offset)
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

    async getAllByGuildId(guildId: string): Promise<LevelingProgress[]> {
        return database
            .selectFrom('leveling_progress')
            .selectAll()
            .where('guildId', '=', guildId)
            .execute();
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
                    incrementVoiceSessionCount: input.incrementVoiceSessionCount,
                    addVoiceSeconds: input.addVoiceSeconds,
                });

                await levelingActivityEventRepo.recordActivityEvent(transaction, {
                    guildId: input.guildId,
                    userId: input.userId,
                    activityType: input.activityType,
                    xpAmount: getRecordedActivityXpAmount(computation, input.xpAmount),
                    messageLength: input.messageLength,
                    photoBonusApplied: input.photoBonusApplied,
                    occurredAt: grantedAt,
                    voiceEligibleSeconds: input.voiceEligibleSeconds,
                    voiceSessionStartedAt: input.voiceSessionStartedAt,
                    voiceSessionEndedAt: input.voiceSessionEndedAt,
                    voiceChannelId: input.voiceChannelId,
                    voiceEligibilityRule: input.voiceEligibilityRule,
                });

                if (!computation) {
                    if (input.incrementVoiceSessionCount) {
                        const now = grantedAt.toISOString();
                        if (existing) {
                            await transaction
                                .updateTable('leveling_progress')
                                .set({
                                    voiceSessionCount: (existing.voiceSessionCount ?? 0) + 1,
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
                                    totalXp: 0,
                                    level: 1,
                                    messageCount: 0,
                                    reactionCount: 0,
                                    photoUploadCount: 0,
                                    voiceSessionCount: 1,
                                    totalVoiceSeconds: 0,
                                    lastMessageXpAt: null,
                                    lastReactionXpAt: null,
                                    lastVoiceXpAt: null,
                                    createdAt: now,
                                    updatedAt: now,
                                })
                                .execute();
                        }
                    }
                    return null;
                }

                const now = grantedAt.toISOString();
                const progressWrite = progressWriteFromComputation(computation, input.activityType, now);

                if (existing) {
                    await transaction
                        .updateTable('leveling_progress')
                        .set(progressWrite)
                        .where('guildId', '=', input.guildId)
                        .where('userId', '=', input.userId)
                        .execute();
                } else {
                    await transaction
                        .insertInto('leveling_progress')
                        .values({
                            guildId: input.guildId,
                            userId: input.userId,
                            ...progressWrite,
                            createdAt: now,
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

function progressWriteFromComputation(
    computation: XpGrantComputation,
    activityType: XpActivityType,
    now: string
) {
    const shared = {
        totalXp: computation.newTotalXp,
        level: getLevelFromTotalXp(computation.newTotalXp),
        messageCount: computation.messageCount,
        reactionCount: computation.reactionCount,
        photoUploadCount: computation.photoUploadCount,
        lastMessageXpAt: toTimestampValue(computation.lastMessageXpAt),
        lastReactionXpAt: toTimestampValue(computation.lastReactionXpAt),
        updatedAt: now,
    };

    if (activityType !== 'voice') {
        return shared;
    }

    return {
        ...shared,
        voiceSessionCount: computation.voiceSessionCount,
        totalVoiceSeconds: computation.totalVoiceSeconds,
        lastVoiceXpAt: toTimestampValue(computation.lastVoiceXpAt),
    };
}

function isUniqueConstraintViolation(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('unique') || message.includes('constraint');
}
