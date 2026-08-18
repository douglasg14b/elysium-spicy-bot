import { describe, expect, it } from 'vitest';
import { serializeVoiceSession, toVoiceSessionRow } from '../data/levelingVoiceSessionRepo';
import type { LevelingVoiceSession } from '../data/levelingVoiceSessionSchema';

describe('levelingVoiceSessionRepo helpers', () => {
    const sessionStartedAt = new Date('2026-08-17T11:00:00.000Z');
    const eligibleSince = new Date('2026-08-17T11:05:00.000Z');
    const updatedAt = new Date('2026-08-17T11:10:00.000Z');

    it('serializes a session for upsert and maps a row back', () => {
        const serialized = serializeVoiceSession(
            {
                guildId: 'guild-1',
                userId: 'user-1',
                channelId: 'channel-1',
                sessionStartedAt,
                eligibleAccumulatorMs: 12_000,
                eligibleSince,
            },
            updatedAt
        );

        expect(serialized).toEqual({
            guildId: 'guild-1',
            userId: 'user-1',
            channelId: 'channel-1',
            sessionStartedAt: sessionStartedAt.toISOString(),
            eligibleAccumulatorMs: 12_000,
            eligibleSince: eligibleSince.toISOString(),
            updatedAt: updatedAt.toISOString(),
        });

        const mapped = toVoiceSessionRow({
            id: 1,
            guildId: serialized.guildId,
            userId: serialized.userId,
            channelId: serialized.channelId,
            sessionStartedAt,
            eligibleAccumulatorMs: serialized.eligibleAccumulatorMs,
            eligibleSince,
            updatedAt,
        } satisfies LevelingVoiceSession);

        expect(mapped.eligibleAccumulatorMs).toBe(12_000);
        expect(mapped.eligibleSince).toEqual(eligibleSince);
    });

    it('serializes a null eligibleSince for alone sessions', () => {
        const serialized = serializeVoiceSession(
            {
                guildId: 'guild-1',
                userId: 'user-1',
                channelId: 'channel-1',
                sessionStartedAt,
                eligibleAccumulatorMs: 0,
                eligibleSince: null,
            },
            updatedAt
        );

        expect(serialized.eligibleSince).toBeNull();
    });
});
