import { describe, expectTypeOf, it } from 'vitest';
import type { UploadUseBody } from '../../../src/web/api/uploadBody';
import type { ApiError } from '../src/apiError';

/* A refused delete's uses, as `ApiError` carries them, are the server's wire shape. */
describe('ApiError.uses', () => {
    it("is typed as the server's UploadUse", () => {
        expectTypeOf<ApiError['uses'][number]>().toEqualTypeOf<UploadUseBody>();
    });
});
