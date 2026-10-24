import { describe, expect, it } from 'vitest';
import { UPLOAD_NOT_FOUND_SENTENCE as DASHBOARD_NOT_FOUND } from '../../../../web/src/uploads/serverSentences';
import { UPLOAD_NOT_FOUND_SENTENCE } from '../uploadRoutes';

/**
 * The Uploads page tells "already gone" from any other 404 by the delete route's sentence, in a
 * hand-written mirror. Reworded here and not there, every delete that lost a race would show as
 * an error instead.
 */
describe("the dashboard's mirror of the upload routes' sentences", () => {
    it("matches the delete route's not-found sentence", () => {
        expect(
            DASHBOARD_NOT_FOUND,
            'Reconcile `web/src/uploads/serverSentences.ts` with `UPLOAD_NOT_FOUND_SENTENCE` in `src/web/api/uploadRoutes.ts`.'
        ).toBe(UPLOAD_NOT_FOUND_SENTENCE);
    });
});
