import { describe, expect, it } from 'vitest';
import {
    aggregateActivityTotals,
    aggregateDailyIntoWeeklyBuckets,
    aggregateEventsByDate,
    fillActivityDateRange,
    filterEventsByActivityDateRange,
    sumDailyActivity,
    sumEventXp,
} from '../logic/activityEventAggregation';
import type { LevelingActivityEvent } from '../data/levelingActivityEventSchema';

function makeEvent(overrides: Partial<LevelingActivityEvent> & Pick<LevelingActivityEvent, 'occurredAt'>): LevelingActivityEvent {
    return {
        id: 1,
        guildId: 'guild-1',
        userId: 'user-1',
        activityType: 'message',
        xpAmount: 20,
        messageLength: 100,
        photoBonus: false,
        ...overrides,
    };
}

describe('activityEventAggregation', () => {
    it('aggregates events into daily buckets', () => {
        const buckets = aggregateEventsByDate([
            makeEvent({ id: 1, occurredAt: new Date('2026-05-24T18:00:00Z'), xpAmount: 15 }),
            makeEvent({
                id: 2,
                occurredAt: new Date('2026-05-24T20:00:00Z'),
                xpAmount: 35,
                photoBonus: true,
            }),
            makeEvent({
                id: 3,
                activityType: 'reaction',
                messageLength: null,
                occurredAt: new Date('2026-05-25T12:00:00Z'),
                xpAmount: 1,
            }),
        ]);

        expect(buckets).toEqual([
            {
                activityDate: '2026-05-24',
                messageCount: 2,
                reactionCount: 0,
                photoUploadCount: 1,
                totalXp: 50,
            },
            {
                activityDate: '2026-05-25',
                messageCount: 0,
                reactionCount: 1,
                photoUploadCount: 0,
                totalXp: 1,
            },
        ]);
    });

    it('fills missing days with zero counts', () => {
        const filled = fillActivityDateRange(
            [
                {
                    activityDate: '2026-05-24',
                    messageCount: 3,
                    reactionCount: 0,
                    photoUploadCount: 1,
                },
            ],
            '2026-05-24',
            '2026-05-26'
        );

        expect(filled).toEqual([
            {
                activityDate: '2026-05-24',
                messageCount: 3,
                reactionCount: 0,
                photoUploadCount: 1,
            },
            {
                activityDate: '2026-05-25',
                messageCount: 0,
                reactionCount: 0,
                photoUploadCount: 0,
            },
            {
                activityDate: '2026-05-26',
                messageCount: 0,
                reactionCount: 0,
                photoUploadCount: 0,
            },
        ]);
    });

    it('sums activity across buckets', () => {
        expect(
            sumDailyActivity([
                {
                    activityDate: '2026-05-24',
                    messageCount: 3,
                    reactionCount: 1,
                    photoUploadCount: 0,
                },
                {
                    activityDate: '2026-05-25',
                    messageCount: 2,
                    reactionCount: 4,
                    photoUploadCount: 1,
                },
            ])
        ).toEqual({
            activityDate: 'total',
            messageCount: 5,
            reactionCount: 5,
            photoUploadCount: 1,
        });
    });

    it('sums xp across events', () => {
        expect(
            sumEventXp([
                makeEvent({ id: 1, occurredAt: new Date(), xpAmount: 15 }),
                makeEvent({ id: 2, occurredAt: new Date(), xpAmount: 25 }),
            ])
        ).toBe(40);
    });

    it('filters events to an inclusive activity-date range', () => {
        const events = [
            makeEvent({ id: 1, occurredAt: new Date('2026-05-19T12:00:00Z') }),
            makeEvent({ id: 2, occurredAt: new Date('2026-05-20T12:00:00Z') }),
            makeEvent({ id: 3, occurredAt: new Date('2026-05-27T12:00:00Z') }),
        ];

        expect(filterEventsByActivityDateRange(events, '2026-05-20', '2026-05-26')).toEqual([
            events[1],
        ]);
    });

    it('rolls daily buckets into weekly chart buckets', () => {
        const dailyBuckets = fillActivityDateRange(
            [
                {
                    activityDate: '2026-01-01',
                    messageCount: 1,
                    reactionCount: 0,
                    photoUploadCount: 0,
                },
                {
                    activityDate: '2026-01-08',
                    messageCount: 2,
                    reactionCount: 1,
                    photoUploadCount: 0,
                },
            ],
            '2026-01-01',
            '2026-01-14'
        );

        expect(aggregateDailyIntoWeeklyBuckets(dailyBuckets)).toEqual([
            {
                activityDate: '2026-01-01',
                messageCount: 1,
                reactionCount: 0,
                photoUploadCount: 0,
            },
            {
                activityDate: '2026-01-08',
                messageCount: 2,
                reactionCount: 1,
                photoUploadCount: 0,
            },
        ]);
    });

    it('aggregates raw events into lifetime totals', () => {
        expect(
            aggregateActivityTotals([
                makeEvent({ id: 1, occurredAt: new Date('2026-05-24T18:00:00Z'), xpAmount: 15 }),
                makeEvent({
                    id: 2,
                    occurredAt: new Date('2026-05-24T20:00:00Z'),
                    xpAmount: 0,
                    photoBonus: true,
                }),
                makeEvent({
                    id: 3,
                    activityType: 'reaction',
                    messageLength: null,
                    occurredAt: new Date('2026-05-25T12:00:00Z'),
                    xpAmount: 1,
                }),
            ])
        ).toEqual({
            activityDate: 'total',
            messageCount: 2,
            reactionCount: 1,
            photoUploadCount: 1,
            totalXp: 16,
            eventCount: 3,
        });
    });
});
