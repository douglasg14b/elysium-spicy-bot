import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { database } from '../../../data-persistence/database';
import { migrateTestDatabase } from '../../../data-persistence/__tests__/support/migrateTestDatabase';
import { GuildUploadsRepo, type NewGuildUploadInput } from '../guildUploadsRepo';

/**
 * The uploads repo against real SQL: the production client and plugin stack, on an
 * in-memory SQLite built by the real migrations.
 *
 * What a mock cannot answer: whether a blob survives the driver and the sqlite binding
 * plugin byte for byte and comes back a `Buffer`, whether the unique index really makes a
 * re-upload find the first row, and whether a read scoped to one guild can reach another's.
 */

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';
const UPLOADER = 'user-1';

const repo = new GuildUploadsRepo(database);

/** A PNG-headed picture with random bytes after, NULs and high bytes included. */
function picture(size = 4096): Buffer {
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]), randomBytes(size)]);
}

function input(bytes: Buffer, guildId = GUILD): NewGuildUploadInput {
    return {
        guildId,
        fileName: 'cat.png',
        contentType: 'image/png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        uploadedBy: UPLOADER,
    };
}

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('guild_uploads').execute();
});

describe('GuildUploadsRepo', () => {
    it('round-trips the bytes exactly, as a Buffer', async () => {
        const bytes = picture();
        const { upload } = await repo.create(input(bytes));

        const stored = await repo.bytesFor(GUILD, upload.uploadId);

        expect(stored?.contentType).toBe('image/png');
        expect(Buffer.isBuffer(stored?.bytes)).toBe(true);
        expect(stored?.bytes.equals(bytes)).toBe(true);
    });

    it('stores the metadata it was given, with the size and a parsed date', async () => {
        const bytes = picture(100);
        const { upload, created } = await repo.create(input(bytes));

        expect(created).toBe(true);
        expect(upload).toMatchObject({
            guildId: GUILD,
            fileName: 'cat.png',
            contentType: 'image/png',
            byteSize: bytes.length,
            uploadedBy: UPLOADER,
        });
        expect(upload.uploadId).toMatch(/^[0-9a-f-]{36}$/);
        expect(upload.createdAt).toBeInstanceOf(Date);
    });

    it('finds the first row when the same bytes are uploaded to the same guild again', async () => {
        const bytes = picture();
        const first = await repo.create(input(bytes));
        const second = await repo.create({ ...input(bytes), fileName: 'same-cat-new-name.png', uploadedBy: 'user-2' });

        expect(second.created).toBe(false);
        expect(second.upload).toEqual(first.upload);
        expect(await repo.listForGuild(GUILD)).toHaveLength(1);
    });

    it('keeps the same bytes separately for each guild', async () => {
        const bytes = picture();
        const mine = await repo.create(input(bytes));
        const theirs = await repo.create(input(bytes, OTHER_GUILD));

        expect(theirs.created).toBe(true);
        expect(theirs.upload.uploadId).not.toBe(mine.upload.uploadId);
    });

    it('lists newest first, without the bytes', async () => {
        const older = await repo.create(input(picture()));
        const newer = await repo.create(input(picture()));

        const listed = await repo.listForGuild(GUILD);

        expect(listed.map((upload) => upload.uploadId)).toEqual([newer.upload.uploadId, older.upload.uploadId]);
        // The row holds exactly what was selected, so this is the SELECT list: no `bytes`.
        expect(Object.keys(listed[0] ?? {}).sort()).toEqual(
            ['byteSize', 'contentType', 'createdAt', 'fileName', 'guildId', 'sha256', 'uploadId', 'uploadedBy'].sort()
        );
    });

    it('answers sizes and files only for the ids this guild holds', async () => {
        const first = await repo.create(input(picture(10)));
        const second = await repo.create(input(picture(20)));
        const ids = [first.upload.uploadId, second.upload.uploadId, 'not-an-upload'];

        const sizes = await repo.sizesFor(GUILD, ids);
        const files = await repo.filesFor(GUILD, ids);

        expect(sizes).toEqual(
            expect.arrayContaining([
                { uploadId: first.upload.uploadId, byteSize: first.upload.byteSize },
                { uploadId: second.upload.uploadId, byteSize: second.upload.byteSize },
            ])
        );
        expect(sizes).toHaveLength(2);
        expect(files.map((file) => file.uploadId).sort()).toEqual([first.upload.uploadId, second.upload.uploadId].sort());
        expect(files.every((file) => Buffer.isBuffer(file.bytes))).toBe(true);
        expect(await repo.sizesFor(GUILD, [])).toEqual([]);
        expect(await repo.filesFor(GUILD, [])).toEqual([]);
    });

    it('adds up a guild\'s uploads, and reads a guild with none as zero', async () => {
        const first = await repo.create(input(picture(10)));
        const second = await repo.create(input(picture(20)));

        expect(await repo.totalBytesForGuild(GUILD)).toBe(first.upload.byteSize + second.upload.byteSize);
        expect(await repo.totalBytesForGuild(OTHER_GUILD)).toBe(0);
    });

    it('finds nothing of one guild\'s uploads when asked as another guild', async () => {
        const { upload } = await repo.create(input(picture()));

        expect(await repo.bytesFor(OTHER_GUILD, upload.uploadId)).toBeNull();
        expect(await repo.sizesFor(OTHER_GUILD, [upload.uploadId])).toEqual([]);
        expect(await repo.filesFor(OTHER_GUILD, [upload.uploadId])).toEqual([]);
        expect(await repo.findByHash(OTHER_GUILD, upload.sha256)).toBeNull();
        expect(await repo.listForGuild(OTHER_GUILD)).toEqual([]);
        expect(await repo.totalBytesForGuild(OTHER_GUILD)).toBe(0);
        expect(await repo.holds(OTHER_GUILD, upload.uploadId)).toBe(false);
    });

    it("deletes only from the guild asked as, and says whether a row went", async () => {
        const { upload } = await repo.create(input(picture()));

        expect(await repo.delete(OTHER_GUILD, upload.uploadId)).toBe(false);
        expect(await repo.holds(GUILD, upload.uploadId)).toBe(true);

        expect(await repo.delete(GUILD, upload.uploadId)).toBe(true);
        expect(await repo.holds(GUILD, upload.uploadId)).toBe(false);
        expect(await repo.bytesFor(GUILD, upload.uploadId)).toBeNull();
        expect(await repo.delete(GUILD, upload.uploadId)).toBe(false);
    });
});
