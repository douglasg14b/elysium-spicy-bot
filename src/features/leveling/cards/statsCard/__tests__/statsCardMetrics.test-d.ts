import { describe, expectTypeOf, it } from 'vitest';
import type { ActivityStatusesMismatch } from '../statsCardMetrics';

/*
 * `ACTIVITY_STATUSES` lists exactly the `ActivityStatus` members, so what crosses the wire
 * as a value cannot fall behind the union. Here rather than only in `statsCardMetrics.ts`
 * because `pnpm test` ignores type errors inside source files.
 */
describe('ACTIVITY_STATUSES', () => {
    it('lists exactly the activity statuses', () => {
        expectTypeOf<ActivityStatusesMismatch>().toBeNever();
    });
});
