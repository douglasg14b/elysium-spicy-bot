import { describe, expect, it } from 'vitest';
import { buildRankingsCardElement } from '../cards/rankingsCard/buildRankingsCardElement';

function makeEntry(
    rank: number,
    overrides: Partial<{
        displayName: string;
        userId: string;
        totalXp: number;
        level: number;
        messageCount: number;
        reactionCount: number;
        photoUploadCount: number;
        lastActiveAt: Date | null;
    }> = {}
) {
    return {
        rank,
        userId: overrides.userId ?? `user-${rank}`,
        totalXp: overrides.totalXp ?? 5000 - rank * 300,
        level: overrides.level ?? 20 - rank,
        messageCount: overrides.messageCount ?? 100 - rank * 5,
        reactionCount: overrides.reactionCount ?? 40 - rank * 2,
        photoUploadCount: overrides.photoUploadCount ?? 5,
        lastActiveAt: overrides.lastActiveAt ?? new Date('2026-05-26T10:00:00Z'),
        displayName: overrides.displayName ?? `Member ${rank}`,
        avatarDataUri: null,
    };
}

describe('buildRankingsCardElement', () => {
    it('renders a dense table with avatars and activity columns', () => {
        const entries = Array.from({ length: 10 }, (_, index) => makeEntry(index + 1));

        const element = buildRankingsCardElement({
            guildName: 'Spicy Server',
            entries,
            totalRankedMembers: 128,
            now: new Date('2026-05-26T12:00:00Z'),
        });

        const serialized = JSON.stringify(element);

        expect(serialized).toContain('Level Rankings — Spicy Server');
        expect(serialized).toContain('Total XP');
        expect(serialized).toContain('Member 10');
        expect(serialized).toContain('Last active');
        expect(serialized).not.toContain('Shown total:');
        expect(serialized).not.toContain('user-10');
    });

    it('shows an empty state when nobody is ranked', () => {
        const element = buildRankingsCardElement({
            guildName: 'Spicy Server',
            entries: [],
            totalRankedMembers: 0,
        });

        expect(JSON.stringify(element)).toContain('No ranked members in this server yet.');
    });
});
