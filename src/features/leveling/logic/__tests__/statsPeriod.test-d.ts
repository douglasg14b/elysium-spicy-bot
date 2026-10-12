import { describe, expectTypeOf, it } from 'vitest';
import type { StatsPeriodsMismatch } from '../statsPeriod';

/*
 * `STATS_PERIODS` lists exactly the `StatsPeriod` members, so no period picker can be
 * missing one. Here rather than only in `statsPeriod.ts` because `pnpm test` ignores type
 * errors inside source files.
 */
describe('STATS_PERIODS', () => {
    it('lists exactly the stats periods', () => {
        expectTypeOf<StatsPeriodsMismatch>().toBeNever();
    });
});
