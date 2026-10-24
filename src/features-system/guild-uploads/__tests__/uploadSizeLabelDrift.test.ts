import { describe, expect, it } from 'vitest';
import {
    UPLOAD_SIZE_BYTES as DASHBOARD_BYTES,
    UPLOAD_SIZE_LABEL as DASHBOARD_LABEL,
} from '../../../../web/src/uploads/uploadLimits';
import { UPLOAD_BODY_LIMIT_BYTES, UPLOAD_SIZE_LABEL } from '../constants';

/**
 * The dashboard's drop zones say how big a picture may be, and its upload path refuses a bigger
 * one before sending it, from a hand-written mirror (`web/src/uploads/uploadLimits.ts`), because
 * nothing under `web/src` may import the bot's tree. A mirror promising more than the server takes
 * sends an author to a 413 they were told would not happen; one promising less refuses pictures
 * the server would keep.
 */
describe("the dashboard's upload size against the server's", () => {
    it('promises the cap the upload route refuses above', () => {
        expect(
            DASHBOARD_LABEL,
            'Reconcile `UPLOAD_SIZE_LABEL` in `web/src/uploads/uploadLimits.ts` with `UPLOAD_SIZE_LABEL` in `src/features-system/guild-uploads/constants.ts`.'
        ).toBe(UPLOAD_SIZE_LABEL);
    });

    it('refuses in the browser at the same byte the server does', () => {
        expect(
            DASHBOARD_BYTES,
            'Reconcile `UPLOAD_SIZE_BYTES` in `web/src/uploads/uploadLimits.ts` with `UPLOAD_BODY_LIMIT_BYTES` in `src/features-system/guild-uploads/constants.ts`.'
        ).toBe(UPLOAD_BODY_LIMIT_BYTES);
    });
});
