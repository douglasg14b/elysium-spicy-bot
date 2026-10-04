import { describe, expectTypeOf, it } from 'vitest';
import type { ResumeKindsAllDriven } from '../blocks/conformance';

/*
 * Every resume kind has a representative the suspending-block conformance check drives,
 * so a new kind cannot quietly shrink what every parking block is tested against. Here
 * rather than only in `conformance.ts` because `pnpm test` ignores type errors inside
 * source files.
 */
describe('RESUME_REPRESENTATIVES', () => {
    it('drives every resume kind', () => {
        expectTypeOf<ResumeKindsAllDriven>().toBeNever();
    });
});
