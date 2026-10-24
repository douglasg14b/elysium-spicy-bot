/**
 * The largest picture the server keeps, as the drop zones word it and as the browser checks it.
 *
 * Mirrors of `UPLOAD_SIZE_LABEL` and `UPLOAD_BODY_LIMIT_BYTES` in
 * `src/features-system/guild-uploads/constants.ts`, hand-written because nothing under `web/src`
 * may import the bot's tree; `src/features-system/guild-uploads/__tests__/uploadSizeLabelDrift.test.ts`
 * holds them together, so a drop zone never promises more than the server's 413 allows.
 *
 * Plain values with no imports: that test runs in the node project, where `@brattybot/web-sdk`
 * does not resolve at run time.
 */

export const UPLOAD_SIZE_LABEL = '8 MB';

/** The same cap in bytes. A file over it is refused before it is sent (`keepGuildUpload`). */
export const UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;
