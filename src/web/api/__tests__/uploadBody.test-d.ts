import { describe, expectTypeOf, it } from 'vitest';
import type { UploadBodyMismatch } from '../uploadBody';

/*
 * The upload wire schemas state the domain type the routes send as it is: one use of an
 * upload. Here rather than only in `uploadBody.ts` because `pnpm test` ignores type errors
 * inside source files.
 */
describe('the upload wire schemas', () => {
    it('state every domain type they describe', () => {
        expectTypeOf<UploadBodyMismatch>().toBeNever();
    });
});
