import { describe, expect, it } from 'vitest';
import { REPAIR_OUTCOMES } from '../../../features/provisioning/logic/applyDriftRepair';
import {
    DRIFT_BODY_KEYS,
    DRIFT_DETAIL_KEYS,
    DRIFT_RESOURCE_KEYS,
    ORPHAN_KEYS,
    UNCHECKED_KEYS,
} from '../driftBody';
import * as browserTypes from '../../../../web/src/api/types';

/**
 * The drift gate between the drift wire shapes and the browser's copy of them.
 *
 * The same machinery as `ticketWireShapeDrift.test.ts`, for the same reason: the shapes
 * exist twice because a single `import type` from `src/` inside `web/src/` pulls the
 * whole bot source tree into the browser's compilation, and this test stands in for the
 * type system across that gap.
 *
 * ## Why this exists rather than being assumed unnecessary
 *
 * It was not written with the feature, and the omission cost something specific.
 * `RepairOutcome` was mirrored in the browser with a **fourth** member,
 * `partiallyRepaired`, that the server has never emitted — the name appears in `src/`
 * only inside a comment describing an intent the code does not implement. The browser
 * filtered on it, always matched nothing, and reported every partial repair as a flat
 * failure: an operator whose channel really had been renamed before a later permission
 * write threw was told nothing happened to it. That is the exact misreport the server's
 * `PartialRepairError` machinery exists to prevent, defeated at the wire boundary.
 *
 * Two clean typechecks and forty-three passing tests said nothing, because each
 * workspace compiles only against its own copy. The vocabulary row below is the one
 * that would have caught it on the first run.
 */

const REMEDY =
    'Reconcile the drift interfaces and their *_KEYS arrays in `web/src/api/types.ts` with ' +
    'the wire shapes in `src/web/api/driftBody.ts`. Both sides export member lists their own ' +
    'compiler holds to the interface, so the fix is to add the member in both places.';

const SHAPES = [
    { name: 'DriftDetail', server: DRIFT_DETAIL_KEYS, browser: browserTypes.DRIFT_DETAIL_KEYS },
    {
        name: 'DriftedResource',
        server: DRIFT_RESOURCE_KEYS,
        browser: browserTypes.DRIFT_RESOURCE_KEYS,
    },
    /*
     * `bindingId` is the highest-consequence member here: it is the only thing the
     * forget route accepts, so a rename on one side alone leaves the browser posting
     * `undefined` at a URL and every orphan permanently unremovable.
     */
    { name: 'OrphanedResource', server: ORPHAN_KEYS, browser: browserTypes.ORPHAN_KEYS },
    { name: 'UncheckedResource', server: UNCHECKED_KEYS, browser: browserTypes.UNCHECKED_KEYS },
    { name: 'JourneyDrift', server: DRIFT_BODY_KEYS, browser: browserTypes.DRIFT_BODY_KEYS },
] as const satisfies readonly { name: string; server: readonly string[]; browser: readonly string[] }[];

describe('drift wire shape drift between server and browser', () => {
    it.each(SHAPES)('keeps $name identical on both sides', ({ name, server, browser }) => {
        const serverMembers = [...server].sort();
        const browserMembers = [...browser].sort();

        expect(
            browserMembers,
            `\`${name}\` has drifted. Server: [${serverMembers.join(', ')}]; browser ` +
                `(web/src/api/types.ts): [${browserMembers.join(', ')}]. A member the browser does ` +
                `not declare is one it is served and cannot read. ${REMEDY}`
        ).toEqual(serverMembers);
    });

    it('keeps the repair outcome vocabulary identical on both sides', () => {
        const serverOutcomes = [...REPAIR_OUTCOMES].sort();
        const browserOutcomes = [...browserTypes.REPAIR_OUTCOMES].sort();

        expect(
            browserOutcomes,
            `REPAIR_OUTCOMES has drifted. Server: [${serverOutcomes.join(', ')}]; browser: ` +
                `[${browserOutcomes.join(', ')}]. This union is closed on the server and is what ` +
                '`summariseRepair` branches on, so an extra member in the browser is a branch that ' +
                'never runs — which is how partial repairs came to be reported as total failures. ' +
                'A partial repair is `failed` carrying a populated `repaired`, not an outcome of ' +
                'its own.'
        ).toEqual(serverOutcomes);
    });
});
