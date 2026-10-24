import type { GuildUpload, ListGuildUploadsResponse } from '@brattybot/web-sdk';
import { describe, expect, it } from 'vitest';
import { withKeptFirst, withoutUpload } from '../keepGuildUpload';

function stored(uploadId: string, byteSize: number): GuildUpload {
    return {
        uploadId,
        fileName: `${uploadId}.png`,
        contentType: 'image/png',
        byteSize,
        uploadedBy: '100000000000000001',
        createdAt: '2026-10-24T10:00:00.000Z',
    };
}

const OLD = { ...stored('old', 100), uses: [] };
const LISTED: ListGuildUploadsResponse = { uploads: [OLD], totalBytes: 100, limitBytes: 1000 };

describe('withKeptFirst', () => {
    it('puts a new picture on top and adds its bytes', () => {
        expect(withKeptFirst(LISTED, stored('new', 40), true)).toEqual({
            uploads: [{ ...stored('new', 40), uses: [] }, OLD],
            totalBytes: 140,
            limitBytes: 1000,
        });
    });

    it('counts a new picture once when a read that already holds it landed first', () => {
        const alreadyRead = { ...LISTED, uploads: [{ ...stored('new', 40), uses: [] }, OLD], totalBytes: 140 };
        expect(withKeptFirst(alreadyRead, stored('new', 40), true)?.totalBytes).toBe(140);
    });

    it("moves one the server already held to the top as listed, and asks again for one the list lacks", () => {
        const two = { ...LISTED, uploads: [{ ...stored('a', 1), uses: [] }, OLD], totalBytes: 101 };
        expect(withKeptFirst(two, stored('old', 100), false)?.uploads.map((upload) => upload.uploadId)).toEqual(['old', 'a']);
        expect(withKeptFirst(LISTED, stored('elsewhere', 5), false)).toBeUndefined();
    });
});

describe('withoutUpload', () => {
    it('takes the picture out and its bytes off the total', () => {
        expect(withoutUpload(LISTED, 'old')).toEqual({ uploads: [], totalBytes: 0, limitBytes: 1000 });
    });

    it('leaves a list without it as it was', () => {
        expect(withoutUpload(LISTED, 'missing')).toBe(LISTED);
    });
});
