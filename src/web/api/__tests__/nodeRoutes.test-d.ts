import type { z } from '@hono/zod-openapi';
import { describe, expectTypeOf, it } from 'vitest';
import type { NodeDescriptorSchema } from '../nodeBody';
import type { NON_WIRE_MEMBERS, NonWireMembersAreWithheld } from '../nodeRoutes';

/*
 * `/api/nodes` withholds exactly the manifest members that are not for the wire: none
 * dropped from the builder, none served that should stay on the server. Here rather than
 * only in `nodeRoutes.ts` because `pnpm test` ignores type errors inside source files.
 */
describe('the node catalogue', () => {
    it('withholds exactly the members that are not for the wire', () => {
        expectTypeOf<NonWireMembersAreWithheld>().toEqualTypeOf<true>();
    });

    /*
     * `emits` is what a block's action causes, read only by the loop check a flow faces as
     * it goes live (`engine/flowCycles.ts`). Nothing in the builder draws from it, so it is
     * withheld like `configSchema` and `run`. Named here rather than left to the check above,
     * which holds just as well with `emits` taken off the list *and* out of the destructure —
     * and then the descriptor schema, held to the manifest, would have someone add it to the
     * spec.
     */
    it('never serves what a block causes', () => {
        expectTypeOf<Extract<(typeof NON_WIRE_MEMBERS)[number], 'emits'>>().toEqualTypeOf<'emits'>();
        expectTypeOf<Extract<keyof z.infer<typeof NodeDescriptorSchema>, 'emits'>>().toBeNever();
    });
});
