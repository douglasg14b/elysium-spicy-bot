import type { Transaction } from 'kysely';
import { database, Database } from '../../../features-system/data-persistence/database';
import type { LevelingActivityEvent, LevelingActivityTotals } from './levelingActivityEventSchema';
import type { LevelingActivityEventType } from '../constants/activityEventTypes';
import { aggregateActivityTotals } from '../logic/activityEventAggregation';
import { toTimestampValue } from '../logic/xpGrant';

export type RecordActivityEventInput = {
    guildId: string;
    userId: string;
    activityType: LevelingActivityEventType;
    xpAmount: number;
    messageLength?: number | null;
    photoBonusApplied?: boolean;
    occurredAt?: Date;
    voiceEligibleSeconds?: number | null;
    voiceSessionStartedAt?: Date | null;
    voiceSessionEndedAt?: Date | null;
    voiceChannelId?: string | null;
    voiceEligibilityRule?: string | null;
};

export class LevelingActivityEventRepo {
    async getUserEvents(
        guildId: string,
        userId: string,
        options?: { since?: Date; limit?: number }
    ): Promise<LevelingActivityEvent[]> {
        let query = database
            .selectFrom('leveling_activity_events')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .orderBy('occurredAt', 'asc');

        if (options?.since) {
            query = query.where('occurredAt', '>=', options.since);
        }

        if (options?.limit) {
            query = query.limit(options.limit);
        }

        return query.execute();
    }

    async getUserActivityTotals(
        guildId: string,
        userId: string,
        options?: { since?: Date }
    ): Promise<LevelingActivityTotals> {
        const events = await this.getUserEvents(guildId, userId, options);
        return aggregateActivityTotals(events);
    }

    async recordActivityEvent(
        transaction: Transaction<Database>,
        input: RecordActivityEventInput
    ): Promise<void> {
        const occurredAt = (input.occurredAt ?? new Date()).toISOString();
        const values = {
            guildId: input.guildId,
            userId: input.userId,
            activityType: input.activityType,
            xpAmount: input.xpAmount,
            messageLength: input.messageLength ?? null,
            photoBonus: input.photoBonusApplied ?? false,
            occurredAt,
            ...(input.activityType === 'voice'
                ? {
                      voiceEligibleSeconds: input.voiceEligibleSeconds ?? null,
                      voiceSessionStartedAt: toTimestampValue(input.voiceSessionStartedAt ?? null),
                      voiceSessionEndedAt: toTimestampValue(input.voiceSessionEndedAt ?? null),
                      voiceChannelId: input.voiceChannelId ?? null,
                      voiceEligibilityRule: input.voiceEligibilityRule ?? null,
                  }
                : {}),
        };

        await transaction.insertInto('leveling_activity_events').values(values).execute();
    }
}

export const levelingActivityEventRepo = new LevelingActivityEventRepo();
