import { getLocalDateKey } from '../../birthday-tracker/birthdayCelebration';
import { LEVELING_TIMEZONE } from '../../../environment';
import type {
    DailyActivityBucket,
    DailyXpBucket,
    LevelingActivityEvent,
    LevelingActivityTotals,
} from '../data/levelingActivityEventSchema';

export function getActivityDateKey(date: Date): string {
    return getLocalDateKey(date, LEVELING_TIMEZONE);
}

export function emptyDailyActivityBucket(activityDate: string): DailyActivityBucket {
    return {
        activityDate,
        messageCount: 0,
        reactionCount: 0,
        photoUploadCount: 0,
        voiceSessionCount: 0,
    };
}

export function aggregateEventsByDate(events: ReadonlyArray<LevelingActivityEvent>): DailyXpBucket[] {
    const buckets = new Map<string, DailyXpBucket>();

    for (const event of events) {
        const activityDate = getActivityDateKey(toDate(event.occurredAt));
        const bucket = buckets.get(activityDate) ?? {
            ...emptyDailyActivityBucket(activityDate),
            totalXp: 0,
        };

        bucket.totalXp += event.xpAmount;

        switch (event.activityType) {
            case 'message':
                bucket.messageCount += 1;
                break;
            case 'reaction':
                bucket.reactionCount += 1;
                break;
            case 'voice':
                bucket.voiceSessionCount += 1;
                break;
        }

        if (event.photoBonus) {
            bucket.photoUploadCount += 1;
        }

        buckets.set(activityDate, bucket);
    }

    return [...buckets.values()].sort((left, right) => left.activityDate.localeCompare(right.activityDate));
}

export function fillActivityDateRange(
    buckets: ReadonlyArray<DailyActivityBucket>,
    startDate: string,
    endDate: string
): DailyActivityBucket[] {
    const byDate = new Map(buckets.map((bucket) => [bucket.activityDate, bucket]));
    const filled: DailyActivityBucket[] = [];

    for (const activityDate of iterateActivityDates(startDate, endDate)) {
        filled.push(byDate.get(activityDate) ?? emptyDailyActivityBucket(activityDate));
    }

    return filled;
}

export function sumDailyActivity(buckets: ReadonlyArray<DailyActivityBucket>): DailyActivityBucket {
    return buckets.reduce(
        (totals, bucket) => ({
            activityDate: 'total',
            messageCount: totals.messageCount + bucket.messageCount,
            reactionCount: totals.reactionCount + bucket.reactionCount,
            photoUploadCount: totals.photoUploadCount + bucket.photoUploadCount,
            voiceSessionCount: totals.voiceSessionCount + bucket.voiceSessionCount,
        }),
        emptyDailyActivityBucket('total')
    );
}

export function sumEventXp(events: ReadonlyArray<LevelingActivityEvent>): number {
    return events.reduce((total, event) => total + event.xpAmount, 0);
}

export function aggregateActivityTotals(events: ReadonlyArray<LevelingActivityEvent>): LevelingActivityTotals {
    return events.reduce<LevelingActivityTotals>(
        (totals, event) => {
            totals.eventCount += 1;
            totals.totalXp += event.xpAmount;

            switch (event.activityType) {
                case 'message':
                    totals.messageCount += 1;
                    break;
                case 'reaction':
                    totals.reactionCount += 1;
                    break;
                case 'voice':
                    totals.voiceSessionCount += 1;
                    break;
            }

            if (event.photoBonus) {
                totals.photoUploadCount += 1;
            }

            return totals;
        },
        {
            ...emptyDailyActivityBucket('total'),
            totalXp: 0,
            eventCount: 0,
        }
    );
}

export function subtractActivityDays(from: Date, days: number): Date {
    const result = new Date(from);
    result.setUTCDate(result.getUTCDate() - days);
    return result;
}

export function getActivityDateStart(dateKey: string): Date {
    return parseActivityDate(dateKey);
}

export function filterEventsByActivityDateRange(
    events: ReadonlyArray<LevelingActivityEvent>,
    startDate: string,
    endDate: string
): LevelingActivityEvent[] {
    return events.filter((event) => {
        const activityDate = getActivityDateKey(toDate(event.occurredAt));
        return activityDate >= startDate && activityDate <= endDate;
    });
}

export function aggregateDailyIntoWeeklyBuckets(
    dailyBuckets: ReadonlyArray<DailyActivityBucket>
): DailyActivityBucket[] {
    if (dailyBuckets.length === 0) {
        return [];
    }

    const weeklyBuckets: DailyActivityBucket[] = [];

    for (let index = 0; index < dailyBuckets.length; index += 7) {
        const weekDays = dailyBuckets.slice(index, index + 7);
        const totals = sumDailyActivity(weekDays);

        weeklyBuckets.push({
            activityDate: weekDays[0].activityDate,
            messageCount: totals.messageCount,
            reactionCount: totals.reactionCount,
            photoUploadCount: totals.photoUploadCount,
            voiceSessionCount: totals.voiceSessionCount,
        });
    }

    return weeklyBuckets;
}

function toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}

function* iterateActivityDates(startDate: string, endDate: string): Generator<string> {
    const start = parseActivityDate(startDate);
    const end = parseActivityDate(endDate);

    if (start > end) {
        return;
    }

    const cursor = new Date(start);
    while (cursor <= end) {
        yield formatActivityDate(cursor);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
}

function parseActivityDate(dateKey: string): Date {
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}

function formatActivityDate(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
