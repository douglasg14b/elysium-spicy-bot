import { describe, expectTypeOf, it } from 'vitest';
import type { InstallBodyMismatch } from '../installBody';

/*
 * The deploy, undeploy, install and unpublish schemas state the domain results the routes
 * send as they are. A failure names the check, e.g. `"DeployedButtonMessage"`. Here rather
 * than only in `installBody.ts` because `pnpm test` ignores type errors inside source files.
 */
describe('the install wire schemas', () => {
    it('state every domain type they describe', () => {
        expectTypeOf<InstallBodyMismatch>().toBeNever();
    });
});
