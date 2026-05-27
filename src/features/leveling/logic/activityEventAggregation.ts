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

export function aggregateEventsByDate(events: ReadonlyArray<LevelingActivityEvent>): DailyXpBucket[] {
    const buckets = new Map<string, DailyXpBucket>();

    for (const event of events) {
        const activityDate = getActivityDateKey(toDate(event.occurredAt));
        const bucket = buckets.get(activityDate) ?? {
            activityDate,
            messageCount: 0,
            reactionCount: 0,
            photoUploadCount: 0,
            totalXp: 0,
        };

        bucket.totalXp += event.xpAmount;

        if (event.activityType === 'message') {
            bucket.messageCount += 1;
        } else {
            bucket.reactionCount += 1;
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
        const existing = byDate.get(activityDate);
        filled.push(
            existing ?? {
                activityDate,
                messageCount: 0,
                reactionCount: 0,
                photoUploadCount: 0,
            }
        );
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
        }),
        {
            activityDate: 'total',
            messageCount: 0,
            reactionCount: 0,
            photoUploadCount: 0,
        }
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

            if (event.activityType === 'message') {
                totals.messageCount += 1;
            } else {
                totals.reactionCount += 1;
            }

            if (event.photoBonus) {
                totals.photoUploadCount += 1;
            }

            return totals;
        },
        {
            activityDate: 'total',
            messageCount: 0,
            reactionCount: 0,
            photoUploadCount: 0,
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
