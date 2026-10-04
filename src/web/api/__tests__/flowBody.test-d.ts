import { describe, expectTypeOf, it } from 'vitest';
import type { FlowBodyMismatch } from '../flowBody';

/*
 * The flow schemas state the domain types the routes send as they are: the graph, an
 * issue, a journey membership. A failure names the check, e.g. `"FlowGraph"`. Here rather
 * than only in `flowBody.ts` because `pnpm test` ignores type errors inside source files.
 */
describe('the flow wire schemas', () => {
    it('state every domain type they describe', () => {
        expectTypeOf<FlowBodyMismatch>().toBeNever();
    });
});
