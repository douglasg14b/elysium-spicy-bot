import { describe, expect, it } from 'vitest';
import { PLAN_ACTIONS } from '../../../features/provisioning/logic/installPlan';
import { REFUSAL_REASONS } from '../../../features/provisioning/logic/unpublishPlan';
import * as browserTypes from '../../../../web/src/api/types';

/**
 * The drift gate between provisioning's closed vocabularies and the browser's copies.
 *
 * Both lists are hand-mirrored in `web/src/api/types.ts` for the reason
 * `ticketWireShapeDrift.test.ts` records: `web/src` cannot import from `src/`. Neither
 * side's compiler can see the other, so an action added on the server alone reaches the
 * install dialog as an item its filters silently drop — the dialog would stop listing a
 * change the operator is approving. That is the failure `recover` would have shipped
 * with had the mirror been missed.
 */

const VOCABULARIES = [
    { name: 'install plan actions', server: PLAN_ACTIONS, browser: browserTypes.INSTALL_PLAN_ACTIONS },
    { name: 'unpublish refusal reasons', server: REFUSAL_REASONS, browser: browserTypes.REFUSAL_REASONS },
] as const;

describe('provisioning vocabularies agree with the browser', () => {
    it.each(VOCABULARIES)('$name', ({ server, browser }) => {
        expect([...browser].sort()).toEqual([...server].sort());
    });
});
