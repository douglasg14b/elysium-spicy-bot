import { describe, expectTypeOf, it } from 'vitest';
import type { QuietWindowShapesAgree, SnapshotShapesAgree } from '../flowRunsRepo';

/*
 * The two JSON columns whose type and read-back schema are declared separately agree key
 * for key, optional keys included: `z.object` strips what it does not declare, so a key
 * on the type alone would be written and silently dropped on read. Here rather than only
 * in `flowRunsRepo.ts` because `pnpm test` ignores type errors inside source files.
 */
describe('the flow run columns', () => {
    it('read back the context snapshot they write', () => {
        expectTypeOf<SnapshotShapesAgree>().toEqualTypeOf<true>();
    });

    it('read back the quiet window they write', () => {
        expectTypeOf<QuietWindowShapesAgree>().toEqualTypeOf<true>();
    });
});
