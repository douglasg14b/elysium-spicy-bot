import { describe, expect, it } from 'vitest';
import { TICKET_STATUSES } from '../../../features/tickets/data/ticketsSchema';
import {
    TICKETING_CONFIG_VIEW_KEYS,
    TICKET_ACTION_RESULT_KEYS,
    TICKET_COUNTS_KEYS,
    TICKET_DETAIL_KEYS,
    TICKET_PARTICIPANT_KEYS,
    TICKET_SUMMARY_KEYS,
    TICKET_TYPE_VIEW_KEYS,
} from '../ticketRoutes';
import * as browserTypes from '../../../../web/src/api/types';

/**
 * The drift gate between the ticket wire shapes and the browser's copy of them.
 *
 * Every shape here exists twice: once on the server in `ticketRoutes.ts` and once as a
 * hand-written interface in `web/src/api/types.ts`. It **has** to exist twice — a single
 * `import type` from `src/` inside `web/src/` pulls the whole bot source tree into the
 * browser project's compilation and breaks `pnpm build:web` — so this test is what stops
 * the copy rotting, in place of the type system.
 *
 * **The comparison is data, not text**, exactly as `nodeDescriptorDrift.test.ts` does
 * it. Each side exports `as const` member lists that its *own* `tsc` holds to the
 * interface in both directions: `satisfies` rejects a name that is not a member, and a
 * companion conditional type rejects a member missing from the list. So this test only
 * compares arrays, and no part of the gate depends on how either file is formatted.
 *
 * The import below crosses into the web workspace deliberately, and is safe for the same
 * reason the node-descriptor one is: `types.ts` is a leaf of types and frozen arrays,
 * pulling in no React, no DOM and no bot code. The reverse direction is what cannot work.
 */

const REMEDY =
    'Reconcile the ticket interfaces and their *_KEYS arrays in `web/src/api/types.ts` with ' +
    'the wire shapes in `src/web/api/ticketRoutes.ts`. Both sides export member lists their ' +
    'own compiler holds to the interface, so the fix is to add the member in both places.';

/**
 * Each shape paired with its two member lists.
 *
 * Table-driven so adding a wire shape means one row rather than a copied test, and so a
 * failure names which shape drifted rather than only that something did.
 */
const SHAPES = [
    { name: 'TicketParticipant', server: TICKET_PARTICIPANT_KEYS, browser: browserTypes.TICKET_PARTICIPANT_KEYS },
    { name: 'TicketSummary', server: TICKET_SUMMARY_KEYS, browser: browserTypes.TICKET_SUMMARY_KEYS },
    { name: 'TicketDetail', server: TICKET_DETAIL_KEYS, browser: browserTypes.TICKET_DETAIL_KEYS },
    /*
     * The highest-consequence row in the table. `syncWarning` is the sentence that says
     * the subject can still read a channel everyone believes is shut — renamed on one
     * side alone, both pages' `if (result.syncWarning)` silently never fires and neither
     * workspace's typecheck objects.
     */
    {
        name: 'TicketActionResult',
        server: TICKET_ACTION_RESULT_KEYS,
        browser: browserTypes.TICKET_ACTION_RESULT_KEYS,
    },
    { name: 'TicketCounts', server: TICKET_COUNTS_KEYS, browser: browserTypes.TICKET_COUNTS_KEYS },
    { name: 'TicketTypeView', server: TICKET_TYPE_VIEW_KEYS, browser: browserTypes.TICKET_TYPE_VIEW_KEYS },
    {
        name: 'TicketingConfigView',
        server: TICKETING_CONFIG_VIEW_KEYS,
        browser: browserTypes.TICKETING_CONFIG_VIEW_KEYS,
    },
] as const satisfies readonly { name: string; server: readonly string[]; browser: readonly string[] }[];

describe('ticket wire shape drift between server and browser', () => {
    it.each(SHAPES)('keeps $name identical on both sides', ({ name, server, browser }) => {
        const serverMembers = [...server].sort();
        const browserMembers = [...browser].sort();

        expect(
            browserMembers,
            `\`${name}\` has drifted. Server: [${serverMembers.join(', ')}]; browser ` +
                `(web/src/api/types.ts): [${browserMembers.join(', ')}]. A member the browser does not ` +
                `declare is one it is served and cannot read. ${REMEDY}`
        ).toEqual(serverMembers);
    });

    it('keeps the ticket status vocabulary identical on both sides', () => {
        const serverStatuses = [...TICKET_STATUSES].sort();
        const browserStatuses = [...browserTypes.TICKET_STATUSES].sort();

        expect(
            browserStatuses,
            `TICKET_STATUSES has drifted. Server: [${serverStatuses.join(', ')}]; browser: ` +
                `[${browserStatuses.join(', ')}]. This union is closed on both sides — it is what the ` +
                'row filter and `availableActions` switch on — so widening one alone leaves the ' +
                'dashboard unable to type a status it is being sent, or offering no actions for it.'
        ).toEqual(serverStatuses);
    });

    it('does not mirror a ticket type union, because there is deliberately no longer one', () => {
        // `TicketType` stopped being a closed union when types became guild data: the code
        // behind a value is a row in `ticketing_config`, not a branch in source. Asserted
        // rather than merely absent, so a later edit that "helpfully" reintroduces a
        // mirrored TICKET_TYPES list fails here and has to read this comment first.
        expect(browserTypes).not.toHaveProperty('TICKET_TYPES');
    });
});
