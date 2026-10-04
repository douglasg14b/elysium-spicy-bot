import { describe, expectTypeOf, it } from 'vitest';
import type { NodeBodyMismatch } from '../nodeBody';

/*
 * The spec states the block descriptor exactly as the manifest declares it.
 *
 * `nodeBody.ts` holds every schema to its manifest type (`NodeBodyChecks`), but a type
 * error inside that file is a source error, and `pnpm test`'s typecheck mode ignores those
 * (`ignoreSourceErrors` in `vitest.config.ts`); root `tsc`, the only other checker, is not
 * in CI. Asserted here, in a `.test-d.ts`, a drifted schema fails the suite — and the
 * failure names the check, e.g. `"configField.textList"` or `"BlockOutputDeclaration.fixed"`.
 */
describe('the descriptor schemas', () => {
    it('state every manifest type they describe, member by member', () => {
        expectTypeOf<NodeBodyMismatch>().toBeNever();
    });
});
