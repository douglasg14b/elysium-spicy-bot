import { describe, expectTypeOf, it } from 'vitest';
import type { JourneyBodyMismatch } from '../journeyBody';

/*
 * The journey schemas state the domain types the routes send as they are: a declaration,
 * its permissions, the merge plan and a repair's result. A failure names the check, e.g.
 * `"KeyCollision"`. Here rather than only in `journeyBody.ts` because `pnpm test` ignores
 * type errors inside source files.
 */
describe('the journey wire schemas', () => {
    it('state every domain type they describe', () => {
        expectTypeOf<JourneyBodyMismatch>().toBeNever();
    });
});
