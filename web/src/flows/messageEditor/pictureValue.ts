/**
 * What a picture part's string is, for drawing it: an upload, a link, or text holding a token.
 *
 * The browser half of the server's `parsePictureRef`, and only as far as drawing needs: the
 * server judges whether a link is one Discord will take, and marks the part when it is not.
 * Read in the server's order — an upload ref first, then any token, then a link.
 */

import { tokensIn } from '../variables';

const UPLOAD_PREFIX = 'upload:';

export type PictureValue =
    | { readonly kind: 'upload'; readonly uploadId: string }
    | { readonly kind: 'token' }
    | { readonly kind: 'link'; readonly url: string };

export function readPictureValue(value: string): PictureValue {
    if (value.startsWith(UPLOAD_PREFIX)) return { kind: 'upload', uploadId: value.slice(UPLOAD_PREFIX.length) };
    if (tokensIn(value).length > 0) return { kind: 'token' };
    return { kind: 'link', url: value };
}

/** How a message names one of the server's uploads: `upload:<uploadId>`. */
export function uploadRef(uploadId: string): string {
    return `${UPLOAD_PREFIX}${uploadId}`;
}
