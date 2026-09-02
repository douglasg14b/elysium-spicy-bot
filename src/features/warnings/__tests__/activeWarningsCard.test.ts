import { describe, expect, it } from 'vitest';
import { getActiveWarningsCardHeight } from '../cards/activeWarningsCard/activeWarningsCardConstants';
import { buildActiveWarningsCardElement } from '../cards/activeWarningsCard/buildActiveWarningsCardElement';

describe('buildActiveWarningsCardElement', () => {
    it('renders per-member counts on the default summary card', () => {
        const element = buildActiveWarningsCardElement({
            kind: 'summary',
            guildName: 'Spicy Server',
            totalWarnings: 12,
            totalMembers: 8,
            entries: [
                {
                    userId: 'user-1',
                    warningCount: 3,
                    soonestExpiresAt: new Date('2026-09-15T00:00:00.000Z'),
                    displayName: 'Brat One',
                    avatarDataUri: null,
                },
            ],
        });

        const serialized = JSON.stringify(element);

        expect(serialized).toContain('Active Warnings — Spicy Server');
        expect(serialized).toContain('Brat One');
        expect(serialized).toContain('3');
        expect(serialized).toContain('2026-09-15');
        expect(serialized).toContain('12 active · 8 members · 7 more not shown');
        expect(serialized).not.toContain('consent-k7m2');
        expect(getActiveWarningsCardHeight(10)).toBeGreaterThan(getActiveWarningsCardHeight(1));
    });

    it('renders slug, rule, and expiry for one member', () => {
        const element = buildActiveWarningsCardElement({
            kind: 'member',
            memberName: 'Brat One',
            totalActive: 2,
            entries: [
                {
                    slug: 'consent-k7m2',
                    rule: 'Consent',
                    expiresAt: new Date('2027-03-01T00:00:00.000Z'),
                },
            ],
        });

        const serialized = JSON.stringify(element);

        expect(serialized).toContain('Active Warnings — Brat One');
        expect(serialized).toContain('consent-k7m2');
        expect(serialized).toContain('Consent');
        expect(serialized).toContain('2027-03-01');
        expect(serialized).toContain('2 active · 1 more not shown');
    });

    it('shows an empty state when nobody is warned', () => {
        const element = buildActiveWarningsCardElement({
            kind: 'summary',
            guildName: 'Spicy Server',
            entries: [],
            totalWarnings: 0,
            totalMembers: 0,
        });

        expect(JSON.stringify(element)).toContain('Nobody is in the doghouse right now.');
    });
});
