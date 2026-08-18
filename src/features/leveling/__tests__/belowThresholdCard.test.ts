import { describe, expect, it } from 'vitest';
import { buildBelowThresholdCardElement } from '../cards/belowThresholdCard/buildBelowThresholdCardElement';
import type { BelowThresholdReportEntry } from '../logic/belowThresholdReport';

function makeEntry(
    rank: number,
    overrides: Partial<BelowThresholdReportEntry> = {}
): BelowThresholdReportEntry & { rank: number; avatarDataUri: string | null } {
    return {
        userId: overrides.userId ?? `user-${rank}`,
        displayName: overrides.displayName ?? `Member ${rank}`,
        username: overrides.username ?? `user_${rank}`,
        avatarUrl: null,
        totalXp: overrides.totalXp ?? 900 - rank * 80,
        level: overrides.level ?? 6 - Math.min(rank, 5),
        messageCount: overrides.messageCount ?? 40 - rank,
        reactionCount: overrides.reactionCount ?? 12 - rank,
        photoUploadCount: overrides.photoUploadCount ?? 1,
        lastActiveAt: overrides.lastActiveAt ?? new Date('2026-05-26T10:00:00Z'),
        xpToThreshold: overrides.xpToThreshold ?? rank * 80,
        tracked: overrides.tracked ?? true,
        rank,
        avatarDataUri: null,
    };
}

describe('buildBelowThresholdCardElement', () => {
    it('renders closest-to-bar rows with a to-go column', () => {
        const cardEntries = Array.from({ length: 10 }, (_, index) => makeEntry(index + 1));
        const extras: BelowThresholdReportEntry[] = Array.from({ length: 37 }, (_, index) => ({
            userId: `extra-${index}`,
            displayName: `Extra ${index}`,
            username: `extra_${index}`,
            avatarUrl: null,
            totalXp: 10,
            level: 1,
            messageCount: 1,
            reactionCount: 0,
            photoUploadCount: 0,
            lastActiveAt: null,
            xpToThreshold: 2000,
            tracked: false,
        }));

        const element = buildBelowThresholdCardElement({
            guildName: 'Spicy Server',
            report: {
                filter: { level: 10, xp: null, scope: 'current' },
                totalConsidered: 47,
                entries: [...cardEntries, ...extras],
            },
            cardEntries,
            now: new Date('2026-05-26T12:00:00Z'),
        });

        const serialized = JSON.stringify(element);

        expect(serialized).toContain('Below Threshold — Spicy Server');
        expect(serialized).toContain('47 of 47 current members below level 10');
        expect(serialized).toContain('showing 10 closest');
        expect(serialized).toContain('To go');
        expect(serialized).toContain('Member 10');
        expect(serialized).not.toContain('user-10');
    });

    it('shows an empty state when nobody is below the bar', () => {
        const element = buildBelowThresholdCardElement({
            guildName: 'Spicy Server',
            report: {
                filter: { level: 10, xp: null, scope: 'tracked' },
                totalConsidered: 20,
                entries: [],
            },
            cardEntries: [],
        });

        const serialized = JSON.stringify(element);
        expect(serialized).toContain('Nobody is below level 10 among tracked members');
        expect(serialized).toContain('Everyone is at or above this threshold.');
    });
});
