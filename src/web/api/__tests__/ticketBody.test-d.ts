import { describe, expectTypeOf, it } from 'vitest';
import type { TicketBodyMismatch } from '../ticketBody';

/*
 * The ticket permission schemas state the domain types the routes send as they are. A
 * failure names the check, e.g. `"TicketRolePermissions"`. Here rather than only in
 * `ticketBody.ts` because `pnpm test` ignores type errors inside source files.
 */
describe('the ticket wire schemas', () => {
    it('state every domain type they describe', () => {
        expectTypeOf<TicketBodyMismatch>().toBeNever();
    });
});
