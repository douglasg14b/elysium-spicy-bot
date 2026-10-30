import type { Warning } from '../../data/warningsSchema';

/** An active, never-edited warning row as the repo reads it, for tests to override. */
export function sampleWarning(overrides: Partial<Warning> = {}): Warning {
    return {
        id: 1,
        guildId: 'guild-1',
        userId: 'user-1',
        userName: 'Kitten',
        issuerId: 'mod-1',
        issuerName: 'Mistress',
        slug: 'consent-k7m2',
        rule: 'Consent',
        description: 'Pushed past a no.',
        issuedAt: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: new Date('2027-03-01T00:00:00.000Z'),
        clearedAt: null,
        clearedById: null,
        clearedByName: null,
        clearReason: null,
        editedAt: null,
        editedById: null,
        editedByName: null,
        createdAt: new Date('2026-09-01T20:00:00.000Z'),
        ...overrides,
    };
}
