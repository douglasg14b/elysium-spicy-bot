import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RecordXpGrantInput } from '../data/levelingXpGrantRepo';

const { database } = await import('../../../features-system/data-persistence/database');
const { migrateTestDatabase } = await import(
    '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase'
);
const { levelingXpGrantRepo } = await import('../data/levelingXpGrantRepo');
const { aggregateActivityTotals } = await import('../logic/activityEventAggregation');

/**
 * `getUserActivityTotals` sums in SQL, against the real migrated schema and plugin stack.
 *
 * The JS fold over every row it replaced is the reference: each case asserts the aggregate
 * equals `aggregateActivityTotals` over the same member's rows, so the two cannot drift
 * apart on how a `flow` grant or a photo bonus is counted. Only the sqlite arm runs; the
 * postgres string-typed sums are covered by the `Number()` conversions, hand-reviewed.
 */

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

async function grant(input: Partial<RecordXpGrantInput> & Pick<RecordXpGrantInput, 'activityType' | 'xpAmount'>): Promise<void> {
    await database.transaction().execute((transaction) =>
        levelingXpGrantRepo.recordXpGrant(transaction, { guildId: GUILD_ID, userId: USER_ID, ...input })
    );
}

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('leveling_xp_grants').execute();
});

describe('levelingXpGrantRepo.getUserActivityTotals', () => {
    it('matches the JS fold over every kind of grant, photo bonuses and flow XP included', async () => {
        await grant({ activityType: 'message', xpAmount: 15, occurredAt: new Date('2026-10-01T10:00:00Z') });
        await grant({
            activityType: 'message',
            xpAmount: 25,
            photoBonusApplied: true,
            occurredAt: new Date('2026-10-02T10:00:00Z'),
        });
        await grant({ activityType: 'reaction', xpAmount: 2, occurredAt: new Date('2026-10-03T10:00:00Z') });
        await grant({ activityType: 'voice', xpAmount: 40, occurredAt: new Date('2026-10-04T10:00:00Z') });
        await grant({ activityType: 'flow', xpAmount: 100, occurredAt: new Date('2026-10-05T10:00:00Z') });
        // Another member's and another guild's grants must not leak in.
        await grant({ activityType: 'message', xpAmount: 999, userId: 'user-2' });
        await grant({ activityType: 'message', xpAmount: 999, guildId: 'guild-2' });

        const totals = await levelingXpGrantRepo.getUserActivityTotals(GUILD_ID, USER_ID);

        expect(totals).toEqual({
            activityDate: 'total',
            messageCount: 2,
            reactionCount: 1,
            photoUploadCount: 1,
            voiceSessionCount: 1,
            totalXp: 182,
            eventCount: 5,
        });
        expect(totals).toEqual(aggregateActivityTotals(await levelingXpGrantRepo.getUserEvents(GUILD_ID, USER_ID)));
    });

    it('answers zeros, not NaN or null, for a member with no grants', async () => {
        const totals = await levelingXpGrantRepo.getUserActivityTotals(GUILD_ID, USER_ID);

        expect(totals).toEqual(aggregateActivityTotals([]));
    });

    it('counts only grants on or after `since`', async () => {
        await grant({ activityType: 'message', xpAmount: 15, occurredAt: new Date('2026-09-01T10:00:00Z') });
        await grant({ activityType: 'reaction', xpAmount: 2, occurredAt: new Date('2026-10-10T10:00:00Z') });

        const since = new Date('2026-10-01T00:00:00Z');
        const totals = await levelingXpGrantRepo.getUserActivityTotals(GUILD_ID, USER_ID, { since });

        expect(totals).toMatchObject({ messageCount: 0, reactionCount: 1, totalXp: 2, eventCount: 1 });
        expect(totals).toEqual(aggregateActivityTotals(await levelingXpGrantRepo.getUserEvents(GUILD_ID, USER_ID, { since })));
    });
});
