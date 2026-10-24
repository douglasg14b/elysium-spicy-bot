/**
 * How the Uploads page sorts and words a server's pictures — the decisions, out of the
 * components, so they are checked without a render.
 */

import type { GuildUpload, GuildUploadListing } from '@brattybot/web-sdk';

/** The page's filter: every picture, the ones something shows, or the ones nothing does. */
export type UploadFilter = 'all' | 'inUse' | 'unused';

/** `uploads` narrowed to `filter`, in the order given (the server's: newest first). */
export function filterUploads(
    uploads: readonly GuildUploadListing[],
    filter: UploadFilter
): readonly GuildUploadListing[] {
    switch (filter) {
        case 'all':
            return uploads;
        case 'inUse':
            return uploads.filter((upload) => upload.uses.length > 0);
        case 'unused':
            return uploads.filter((upload) => upload.uses.length === 0);
    }
}

/** The short type a card's corner shows, from the type the server read off the bytes. */
export function uploadTypeLabel(contentType: GuildUpload['contentType']): string {
    switch (contentType) {
        case 'image/png':
            return 'PNG';
        case 'image/jpeg':
            return 'JPG';
        case 'image/gif':
            return 'GIF';
        case 'image/webp':
            return 'WEBP';
    }
}

/**
 * Who uploaded it: "you" for the person looking, otherwise their Discord id. There is no
 * member-name lookup on the dashboard's API yet, so somebody else's upload — present or
 * long gone — shows as the id the server stored.
 */
export function uploaderLabel(uploadedBy: string, viewerId: string | undefined): string {
    return uploadedBy === viewerId ? 'you' : uploadedBy;
}
