import { describe, expectTypeOf, it } from 'vitest';
import type { ResourceDriftKindsMismatch } from '../resourceDrift';

/*
 * `RESOURCE_DRIFT_KINDS` names every drift kind and nothing else, so the repair result's
 * wire schema, which enumerates it, cannot fall behind the union. Here rather than only in
 * `resourceDrift.ts` because `pnpm test` ignores type errors inside source files.
 */
describe('RESOURCE_DRIFT_KINDS', () => {
    it('lists exactly the drift kinds', () => {
        expectTypeOf<ResourceDriftKindsMismatch>().toBeNever();
    });
});
