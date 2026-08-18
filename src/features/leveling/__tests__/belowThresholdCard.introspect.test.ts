/**
 * Local below-threshold card preview — edit PREVIEW_SCENARIO below, then run:
 *
 *   pnpm test belowThresholdCard.introspect
 *
 * Writes `.jarvis/below-threshold-card-preview.png`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBelowThresholdCard } from '../cards/belowThresholdCard/renderBelowThresholdCard';
import {
    buildBelowThresholdReport,
    type GuildMemberSnapshot,
} from '../logic/belowThresholdReport';
import type { LevelingProgress } from '../data/levelingProgressSchema';

const PREVIEW_OUTPUT = join(process.cwd(), '.jarvis', 'below-threshold-card-preview.png');

function makeMember(userId: string, displayName: string): GuildMemberSnapshot {
    return {
        userId,
        displayName,
        username: displayName.toLowerCase().replaceAll(' ', ''),
        isBot: false,
        avatarUrl: null,
    };
}

function makeProgress(userId: string, totalXp: number, level: number): LevelingProgress {
    return {
        id: 1,
        guildId: 'guild-1',
        userId,
        totalXp,
        level,
        messageCount: Math.max(4, Math.round(totalXp / 40)),
        reactionCount: Math.max(1, Math.round(totalXp / 120)),
        photoUploadCount: 1,
        lastMessageXpAt: new Date('2026-05-26T09:15:00Z'),
        lastReactionXpAt: null,
        voiceSessionCount: 0,
        totalVoiceSeconds: 0,
        lastVoiceXpAt: null,
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-26T09:15:00Z'),
    };
}

const members = [
    makeMember('1', 'AlmostThere'),
    makeMember('2', 'SlowClimb'),
    makeMember('3', 'ChatGoblin'),
    makeMember('4', 'LurkerNoMore'),
    makeMember('5', 'ReactionQueen'),
    makeMember('6', 'PixelDropper'),
    makeMember('7', 'BronzeFox'),
    makeMember('8', 'SecondWind'),
    makeMember('9', 'QuietOne'),
    makeMember('10', 'NewKid'),
    makeMember('11', 'Ghost'),
];

const progressRows = [
    makeProgress('1', 2_840, 9),
    makeProgress('2', 2_410, 8),
    makeProgress('3', 1_980, 7),
    makeProgress('4', 1_620, 7),
    makeProgress('5', 1_240, 6),
    makeProgress('6', 980, 5),
    makeProgress('7', 720, 4),
    makeProgress('8', 480, 3),
    makeProgress('9', 210, 2),
    makeProgress('10', 80, 1),
];

const PREVIEW_SCENARIO = {
    guildName: 'Spicy Server',
    report: buildBelowThresholdReport({
        filter: { level: 10, xp: null, scope: 'current' },
        members,
        progressRows,
    }),
};

describe('below-threshold card introspection', () => {
    it('writes a PNG preview for local below-threshold card tuning', async () => {
        const png = await renderBelowThresholdCard(PREVIEW_SCENARIO);

        await mkdir(join(process.cwd(), '.jarvis'), { recursive: true });
        await writeFile(PREVIEW_OUTPUT, png);

        console.log(`\nBelow-threshold card preview written to:\n  ${PREVIEW_OUTPUT}\n`);

        expect(png.byteLength).toBeGreaterThan(1_000);
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }, 30_000);
});
