import { describe, expectTypeOf, it } from 'vitest';
import type { NonWireMembersAreWithheld } from '../nodeRoutes';

/*
 * `/api/nodes` withholds exactly the manifest members that are not for the wire: none
 * dropped from the builder, none served that should stay on the server. Here rather than
 * only in `nodeRoutes.ts` because `pnpm test` ignores type errors inside source files.
 */
describe('the node catalogue', () => {
    it('withholds exactly the members that are not for the wire', () => {
        expectTypeOf<NonWireMembersAreWithheld>().toEqualTypeOf<true>();
    });
});
