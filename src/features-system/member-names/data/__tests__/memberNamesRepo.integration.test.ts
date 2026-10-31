import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { database } from '../../../data-persistence/database';
import { migrateTestDatabase } from '../../../data-persistence/__tests__/support/migrateTestDatabase';
import { MemberNamesRepo, type SeenMember } from '../memberNamesRepo';

/**
 * The member-names repo against real SQL: the production client and plugin stack, on an
 * in-memory SQLite built by the real migrations.
 *
 * What a mock cannot answer: whether the booleans and the nickname list come back as
 * booleans and a list through sqlite's plugins, whether the multi-row upsert really merges
 * into what is stored, and whether the sweep's "written since" guard leaves newer rows be.
 */

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';
const USER = '400000000000000001';
const OTHER_USER = '400000000000000002';

const repo = new MemberNamesRepo(database);

function member(overrides: Partial<SeenMember> = {}): SeenMember {
    return {
        userId: USER,
        username: 'kittenuser',
        globalName: 'Kitten',
        nickname: 'Brat',
        isBot: false,
        ...overrides,
    };
}

async function rowFor(guildId: string, userId: string) {
    const [row] = await repo.findByUserIds(guildId, [userId]);
    return row;
}

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('member_names').execute();
});

describe('MemberNamesRepo', () => {
    it('records a member with real booleans, a list and dates', async () => {
        await repo.recordPresent(GUILD, [member()]);

        const row = await rowFor(GUILD, USER);
        expect(row).toMatchObject({
            guildId: GUILD,
            userId: USER,
            username: 'kittenuser',
            globalName: 'Kitten',
            nickname: 'Brat',
            nicknames: ['Brat'],
            isBot: false,
            inServer: true,
            leftAt: null,
        });
        expect(row?.firstSeenAt).toBeInstanceOf(Date);
        expect(row?.updatedAt).toBeInstanceOf(Date);
    });

    it('merges each new nickname into the ones stored, newest first, and keeps the first sighting', async () => {
        await repo.recordPresent(GUILD, [member({ nickname: 'Brat' })]);
        const firstSeenAt = (await rowFor(GUILD, USER))?.firstSeenAt;
        await repo.recordPresent(GUILD, [member({ nickname: 'Pet' })]);
        await repo.recordPresent(GUILD, [member({ nickname: null })]);
        await repo.recordPresent(GUILD, [member({ nickname: 'Brat', username: 'renamed' })]);

        const row = await rowFor(GUILD, USER);
        expect(row?.nickname).toBe('Brat');
        expect(row?.nicknames).toEqual(['Brat', 'Pet']);
        expect(row?.username).toBe('renamed');
        expect(row?.firstSeenAt).toEqual(firstSeenAt);
    });

    it('writes many members in one call, each merged on its own', async () => {
        await repo.recordPresent(GUILD, [member({ nickname: 'Old' })]);
        const many = Array.from({ length: 250 }, (_unused, index) =>
            member({ userId: `5000000000000${String(index).padStart(5, '0')}`, nickname: `n${index}` })
        );

        await repo.recordPresent(GUILD, [member({ nickname: 'New' }), ...many]);

        expect((await rowFor(GUILD, USER))?.nicknames).toEqual(['New', 'Old']);
        const stored = await database.selectFrom('member_names').select('userId').where('guildId', '=', GUILD).execute();
        expect(stored).toHaveLength(251);
    });

    it('records a leave as not in the server, when, with the stored names kept; a return clears it', async () => {
        await repo.recordPresent(GUILD, [member()]);
        const leftAt = new Date('2026-10-30T12:00:00.000Z');

        await repo.recordLeft(GUILD, member({ nickname: null, username: 'partial-knows-this' }), leftAt);

        const left = await rowFor(GUILD, USER);
        expect(left).toMatchObject({ inServer: false, leftAt, nickname: 'Brat', username: 'kittenuser' });

        await repo.recordPresent(GUILD, [member()]);
        expect(await rowFor(GUILD, USER)).toMatchObject({ inServer: true, leftAt: null });
    });

    it('records a leave by somebody never recorded, from what the leave carried', async () => {
        const leftAt = new Date('2026-10-30T12:00:00.000Z');

        await repo.recordLeft(GUILD, member({ nickname: null }), leftAt);

        expect(await rowFor(GUILD, USER)).toMatchObject({
            username: 'kittenuser',
            inServer: false,
            leftAt,
            nicknames: [],
        });
    });

    it('records a looked-up account as not in the server, and never over a row that exists', async () => {
        await repo.recordPresent(GUILD, [member({ userId: OTHER_USER })]);

        await repo.recordLookedUp(GUILD, [
            { userId: USER, username: 'ghost', globalName: null, isBot: false },
            { userId: OTHER_USER, username: 'stale', globalName: null, isBot: false },
        ]);

        expect(await rowFor(GUILD, USER)).toMatchObject({
            username: 'ghost',
            nickname: null,
            nicknames: [],
            inServer: false,
            leftAt: null,
        });
        expect(await rowFor(GUILD, OTHER_USER)).toMatchObject({ username: 'kittenuser', inServer: true });
    });

    it('marks recorded members a sweep did not find as gone, with no date, skipping rows written since', async () => {
        await repo.recordPresent(GUILD, [member(), member({ userId: OTHER_USER })]);
        await repo.recordPresent(OTHER_GUILD, [member()]);
        const sweepStartedAt = new Date(Date.now() + 1000);

        const marked = await repo.markMissingAsGone(GUILD, new Set([OTHER_USER]), sweepStartedAt);

        expect(marked).toBe(1);
        expect(await rowFor(GUILD, USER)).toMatchObject({ inServer: false, leftAt: null });
        expect(await rowFor(GUILD, OTHER_USER)).toMatchObject({ inServer: true });
        expect(await rowFor(OTHER_GUILD, USER)).toMatchObject({ inServer: true });

        // A row written after the sweep began is newer than its list.
        await repo.recordPresent(GUILD, [member()]);
        expect(await repo.markMissingAsGone(GUILD, new Set(), new Date(0))).toBe(0);
        expect(await rowFor(GUILD, USER)).toMatchObject({ inServer: true });
    });

    it("leaves a row written since the sweep began as it is, rather than overwrite it with the sweep's older list", async () => {
        const sweepStartedAt = new Date(Date.now() - 1000);
        await repo.recordLeft(GUILD, member(), new Date());

        await repo.recordPresent(GUILD, [member()], sweepStartedAt);

        expect(await rowFor(GUILD, USER)).toMatchObject({ inServer: false });
    });

    it('lets the sweep record a member over a row only ever looked up, even one written since it began', async () => {
        const sweepStartedAt = new Date(Date.now() - 1000);
        await repo.recordLookedUp(GUILD, [{ userId: USER, username: 'kittenuser', globalName: null, isBot: false }]);

        await repo.recordPresent(GUILD, [member()], sweepStartedAt);

        expect(await rowFor(GUILD, USER)).toMatchObject({ inServer: true, nickname: 'Brat' });
    });

    it('takes one row per user from a batch naming somebody twice, the last given', async () => {
        await repo.recordPresent(GUILD, [member({ nickname: 'First' }), member({ nickname: 'Last' })]);

        expect(await rowFor(GUILD, USER)).toMatchObject({ nickname: 'Last' });
    });

    it("updates an account's names in one guild's row, leaving its nicknames and other guilds alone", async () => {
        await repo.recordPresent(GUILD, [member()]);
        await repo.recordPresent(OTHER_GUILD, [member()]);

        expect((await repo.guildIdsFor(USER)).sort()).toEqual([GUILD, OTHER_GUILD]);
        await repo.recordUser(GUILD, { userId: USER, username: 'newhandle', globalName: 'New Kitten', isBot: false });

        expect(await rowFor(GUILD, USER)).toMatchObject({
            username: 'newhandle',
            globalName: 'New Kitten',
            nickname: 'Brat',
            nicknames: ['Brat'],
        });
        expect(await rowFor(OTHER_GUILD, USER)).toMatchObject({ username: 'kittenuser' });
    });
});
