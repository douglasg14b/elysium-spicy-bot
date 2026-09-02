import { describe, expect, it } from 'vitest';
import { getActiveWarningsCardHeight } from '../cards/activeWarningsCard/activeWarningsCardConstants';
import { buildActiveWarningsCardElement } from '../cards/activeWarningsCard/buildActiveWarningsCardElement';

describe('buildActiveWarningsCardElement', () => {
    it('renders slug, member, rule, and expiry columns', () => {
        const element = buildActiveWarningsCardElement({
            guildName: 'Spicy Server',
            totalActive: 12,
            entries: [
                {
                    slug: 'consent-k7m2',
                    userId: 'user-1',
                    rule: 'Consent',
                    expiresAt: new Date('2027-03-01T00:00:00.000Z'),
                    displayName: 'Brat One',
                    avatarDataUri: null,
                },
            ],
        });

        const serialized = JSON.stringify(element);

        expect(serialized).toContain('Active Warnings — Spicy Server');
        expect(serialized).toContain('consent-k7m2');
        expect(serialized).toContain('Brat One');
        expect(serialized).toContain('Consent');
        expect(serialized).toContain('2027-03-01');
        expect(serialized).toContain('11 more not shown');
        expect(getActiveWarningsCardHeight(10)).toBeGreaterThan(getActiveWarningsCardHeight(1));
    });

    it('shows an empty state when nobody is warned', () => {
        const element = buildActiveWarningsCardElement({
            guildName: 'Spicy Server',
            entries: [],
            totalActive: 0,
        });

        expect(JSON.stringify(element)).toContain('Nobody is in the doghouse right now.');
    });
});
