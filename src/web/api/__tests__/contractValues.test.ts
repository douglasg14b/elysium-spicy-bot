import { describe, expect, it } from 'vitest';
import { BLOCK_PALETTE_GROUPS } from '../../../features/flows/blocks/manifest';
import { FLOW_GRAPH_VERSION } from '../../../features/flows/data/flowGraph';
import { ELIGIBILITY_PERMISSIONS, ELIGIBILITY_PRINCIPALS } from '../../../features/flows/engine/eligibility';
import { ACTIVITY_STATUSES } from '../../../features/leveling/cards/statsCard/statsCardMetrics';
import { PERMISSION_ACCESS_LEVELS, PERMISSION_AUDIENCES } from '../../../features/provisioning/logic/permissionIntent';
import { COHORT_KEYS } from '../../../features/leveling/logic/levelingCohorts';
import { STATS_PERIODS } from '../../../features/leveling/logic/statsPeriod';
import * as browser from '../../../../web/src/flows/contractValues';
import * as browserLeveling from '../../../../web/src/leveling/contractValues';

/**
 * The values the dashboard reads off the generated zod at runtime come out as the server's.
 *
 * The types are held by `SchemaMatches` in `nodeBody.ts`/`flowBody.ts`, and by the leveling
 * builders being typed by `levelingBody.ts`; this is the other half — that reading a value
 * back out of the generated schema (an enum's options, each union arm's literal) lands on the
 * same list, in the same order the palette, the gate control, the permission editor, the
 * period picker and the cohort legend show it.
 */
describe('values read off the generated contract', () => {
    it.each([
        { name: 'the graph version', browser: browser.FLOW_GRAPH_VERSION, server: FLOW_GRAPH_VERSION },
        { name: 'the palette groups, in order', browser: browser.BLOCK_PALETTE_GROUPS, server: BLOCK_PALETTE_GROUPS },
        { name: 'the gate principals', browser: browser.ELIGIBILITY_PRINCIPALS, server: ELIGIBILITY_PRINCIPALS },
        { name: 'the gate permissions', browser: browser.ELIGIBILITY_PERMISSIONS, server: ELIGIBILITY_PERMISSIONS },
        { name: 'the permission audiences, in order', browser: browser.PERMISSION_AUDIENCES, server: PERMISSION_AUDIENCES },
        { name: 'the permission access levels, in order', browser: browser.PERMISSION_ACCESS_LEVELS, server: PERMISSION_ACCESS_LEVELS },
        { name: 'the stats periods, in order', browser: browserLeveling.STATS_PERIODS, server: STATS_PERIODS },
        { name: 'the activity statuses', browser: browserLeveling.ACTIVITY_STATUSES, server: ACTIVITY_STATUSES },
        { name: 'the cohorts, in order', browser: browserLeveling.COHORT_KEYS, server: COHORT_KEYS },
    ])('reads $name as the server declares it', ({ browser: read, server }) => {
        expect(read).toEqual(server);
    });
});
