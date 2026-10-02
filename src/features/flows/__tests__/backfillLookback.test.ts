import { describe, expect, it } from 'vitest';
import { ACTIVITY_BACKFILL_LOOKBACK_MS } from '../../../features-system/activity/backfillGaps';
import { FLOW_MAX_DELAY_MS } from '../constants';

/**
 * Activity backfills as far back as the longest quiet window, and declares that span
 * itself because it imports no feature. This holds the two copies together: a longer
 * window with a shorter backfill would time out runs on messages nobody recovered.
 */
describe("activity's backfill lookback", () => {
    it('reaches back exactly as far as the longest quiet window', () => {
        expect(ACTIVITY_BACKFILL_LOOKBACK_MS).toBe(FLOW_MAX_DELAY_MS);
    });
});
