/**
 * Local rankings card preview — edit PREVIEW_SCENARIO below, then run:
 *
 *   pnpm test rankingsCard.introspect
 *
 * Writes `.jarvis/rankings-card-preview.png`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderRankingsCard } from '../cards/rankingsCard/renderRankingsCard';

const PREVIEW_OUTPUT = join(process.cwd(), '.jarvis', 'rankings-card-preview.png');

const PREVIEW_SCENARIO = {
    guildName: 'Spicy Server',
    rankings: {
        entries: [
            {
                rank: 1,
                userId: '123456789012345601',
                totalXp: 12_480,
                level: 18,
                messageCount: 420,
                reactionCount: 180,
                photoUploadCount: 22,
                lastActiveAt: new Date('2026-05-26T09:15:00Z'),
            },
            {
                rank: 2,
                userId: '123456789012345602',
                totalXp: 10_920,
                level: 17,
                messageCount: 360,
                reactionCount: 150,
                photoUploadCount: 18,
                lastActiveAt: new Date('2026-05-26T08:40:00Z'),
            },
            {
                rank: 3,
                userId: '123456789012345603',
                totalXp: 9_640,
                level: 16,
                messageCount: 310,
                reactionCount: 120,
                photoUploadCount: 14,
                lastActiveAt: new Date('2026-05-25T22:10:00Z'),
            },
            {
                rank: 4,
                userId: '123456789012345604',
                totalXp: 8_210,
                level: 15,
                messageCount: 280,
                reactionCount: 95,
                photoUploadCount: 11,
                lastActiveAt: new Date('2026-05-25T19:00:00Z'),
            },
            {
                rank: 5,
                userId: '123456789012345605',
                totalXp: 7_540,
                level: 14,
                messageCount: 240,
                reactionCount: 88,
                photoUploadCount: 9,
                lastActiveAt: new Date('2026-05-25T14:20:00Z'),
            },
            {
                rank: 6,
                userId: '123456789012345606',
                totalXp: 6_880,
                level: 13,
                messageCount: 210,
                reactionCount: 72,
                photoUploadCount: 8,
                lastActiveAt: new Date('2026-05-24T16:45:00Z'),
            },
            {
                rank: 7,
                userId: '123456789012345607',
                totalXp: 5_920,
                level: 12,
                messageCount: 180,
                reactionCount: 64,
                photoUploadCount: 6,
                lastActiveAt: new Date('2026-05-24T11:30:00Z'),
            },
            {
                rank: 8,
                userId: '123456789012345608',
                totalXp: 4_760,
                level: 11,
                messageCount: 150,
                reactionCount: 52,
                photoUploadCount: 5,
                lastActiveAt: new Date('2026-05-23T20:05:00Z'),
            },
            {
                rank: 9,
                userId: '123456789012345609',
                totalXp: 3_980,
                level: 10,
                messageCount: 120,
                reactionCount: 41,
                photoUploadCount: 4,
                lastActiveAt: new Date('2026-05-23T09:50:00Z'),
            },
            {
                rank: 10,
                userId: '123456789012345610',
                totalXp: 3_120,
                level: 9,
                messageCount: 95,
                reactionCount: 33,
                photoUploadCount: 3,
                lastActiveAt: new Date('2026-05-22T18:15:00Z'),
            },
        ],
        totalRankedMembers: 142,
    },
    members: [
        { userId: '123456789012345601', displayName: 'CrownHolder', avatarUrl: null },
        { userId: '123456789012345602', displayName: 'SecondWind', avatarUrl: null },
        { userId: '123456789012345603', displayName: 'BronzeFox', avatarUrl: null },
        { userId: '123456789012345604', displayName: 'ChatGoblin', avatarUrl: null },
        { userId: '123456789012345605', displayName: 'ReactionQueen', avatarUrl: null },
        { userId: '123456789012345606', displayName: 'PixelDropper', avatarUrl: null },
        { userId: '123456789012345607', displayName: 'LurkerNoMore', avatarUrl: null },
        { userId: '123456789012345608', displayName: 'SlowClimb', avatarUrl: null },
        { userId: '123456789012345609', displayName: 'AlmostThere', avatarUrl: null },
        { userId: '123456789012345610', displayName: 'TenthPlace', avatarUrl: null },
    ],
};

describe('rankings card introspection', () => {
    it('writes a PNG preview for local rankings card tuning', async () => {
        const png = await renderRankingsCard(PREVIEW_SCENARIO);

        await mkdir(join(process.cwd(), '.jarvis'), { recursive: true });
        await writeFile(PREVIEW_OUTPUT, png);

        console.log(`\nRankings card preview written to:\n  ${PREVIEW_OUTPUT}\n`);

        expect(png.byteLength).toBeGreaterThan(1_000);
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }, 30_000);
});
