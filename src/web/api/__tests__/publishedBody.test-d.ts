import { describe, expectTypeOf, it } from 'vitest';
import type { PublishedBodyMismatch } from '../publishedBody';

/*
 * The inventory schemas state the domain types the routes send as they are. A failure
 * names the check, e.g. `"PublishedResource"`. Here rather than only in `publishedBody.ts`
 * because `pnpm test` ignores type errors inside source files.
 */
describe('the published-state wire schemas', () => {
    it('state every domain type they describe', () => {
        expectTypeOf<PublishedBodyMismatch>().toBeNever();
    });
});
