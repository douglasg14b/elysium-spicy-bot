import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { database } from '../../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { calendarDateFromUtcMidnight, formatCalendarDate, getActiveAsOfUtcMidnight } from '../../logic/warningDates';
import { isWarningActive, warningStatus } from '../../logic/warningStatus';
import { WARNING_LIST_CAP, WarningsRepo } from '../warningsRepo';
import type { NewWarning } from '../warningsSchema';

/**
 * `WarningsRepo` against real SQLite: every migration, on the production `database` client
 * and its plugin stack. The status predicates, the search's escape clause and the
 * conditional writes are SQL no unit test can see the shape of.
 *
 * Only the SQLite arm runs here; Postgres is checked by hand (see the migration's test).
 */

const repo = new WarningsRepo(database);

function row(overrides: Partial<NewWarning> & Pick<NewWarning, 'slug'>): NewWarning {
    return {
        guildId: 'guild-1',
        userId: 'user-1',
        issuerId: 'mod-1',
        rule: 'Consent',
        description: 'A description',
        issuedAt: '2026-03-01T00:00:00.000Z',
        expiresAt: '2027-03-01T00:00:00.000Z',
        clearedAt: null,
        clearedById: null,
        createdAt: '2026-03-01T00:00:00.000Z',
        ...overrides,
    };
}

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('warnings').execute();
});

describe('WarningsRepo active filters (sqlite)', () => {
    it('lists warnings that are still on or before drop-off and not cleared', async () => {
        const now = new Date('2026-09-01T20:00:00.000Z');
        const asOf = getActiveAsOfUtcMidnight(now);

        await repo.insert(
            row({
                userId: 'user-active',
                slug: 'consent-active',
                description: 'Active through drop-off day',
                expiresAt: '2026-09-01T00:00:00.000Z',
            })
        );
        await repo.insert(
            row({
                userId: 'user-expired',
                slug: 'consent-expired',
                issuedAt: '2026-02-28T00:00:00.000Z',
                expiresAt: '2026-08-31T00:00:00.000Z',
                createdAt: '2026-02-28T00:00:00.000Z',
            })
        );
        await repo.insert(
            row({
                userId: 'user-cleared',
                slug: 'consent-cleared',
                clearedAt: '2026-08-01T00:00:00.000Z',
                clearedById: 'mod-2',
            })
        );
        await repo.insert(row({ guildId: 'guild-2', userId: 'user-other-guild', slug: 'consent-other' }));
        await repo.insert(
            row({
                userId: 'user-active',
                slug: 'consent-active-2',
                rule: 'Harassment',
                issuedAt: '2026-04-01T00:00:00.000Z',
                expiresAt: '2026-10-01T00:00:00.000Z',
                createdAt: '2026-04-01T00:00:00.000Z',
            })
        );
        await repo.insert(
            row({
                userId: 'user-one',
                slug: 'privacy-one',
                rule: 'Privacy',
                issuedAt: '2026-05-01T00:00:00.000Z',
                expiresAt: '2026-12-01T00:00:00.000Z',
                createdAt: '2026-05-01T00:00:00.000Z',
            })
        );
        await repo.insert(
            row({
                userId: 'user-two-later',
                slug: 'consent-later-a',
                issuedAt: '2026-05-01T00:00:00.000Z',
                expiresAt: '2026-11-01T00:00:00.000Z',
                createdAt: '2026-05-01T00:00:00.000Z',
            })
        );
        await repo.insert(
            row({
                userId: 'user-two-later',
                slug: 'consent-later-b',
                issuedAt: '2026-06-01T00:00:00.000Z',
                expiresAt: '2027-01-01T00:00:00.000Z',
                createdAt: '2026-06-01T00:00:00.000Z',
            })
        );

        const active = await repo.listActive('guild-1', asOf, { limit: 10 });
        const count = await repo.countActive('guild-1', asOf);
        const summaries = await repo.listActiveMemberSummaries('guild-1', asOf, 10);
        const memberCount = await repo.countActiveMembers('guild-1', asOf);
        const memberWarnings = await repo.listActive('guild-1', asOf, {
            limit: 10,
            userId: 'user-active',
        });

        expect(active.map((warning) => warning.slug)).toEqual([
            'consent-active',
            'consent-active-2',
            'consent-later-a',
            'privacy-one',
            'consent-later-b',
        ]);
        expect(count).toBe(5);
        expect(memberCount).toBe(3);
        expect(summaries.map((summary) => summary.userId)).toEqual(['user-active', 'user-two-later', 'user-one']);
        expect(summaries[0]).toEqual(expect.objectContaining({ userId: 'user-active', warningCount: 2 }));
        expect(summaries[0].soonestExpiresAt).toBeInstanceOf(Date);
        expect(formatCalendarDate(calendarDateFromUtcMidnight(summaries[0].soonestExpiresAt))).toBe('2026-09-01');
        expect(summaries[1]).toEqual(expect.objectContaining({ userId: 'user-two-later', warningCount: 2 }));
        expect(formatCalendarDate(calendarDateFromUtcMidnight(summaries[1].soonestExpiresAt))).toBe('2026-11-01');
        expect(summaries[2]).toEqual(expect.objectContaining({ userId: 'user-one', warningCount: 1 }));
        expect(memberWarnings.map((warning) => warning.slug)).toEqual(['consent-active', 'consent-active-2']);
        expect(active.every((warning) => isWarningActive(warning, now))).toBe(true);
    });
});

describe('WarningsRepo.listByGuild and countsByGuild (sqlite)', () => {
    /*
     * 2026-09-02T03:00Z is the evening of 2026-09-01 in Los Angeles: a warning dropping off
     * on the 1st is still active then, and one dropping off on August 31st is not. Judged on
     * the UTC calendar, the first would already have expired.
     */
    const now = new Date('2026-09-02T03:00:00.000Z');
    const asOf = getActiveAsOfUtcMidnight(now);

    beforeEach(async () => {
        await repo.insert(
            row({
                slug: 'drops-today',
                userId: 'user-a',
                userName: 'Kitten',
                issuedAt: '2026-03-01T00:00:00.000Z',
                expiresAt: '2026-09-01T00:00:00.000Z',
            })
        );
        await repo.insert(
            row({
                slug: 'dropped-yesterday',
                userId: 'user-b',
                userName: 'Brat',
                issuedAt: '2026-02-28T00:00:00.000Z',
                expiresAt: '2026-08-31T00:00:00.000Z',
            })
        );
        // Released, and also past its drop-off: released wins.
        await repo.insert(
            row({
                slug: 'released-and-expired',
                userId: 'user-a',
                issuedAt: '2026-02-01T00:00:00.000Z',
                expiresAt: '2026-08-01T00:00:00.000Z',
                clearedAt: '2026-07-01T00:00:00.000Z',
                clearedById: 'mod-2',
            })
        );
        await repo.insert(
            row({
                slug: 'released-early',
                userId: 'user-c',
                rule: 'Privacy',
                issuedAt: '2026-08-01T00:00:00.000Z',
                expiresAt: '2027-02-01T00:00:00.000Z',
                clearedAt: '2026-08-15T00:00:00.000Z',
                clearedById: 'mod-2',
            })
        );
        await repo.insert(row({ guildId: 'guild-2', slug: 'other-guild', userId: 'user-a' }));
    });

    it('splits the guild by status at the Pacific-day boundary, agreeing with warningStatus', async () => {
        const slugsFor = async (status: 'active' | 'expired' | 'released') =>
            (await repo.listByGuild('guild-1', asOf, { status })).map((warning) => warning.slug);

        expect(await slugsFor('active')).toEqual(['drops-today']);
        expect(await slugsFor('expired')).toEqual(['dropped-yesterday']);
        expect(await slugsFor('released')).toEqual(['released-early', 'released-and-expired']);

        const all = await repo.listByGuild('guild-1', asOf, {});
        for (const warning of all) {
            const listedUnder = (await slugsFor(warningStatus(warning, now))).includes(warning.slug);
            expect(listedUnder).toBe(true);
        }
    });

    it('lists newest issued first, scoped to the guild, and narrows to one member', async () => {
        expect((await repo.listByGuild('guild-1', asOf, {})).map((warning) => warning.slug)).toEqual([
            'released-early',
            'drops-today',
            'dropped-yesterday',
            'released-and-expired',
        ]);
        expect((await repo.listByGuild('guild-1', asOf, { userId: 'user-a' })).map((warning) => warning.slug)).toEqual(
            ['drops-today', 'released-and-expired']
        );
    });

    it('counts each status for the whole guild', async () => {
        expect(await repo.countsByGuild('guild-1', asOf)).toEqual({ active: 1, expired: 1, released: 2 });
        expect(await repo.countsByGuild('guild-none', asOf)).toEqual({ active: 0, expired: 0, released: 0 });
    });

    it('searches a case-insensitive prefix of the slug, the rule and the recorded names', async () => {
        const search = async (text: string) =>
            (await repo.listByGuild('guild-1', asOf, { search: text })).map((warning) => warning.slug).sort();

        expect(await search('DROPS')).toEqual(['drops-today']);
        expect(await search('priv')).toEqual(['released-early']);
        expect(await search('kit')).toEqual(['drops-today']);
        expect(await search('mod')).toEqual([]);
        // A prefix, not a substring.
        expect(await search('today')).toEqual([]);
    });

    it('matches `%` and `_` literally rather than as wildcards', async () => {
        await repo.insert(row({ slug: 'a_b', userId: 'user-d' }));
        await repo.insert(row({ slug: 'axb', userId: 'user-d' }));
        await repo.insert(row({ slug: 'percent', userId: 'user-d', userName: '100%club' }));

        const search = async (text: string) =>
            (await repo.listByGuild('guild-1', asOf, { search: text })).map((warning) => warning.slug).sort();

        expect(await search('a_')).toEqual(['a_b']);
        expect(await search('%')).toEqual([]);
        expect(await search('100%')).toEqual(['percent']);
    });

    it('finds a name starting with a non-ASCII letter typed as recorded', async () => {
        // Both sides are lowered in SQL; lowering only the search in JS would turn `É`
        // into `é`, which SQLite's ASCII-only `lower` never produces from the column.
        await repo.insert(row({ slug: 'accent', userId: 'user-e', userName: 'Émile' }));

        const found = await repo.listByGuild('guild-1', asOf, { search: 'Émi' });

        expect(found.map((warning) => warning.slug)).toEqual(['accent']);
    });

    it('reads one row past the cap so the route can tell it was capped', async () => {
        for (let index = 0; index <= WARNING_LIST_CAP + 1; index += 1) {
            await repo.insert(row({ slug: `bulk-${index}`, userId: 'user-bulk' }));
        }

        expect(await repo.listByGuild('guild-1', asOf, { userId: 'user-bulk' })).toHaveLength(WARNING_LIST_CAP + 1);
    });
});

describe('WarningsRepo writes (sqlite)', () => {
    beforeEach(async () => {
        await repo.insert(row({ slug: 'open-one' }));
    });

    it('releases with who and why, once', async () => {
        const released = await repo.softClear(
            'guild-1',
            'open-one',
            { id: 'mod-2', name: 'Mistress' },
            'Apologised nicely.',
            '2026-09-01T12:00:00.000Z'
        );
        const again = await repo.softClear(
            'guild-1',
            'open-one',
            { id: 'mod-3', name: 'Someone else' },
            'Second go.',
            '2026-09-02T12:00:00.000Z'
        );

        expect(released).toBe(true);
        expect(again).toBe(false);
        expect(await repo.getByGuildAndSlug('guild-1', 'open-one')).toEqual(
            expect.objectContaining({
                clearedAt: new Date('2026-09-01T12:00:00.000Z'),
                clearedById: 'mod-2',
                clearedByName: 'Mistress',
                clearReason: 'Apologised nicely.',
            })
        );
    });

    /** The editable columns as the row holds them now, which is what an edit is computed from. */
    async function currentBase() {
        const warning = await repo.getByGuildAndSlug('guild-1', 'open-one');
        if (!warning) throw new Error('open-one is missing');
        return warning;
    }

    const EDIT = { rule: 'Privacy', description: 'Rewritten', expiresAt: '2027-06-01T00:00:00.000Z' };

    it('edits an unreleased warning, recording the editor', async () => {
        const changed = await repo.updateEditable(
            'guild-1',
            'open-one',
            await currentBase(),
            EDIT,
            { id: 'mod-2', name: 'Mistress' },
            '2026-09-01T12:00:00.000Z'
        );

        expect(changed).toBe(true);
        expect(await repo.getByGuildAndSlug('guild-1', 'open-one')).toEqual(
            expect.objectContaining({
                rule: 'Privacy',
                description: 'Rewritten',
                expiresAt: new Date('2027-06-01T00:00:00.000Z'),
                editedAt: new Date('2026-09-01T12:00:00.000Z'),
                editedById: 'mod-2',
                editedByName: 'Mistress',
            })
        );
    });

    it('refuses to edit a released warning, changing nothing', async () => {
        const base = await currentBase();
        await repo.softClear('guild-1', 'open-one', { id: 'mod-2', name: 'Mistress' }, 'Done.', '2026-09-01T12:00:00.000Z');

        const changed = await repo.updateEditable(
            'guild-1',
            'open-one',
            base,
            EDIT,
            { id: 'mod-3', name: 'Late' },
            '2026-09-02T12:00:00.000Z'
        );

        expect(changed).toBe(false);
        expect(await repo.getByGuildAndSlug('guild-1', 'open-one')).toEqual(
            expect.objectContaining({ rule: 'Consent', description: 'A description', editedAt: null, editedById: null })
        );
    });

    it('refuses an edit computed from values another edit has since changed', async () => {
        const base = await currentBase();
        await repo.updateEditable(
            'guild-1',
            'open-one',
            base,
            { ...EDIT, rule: 'Harassment' },
            { id: 'mod-2', name: 'First' },
            '2026-09-01T12:00:00.000Z'
        );

        const changed = await repo.updateEditable(
            'guild-1',
            'open-one',
            base,
            EDIT,
            { id: 'mod-3', name: 'Second' },
            '2026-09-01T12:01:00.000Z'
        );

        expect(changed).toBe(false);
        expect(await repo.getByGuildAndSlug('guild-1', 'open-one')).toEqual(
            expect.objectContaining({ rule: 'Harassment', editedByName: 'First' })
        );
    });

    it('does not reach another guild by slug', async () => {
        expect(
            await repo.updateEditable(
                'guild-2',
                'open-one',
                await currentBase(),
                EDIT,
                { id: 'mod-2', name: 'Mistress' },
                '2026-09-01T12:00:00.000Z'
            )
        ).toBe(false);
        expect(
            await repo.softClear('guild-2', 'open-one', { id: 'mod-2', name: 'Mistress' }, 'No.', '2026-09-01T12:00:00.000Z')
        ).toBe(false);
    });
});
