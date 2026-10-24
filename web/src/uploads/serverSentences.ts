/**
 * What the upload routes say that the dashboard branches on, mirrored by hand because nothing
 * under `web/src` may import the bot's tree. `src/web/api/__tests__/uploadSentenceMirrors.test.ts`
 * holds each to the route's own constant.
 *
 * Plain values with no imports, for the same reason as `uploadLimits.ts`.
 */

/**
 * The delete route's 404 when this server holds no such picture: `UPLOAD_NOT_FOUND_SENTENCE`
 * in `src/web/api/uploadRoutes.ts`. Any other 404 (the server itself gone) is not "already gone".
 */
export const UPLOAD_NOT_FOUND_SENTENCE = "That picture isn't in this server.";
