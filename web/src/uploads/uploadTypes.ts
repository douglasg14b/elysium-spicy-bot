/**
 * The picture types the server keeps, for a file chooser and for the drop zones' hint.
 */

import { zGuildUpload } from '@brattybot/web-sdk';

/** What a file chooser offers: the spec's own list of the types the server reads off the bytes. */
export const ACCEPTED_UPLOAD_TYPES = zGuildUpload.shape.contentType.options.join(',');

/** {@link ACCEPTED_UPLOAD_TYPES} as people read them, under every drop zone. */
export const UPLOAD_TYPES_HINT = 'PNG, JPG, GIF or WebP';
