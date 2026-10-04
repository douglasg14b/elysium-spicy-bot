import { describe, expect, it } from 'vitest';
import { REFUSAL_REASONS } from '../../../features/provisioning/logic/unpublishPlan';
import * as browserTypes from '../../../../web/src/api/types';

/**
 * The drift gate between provisioning's closed vocabularies and the browser's copies.
 *
 * Hand-mirrored in `web/src/api/types.ts` for the reason `levelingWireShapeDrift.test.ts`
 * records: `web/src` cannot import from `src/`. Neither side's compiler can see the other,
 * so a reason added on the server alone reaches the teardown dialog as a refusal it cannot
 * group. The install plan's actions were gated here too until the builder read the
 * install plan from the generated SDK, whose type is the spec's own enum.
 */

const VOCABULARIES = [
    { name: 'unpublish refusal reasons', server: REFUSAL_REASONS, browser: browserTypes.REFUSAL_REASONS },
] as const;

describe('provisioning vocabularies agree with the browser', () => {
    it.each(VOCABULARIES)('$name', ({ server, browser }) => {
        expect([...browser].sort()).toEqual([...server].sort());
    });
});
