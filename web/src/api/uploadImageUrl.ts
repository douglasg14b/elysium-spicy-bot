/**
 * Where the browser loads an uploaded picture from — the one place that builds the address.
 *
 * Shown with `<img src>`, never through the SDK: the SDK reads every answer as JSON
 * (`setupClient` pins it), and this route answers with the picture's bytes. The browser
 * sends the session cookie with an image request on its own, and `requireAuth` judges a
 * request with no user header on the cookie alone, so the picture is still only shown to
 * somebody signed in. A session that runs out mid-edit shows a broken picture rather than
 * the sign-in panel.
 *
 * The spec's `getGuildUpload` route, by hand: `src/web/api/__tests__/uploadImageUrlPath.test.ts`
 * holds this path to the spec's.
 */

/** Which picture, in which server. */
export interface UploadImageAddress {
    readonly guildId: string;
    readonly uploadId: string;
}

/** The same-origin address of one uploaded picture: `/api/guilds/{guildId}/uploads/{uploadId}`. */
export function uploadImageUrl({ guildId, uploadId }: UploadImageAddress): string {
    return `/api/guilds/${encodeURIComponent(guildId)}/uploads/${encodeURIComponent(uploadId)}`;
}
