import { describe, expect, it } from 'vitest';
import { BLOCK_PALETTE_GROUPS } from '../../../features/flows/blocks/manifest';
import { FLOW_GRAPH_VERSION } from '../../../features/flows/data/flowGraph';
import { ELIGIBILITY_PERMISSIONS, ELIGIBILITY_PRINCIPALS } from '../../../features/flows/engine/eligibility';
import * as browser from '../../../../web/src/flows/contractValues';

/**
 * The values the builder reads off the generated zod at runtime come out as the server's.
 *
 * The types are held by `SchemaMatches` in `nodeBody.ts`/`flowBody.ts`; this is the other
 * half — that reading a value back out of the generated schema (an enum's options, each
 * union arm's literal) lands on the same list, in the same order the palette and the gate
 * control show it.
 */
describe('values read off the generated contract', () => {
    it.each([
        { name: 'the graph version', browser: browser.FLOW_GRAPH_VERSION, server: FLOW_GRAPH_VERSION },
        { name: 'the palette groups, in order', browser: browser.BLOCK_PALETTE_GROUPS, server: BLOCK_PALETTE_GROUPS },
        { name: 'the gate principals', browser: browser.ELIGIBILITY_PRINCIPALS, server: ELIGIBILITY_PRINCIPALS },
        { name: 'the gate permissions', browser: browser.ELIGIBILITY_PERMISSIONS, server: ELIGIBILITY_PERMISSIONS },
    ])('reads $name as the server declares it', ({ browser: read, server }) => {
        expect(read).toEqual(server);
    });
});
