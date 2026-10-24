import type { GuildUploadListing, UploadUse } from '@brattybot/web-sdk';
import { describe, expect, it } from 'vitest';
import { filterUploads, uploaderLabel, uploadTypeLabel } from '../uploadPresentation';

const USE: UploadUse = {
    flowId: '11111111-1111-1111-1111-111111111111',
    flowName: 'Welcome flow',
    nodeId: 'welcome',
    blockLabel: 'Post Embed',
    where: 'embed 1 image',
};

function listing(uploadId: string, uses: readonly UploadUse[]): GuildUploadListing {
    return {
        uploadId,
        fileName: `${uploadId}.png`,
        contentType: 'image/png',
        byteSize: 10,
        uploadedBy: '100000000000000001',
        createdAt: '2026-10-24T10:00:00.000Z',
        uses: [...uses],
    };
}

describe('filterUploads', () => {
    const used = listing('used', [USE]);
    const unused = listing('unused', []);
    const all = [used, unused];

    it('keeps every picture, in order, for All', () => {
        expect(filterUploads(all, 'all')).toEqual([used, unused]);
    });

    it('keeps the pictures something shows for In use, and the rest for Unused', () => {
        expect(filterUploads(all, 'inUse')).toEqual([used]);
        expect(filterUploads(all, 'unused')).toEqual([unused]);
    });
});

describe('uploadTypeLabel', () => {
    it('names each type the server keeps the short way', () => {
        expect(uploadTypeLabel('image/png')).toBe('PNG');
        expect(uploadTypeLabel('image/jpeg')).toBe('JPG');
        expect(uploadTypeLabel('image/gif')).toBe('GIF');
        expect(uploadTypeLabel('image/webp')).toBe('WEBP');
    });
});

describe('uploaderLabel', () => {
    it('says "you" to the person who uploaded it, and the id to anyone else', () => {
        expect(uploaderLabel('100000000000000001', '100000000000000001')).toBe('you');
        expect(uploaderLabel('100000000000000001', '200000000000000002')).toBe('100000000000000001');
        expect(uploaderLabel('100000000000000001', undefined)).toBe('100000000000000001');
    });
});
