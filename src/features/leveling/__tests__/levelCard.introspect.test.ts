/**
 * Local card preview — edit PREVIEW_SCENARIO below, then run:
 *
 *   pnpm test levelCard.introspect
 *
 * Writes `.jarvis/level-card-preview.png` (open in your image viewer).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LevelingActivityTotals } from '../data/levelingActivityEventSchema';
import type { LevelingProgress } from '../data/levelingProgressSchema';
import { renderLevelCard } from '../cards/levelCard/renderLevelCard';
import { buildUserLevelProfile } from '../logic/userLevelProfile';

const PREVIEW_OUTPUT = join(process.cwd(), '.jarvis', 'level-card-preview.png');

/** Edit display name, avatar URL, and stats to iterate on card layout locally. */
const PREVIEW_SCENARIO = {
    displayName: 'Spicy Member',
    avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png?size=256',
    progress: {
        id: 1,
        guildId: 'preview-guild',
        userId: 'preview-user',
        totalXp: 2_140,
        level: 8,
        messageCount: 120,
        reactionCount: 45,
        photoUploadCount: 6,
        lastMessageXpAt: null,
        lastReactionXpAt: null,
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-01T00:00:00Z'),
    } satisfies LevelingProgress,
    recentActivity: {
        activityDate: 'total',
        messageCount: 18,
        reactionCount: 7,
        photoUploadCount: 2,
        totalXp: 320,
        eventCount: 27,
    } satisfies LevelingActivityTotals,
    totalActivity: {
        activityDate: 'total',
        messageCount: 120,
        reactionCount: 45,
        photoUploadCount: 6,
        totalXp: 2_140,
        eventCount: 171,
    } satisfies LevelingActivityTotals,
};

describe('level card introspection', () => {
    it('writes a PNG preview for local card tuning', async () => {
        const profile = buildUserLevelProfile({
            userId: PREVIEW_SCENARIO.progress.userId,
            progress: PREVIEW_SCENARIO.progress,
            recentActivity: PREVIEW_SCENARIO.recentActivity,
            totalActivity: PREVIEW_SCENARIO.totalActivity,
        });

        const png = await renderLevelCard({
            profile,
            displayName: PREVIEW_SCENARIO.displayName,
            avatarUrl: PREVIEW_SCENARIO.avatarUrl,
        });

        await mkdir(join(process.cwd(), '.jarvis'), { recursive: true });
        await writeFile(PREVIEW_OUTPUT, png);

        console.log(`\nLevel card preview written to:\n  ${PREVIEW_OUTPUT}\n`);

        expect(png.byteLength).toBeGreaterThan(1_000);
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }, 30_000);
});
