import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { database } from '../../../data-persistence/database';
import { migrateTestDatabase } from '../../../data-persistence/__tests__/support/migrateTestDatabase';
import { MemberAvatarsRepo } from '../memberAvatarsRepo';
import { MemberNamesRepo, type SeenMember } from '../memberNamesRepo';

/**
 * The avatar repo against real SQL: the production client and plugin stack, on an in-memory
 * SQLite built by the real migrations — whether the bytes come back as the bytes, whether a
 * new hash replaces the picture rather than adding one, and whether the read is held to the
 * guild's own `member_names` rows.
 */

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';
const USER = '400000000000000001';
const OTHER_USER = '400000000000000002';

const avatars = new MemberAvatarsRepo(database);
const names = new MemberNamesRepo(database);

const FIRST = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const SECOND = Buffer.from([0xff, 0xd8, 0xff, 2]);

function member(overrides: Partial<SeenMember> = {}): SeenMember {
    return { userId: USER, username: 'kittenuser', globalName: null, nickname: null, avatarHash: 'face1', isBot: false, ...overrides };
}

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('member_avatars').execute();
    await database.deleteFrom('member_names').execute();
});

describe('MemberAvatarsRepo', () => {
    it('stores a picture and serves its bytes to a guild that holds the person', async () => {
        await names.recordPresent(GUILD, [member()]);
        await avatars.store({ userId: USER, avatarHash: 'face1', contentType: 'image/png', bytes: FIRST }, new Date());

        expect(await avatars.storedHashes([USER, '400000000000000099'])).toEqual(new Map([[USER, 'face1']]));
        const file = await avatars.fileFor(GUILD, USER);
        expect(file?.contentType).toBe('image/png');
        expect(Buffer.from(file?.bytes ?? [])).toEqual(FIRST);
    });

    it('replaces the picture on a new hash, keeping one row', async () => {
        await names.recordPresent(GUILD, [member()]);
        await avatars.store({ userId: USER, avatarHash: 'face1', contentType: 'image/png', bytes: FIRST }, new Date());

        await avatars.store({ userId: USER, avatarHash: 'face2', contentType: 'image/jpeg', bytes: SECOND }, new Date());

        expect(await avatars.storedHashes([USER])).toEqual(new Map([[USER, 'face2']]));
        expect(await database.selectFrom('member_avatars').select('userId').execute()).toHaveLength(1);
        const file = await avatars.fileFor(GUILD, USER);
        expect(file?.contentType).toBe('image/jpeg');
        expect(Buffer.from(file?.bytes ?? [])).toEqual(SECOND);
    });

    it("serves each of two members in one guild their own picture, never the other's", async () => {
        await names.recordPresent(GUILD, [member(), member({ userId: OTHER_USER, avatarHash: 'face9' })]);
        await avatars.store({ userId: OTHER_USER, avatarHash: 'face9', contentType: 'image/jpeg', bytes: SECOND }, new Date());
        await avatars.store({ userId: USER, avatarHash: 'face1', contentType: 'image/png', bytes: FIRST }, new Date());

        expect(Buffer.from((await avatars.fileFor(GUILD, USER))?.bytes ?? [])).toEqual(FIRST);
        expect(Buffer.from((await avatars.fileFor(GUILD, OTHER_USER))?.bytes ?? [])).toEqual(SECOND);
    });

    it('keeps the picture for somebody who has left, the leave recording their avatar over a row from before it was kept', async () => {
        // A row written before avatars were recorded.
        await names.recordPresent(GUILD, [member({ avatarHash: null, nickname: 'Brat' })]);
        await avatars.store({ userId: USER, avatarHash: 'face1', contentType: 'image/png', bytes: FIRST }, new Date());

        // A partial member: their nickname is unknown, and the stored one stays.
        await names.recordLeft(GUILD, member({ nickname: null }), new Date());

        expect((await names.findByUserIds(GUILD, [USER]))[0]).toMatchObject({ avatarHash: 'face1', nickname: 'Brat' });
        expect(Buffer.from((await avatars.fileFor(GUILD, USER))?.bytes ?? [])).toEqual(FIRST);
    });

    it('drops the picture held for an account', async () => {
        await avatars.store({ userId: USER, avatarHash: 'face1', contentType: 'image/png', bytes: FIRST }, new Date());

        await avatars.remove(USER);

        expect(await avatars.storedHashes([USER])).toEqual(new Map());
    });

    it('serves nothing to a guild with no row for them, though another guild holds one', async () => {
        await names.recordPresent(OTHER_GUILD, [member()]);
        await avatars.store({ userId: USER, avatarHash: 'face1', contentType: 'image/png', bytes: FIRST }, new Date());

        expect(await avatars.fileFor(GUILD, USER)).toBeNull();
        expect(await avatars.fileFor(OTHER_GUILD, USER)).not.toBeNull();
    });

    it('serves nothing to a guild whose row has no avatar set — they removed it', async () => {
        await names.recordPresent(GUILD, [member({ avatarHash: null })]);
        await avatars.store({ userId: USER, avatarHash: 'face1', contentType: 'image/png', bytes: FIRST }, new Date());

        expect(await avatars.fileFor(GUILD, USER)).toBeNull();
    });
});
