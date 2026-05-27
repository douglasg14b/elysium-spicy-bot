import { describe, expect, it } from 'vitest';
import { computeXpGrant, getRecordedActivityXpAmount } from '../logic/xpGrant';

describe('computeXpGrant', () => {
    const grantedAt = new Date('2026-05-26T12:00:00.000Z');

    it('grants XP for a first-time user', () => {
        const result = computeXpGrant({
            existing: null,
            xpAmount: 20,
            activityType: 'message',
            cooldownMs: 60_000,
            grantedAt,
            incrementMessageCount: true,
        });

        expect(result).toEqual({
            previousTotalXp: 0,
            newTotalXp: 20,
            messageCount: 1,
            reactionCount: 0,
            photoUploadCount: 0,
            lastMessageXpAt: grantedAt,
            lastReactionXpAt: null,
        });
    });

    it('returns null when message cooldown is active', () => {
        const result = computeXpGrant({
            existing: {
                totalXp: 100,
                messageCount: 3,
                reactionCount: 0,
                photoUploadCount: 0,
                lastMessageXpAt: new Date('2026-05-26T11:59:30.000Z'),
                lastReactionXpAt: null,
            },
            xpAmount: 20,
            activityType: 'message',
            cooldownMs: 60_000,
            grantedAt,
            incrementMessageCount: true,
        });

        expect(result).toBeNull();
    });

    it('uses separate cooldown buckets for reactions', () => {
        const result = computeXpGrant({
            existing: {
                totalXp: 100,
                messageCount: 3,
                reactionCount: 1,
                photoUploadCount: 0,
                lastMessageXpAt: new Date('2026-05-26T11:59:30.000Z'),
                lastReactionXpAt: new Date('2026-05-26T11:59:00.000Z'),
            },
            xpAmount: 8,
            activityType: 'reaction',
            cooldownMs: 30_000,
            grantedAt,
            incrementReactionCount: true,
        });

        expect(result?.newTotalXp).toBe(108);
        expect(result?.reactionCount).toBe(2);
        expect(result?.lastMessageXpAt).toEqual(new Date('2026-05-26T11:59:30.000Z'));
        expect(result?.lastReactionXpAt).toEqual(grantedAt);
    });

    it('stacks photo upload counters on message grants', () => {
        const result = computeXpGrant({
            existing: {
                totalXp: 50,
                messageCount: 2,
                reactionCount: 0,
                photoUploadCount: 1,
                lastMessageXpAt: new Date('2026-05-26T11:00:00.000Z'),
                lastReactionXpAt: null,
            },
            xpAmount: 35,
            activityType: 'message',
            cooldownMs: 60_000,
            grantedAt,
            incrementMessageCount: true,
            incrementPhotoUploadCount: true,
        });

        expect(result?.newTotalXp).toBe(85);
        expect(result?.photoUploadCount).toBe(2);
    });

    it('records zero XP on the activity event when cooldown blocks the grant', () => {
        expect(getRecordedActivityXpAmount(null, 20)).toBe(0);
        expect(
            getRecordedActivityXpAmount(
                {
                    previousTotalXp: 0,
                    newTotalXp: 20,
                    messageCount: 1,
                    reactionCount: 0,
                    photoUploadCount: 0,
                    lastMessageXpAt: grantedAt,
                    lastReactionXpAt: null,
                },
                20
            )
        ).toBe(20);
    });
});
