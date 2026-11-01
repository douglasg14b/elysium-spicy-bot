import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from '../../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { warningsRepo } from '../../data/warningsRepo';
import { clearGuildWarning } from '../clearGuildWarning';
import { editGuildWarning, type EditGuildWarningInput } from '../editGuildWarning';
import { issueGuildWarning } from '../issueGuildWarning';
import { warningStatus } from '../warningStatus';

/**
 * The three write paths — issue, release, edit — on the real repo and the migrated
 * in-memory database, since what each records (and refuses) is a fact about the row.
 *
 * "Now" is the afternoon of 2026-09-01 in Los Angeles.
 */

const NOW = new Date('2026-09-01T20:00:00.000Z');
const MOD = { id: 'mod-2', name: 'Mistress' };

async function seed(slug: string, overrides: { issuedAt?: string; expiresAt?: string; clearedAt?: string } = {}) {
    return warningsRepo.insert({
        guildId: 'guild-1',
        userId: 'user-1',
        userName: 'Kitten',
        issuerId: 'mod-1',
        issuerName: 'Sir',
        slug,
        rule: 'Consent',
        description: 'Pushed past a no.',
        issuedAt: overrides.issuedAt ?? '2026-08-01T00:00:00.000Z',
        expiresAt: overrides.expiresAt ?? '2027-02-01T00:00:00.000Z',
        clearedAt: overrides.clearedAt ?? null,
        clearedById: overrides.clearedAt ? 'mod-1' : null,
        createdAt: '2026-08-01T00:00:00.000Z',
    });
}

function edit(overrides: Partial<EditGuildWarningInput> = {}): EditGuildWarningInput {
    return {
        guildId: 'guild-1',
        slug: 'consent-k7m2',
        rule: 'Consent',
        description: 'Pushed past a no.',
        dropsOffInput: '2027-02-01',
        baseEditedAt: null,
        editedBy: MOD,
        now: NOW,
        ...overrides,
    };
}

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('warnings').execute();
});

describe('issueGuildWarning', () => {
    it('records the names it was given', async () => {
        const result = await issueGuildWarning({
            guildId: 'guild-1',
            userId: 'user-1',
            userName: 'Kitten',
            issuerId: 'mod-1',
            issuerName: 'Sir',
            rule: 'Consent',
            description: 'Pushed past a no.',
            issuedInput: '',
            expiresInput: '',
            now: NOW,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.warning).toEqual(expect.objectContaining({ userName: 'Kitten', issuerName: 'Sir' }));
    });
});

describe('clearGuildWarning', () => {
    it('records who released it and why, trimmed', async () => {
        await seed('consent-k7m2');

        const result = await clearGuildWarning('guild-1', ' CONSENT-K7M2 ', MOD, '  Apologised nicely.  ', NOW);

        expect(result.status).toBe('cleared');
        expect(await warningsRepo.getByGuildAndSlug('guild-1', 'consent-k7m2')).toEqual(
            expect.objectContaining({
                clearedById: 'mod-2',
                clearedByName: 'Mistress',
                clearReason: 'Apologised nicely.',
                clearedAt: NOW,
            })
        );
    });

    it('releases an expired warning too', async () => {
        await seed('consent-k7m2', { issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-07-01T00:00:00.000Z' });

        expect((await clearGuildWarning('guild-1', 'consent-k7m2', MOD, 'Tidying up.', NOW)).status).toBe('cleared');
    });

    it('refuses a blank reason, releasing nothing', async () => {
        await seed('consent-k7m2');

        expect((await clearGuildWarning('guild-1', 'consent-k7m2', MOD, '   ', NOW)).status).toBe('empty-reason');
        expect((await warningsRepo.getByGuildAndSlug('guild-1', 'consent-k7m2'))?.clearedAt).toBeNull();
    });

    it('tells an already-released warning from one that is not there', async () => {
        await seed('consent-k7m2', { clearedAt: '2026-08-15T00:00:00.000Z' });

        expect((await clearGuildWarning('guild-1', 'consent-k7m2', MOD, 'Again.', NOW)).status).toBe('already-cleared');
        expect((await clearGuildWarning('guild-2', 'consent-k7m2', MOD, 'Elsewhere.', NOW)).status).toBe('not-found');
    });
});

describe('editGuildWarning', () => {
    it('changes the fields, records the editor and returns what changed', async () => {
        await seed('consent-k7m2');

        const result = await editGuildWarning(
            edit({ rule: ' Privacy ', description: 'Shared a screenshot.', dropsOffInput: '2027-06-01' })
        );

        expect(result).toEqual({
            ok: true,
            warning: expect.objectContaining({
                rule: 'Privacy',
                description: 'Shared a screenshot.',
                expiresAt: new Date('2027-06-01T00:00:00.000Z'),
                issuedAt: new Date('2026-08-01T00:00:00.000Z'),
                editedAt: NOW,
                editedById: 'mod-2',
                editedByName: 'Mistress',
            }),
            changes: [
                { field: 'rule', before: 'Consent', after: 'Privacy' },
                { field: 'description', before: 'Pushed past a no.', after: 'Shared a screenshot.' },
                { field: 'dropsOffOn', before: '2027-02-01', after: '2027-06-01' },
            ],
        });
    });

    it('refuses an edit that changes nothing, writing nothing', async () => {
        await seed('consent-k7m2');

        expect(await editGuildWarning(edit())).toEqual({ ok: false, kind: 'unchanged' });
        expect((await warningsRepo.getByGuildAndSlug('guild-1', 'consent-k7m2'))?.editedAt).toBeNull();
    });

    it('refuses an edit from a form loaded before another edit, as stale, and accepts it from a fresh one', async () => {
        await seed('consent-k7m2');
        const first = await editGuildWarning(edit({ rule: 'Harassment' }));
        if (!first.ok) throw new Error(`first edit refused: ${first.kind}`);

        // Loaded before the first edit: it still thinks the warning was never edited.
        expect(await editGuildWarning(edit({ rule: 'Privacy', baseEditedAt: null }))).toEqual({ ok: false, kind: 'stale' });
        expect((await warningsRepo.getByGuildAndSlug('guild-1', 'consent-k7m2'))?.rule).toBe('Harassment');

        const fresh = await editGuildWarning(
            edit({ rule: 'Privacy', baseEditedAt: first.warning.editedAt?.toISOString() ?? null })
        );
        expect(fresh.ok).toBe(true);
    });

    it('refuses an edit made from a read another edit has overtaken, as stale', async () => {
        const stale = await seed('consent-k7m2');
        await editGuildWarning(edit({ rule: 'Harassment' }));
        // This edit read the warning before the one above landed.
        const read = vi.spyOn(warningsRepo, 'getByGuildAndSlug').mockResolvedValueOnce(stale);

        const result = await editGuildWarning(edit({ rule: 'Privacy' }));
        read.mockRestore();

        expect(result).toEqual({ ok: false, kind: 'stale' });
        expect((await warningsRepo.getByGuildAndSlug('guild-1', 'consent-k7m2'))?.rule).toBe('Harassment');
    });

    it('refuses a released warning', async () => {
        await seed('consent-k7m2', { clearedAt: '2026-08-15T00:00:00.000Z' });

        expect(await editGuildWarning(edit({ rule: 'Privacy' }))).toEqual({ ok: false, kind: 'released' });
    });

    it("does not reach another server's warning", async () => {
        await seed('consent-k7m2');

        expect(await editGuildWarning(edit({ guildId: 'guild-2', rule: 'Privacy' }))).toEqual({
            ok: false,
            kind: 'not-found',
        });
    });

    it('holds a moved drop-off to the date rules, against the stored issued date', async () => {
        await seed('consent-k7m2');

        expect(await editGuildWarning(edit({ dropsOffInput: '2026-08-01' }))).toEqual({
            ok: false,
            kind: 'expires-not-after-issued',
        });
        expect(await editGuildWarning(edit({ dropsOffInput: '2026-08-20' }))).toEqual({
            ok: false,
            kind: 'expires-already-passed',
        });
        expect(await editGuildWarning(edit({ dropsOffInput: '2027-02-30' }))).toEqual({
            ok: false,
            kind: 'invalid-expires',
        });
    });

    it('refuses a blank rule or description', async () => {
        await seed('consent-k7m2');

        expect(await editGuildWarning(edit({ rule: '  ' }))).toEqual({ ok: false, kind: 'empty-rule' });
        expect(await editGuildWarning(edit({ description: '' }))).toEqual({ ok: false, kind: 'empty-description' });
    });

    it('edits an expired warning without reviving it, and revives it when its drop-off moves forward', async () => {
        await seed('consent-k7m2', { issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-07-01T00:00:00.000Z' });

        const typoFix = await editGuildWarning(edit({ description: 'Pushed past a clear no.', dropsOffInput: '2026-07-01' }));
        expect(typoFix.ok).toBe(true);
        if (!typoFix.ok) return;
        expect(warningStatus(typoFix.warning, NOW)).toBe('expired');

        const extended = await editGuildWarning(
            edit({
                description: 'Pushed past a clear no.',
                dropsOffInput: '2026-12-01',
                baseEditedAt: typoFix.warning.editedAt?.toISOString() ?? null,
            })
        );
        expect(extended.ok).toBe(true);
        if (!extended.ok) return;
        expect(warningStatus(extended.warning, NOW)).toBe('active');
    });
});
