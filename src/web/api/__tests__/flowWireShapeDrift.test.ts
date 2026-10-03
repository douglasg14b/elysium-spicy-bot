import { describe, expect, it } from 'vitest';
import {
    FLOW_DETAIL_KEYS,
    FLOW_DRAFT_KEYS,
    FLOW_DRAFT_SUMMARY_KEYS,
    FLOW_SAVE_TARGETS,
    FLOW_SAVED_AS_DRAFT_KEYS,
    FLOW_SAVED_TO_FLOW_KEYS,
} from '../flowBody';
import * as browserTypes from '../../../../web/src/api/types';

/**
 * The drift gate between the flow wire shapes and the browser's copy of them.
 *
 * Same mechanism as `ticketWireShapeDrift.test.ts`, and for the same reason: `Flow` and
 * the draft shapes exist twice — `flowBody.ts` here, hand-written in `web/src/api/types.ts`
 * there — because the browser project cannot import from `src/`. Each side's own `tsc`
 * holds its member list to its interface in both directions, so this only compares the
 * lists. The flows list's `FlowSummary` left this gate when the list moved to the
 * generated SDK; the rest leave when the flow builder does.
 *
 * Worth a gate now rather than later because readiness put a member on each shape the
 * pages act on: a server that stopped sending `issues` would open every flow looking
 * ready — with both typechecks green.
 */

const REMEDY =
    'Reconcile `Flow` / `FlowDraft` and their *_KEYS arrays in `web/src/api/types.ts` with ' +
    'the wire shapes in `src/web/api/flowBody.ts`. Both sides export member lists their own ' +
    'compiler holds to the interface, so the fix is to add the member in both places.';

const SHAPES = [
    { name: 'Flow', server: FLOW_DETAIL_KEYS, browser: browserTypes.FLOW_DETAIL_KEYS },
    { name: 'FlowDraftSummary', server: FLOW_DRAFT_SUMMARY_KEYS, browser: browserTypes.FLOW_DRAFT_SUMMARY_KEYS },
    { name: 'FlowDraft', server: FLOW_DRAFT_KEYS, browser: browserTypes.FLOW_DRAFT_KEYS },
    { name: "FlowSaveResult (savedAs: 'flow')", server: FLOW_SAVED_TO_FLOW_KEYS, browser: browserTypes.FLOW_SAVED_TO_FLOW_KEYS },
    { name: "FlowSaveResult (savedAs: 'draft')", server: FLOW_SAVED_AS_DRAFT_KEYS, browser: browserTypes.FLOW_SAVED_AS_DRAFT_KEYS },
    // A vocabulary rather than a key list: a third `savedAs` the page does not branch on
    // would be a save it reports as neither.
    { name: 'savedAs', server: FLOW_SAVE_TARGETS, browser: browserTypes.FLOW_SAVE_TARGETS },
] as const satisfies readonly { name: string; server: readonly string[]; browser: readonly string[] }[];

describe('flow wire shape drift between server and browser', () => {
    it.each(SHAPES)('keeps $name identical on both sides', ({ name, server, browser }) => {
        const serverMembers = [...server].sort();
        const browserMembers = [...browser].sort();

        expect(
            browserMembers,
            `\`${name}\` has drifted. Server: [${serverMembers.join(', ')}]; browser ` +
                `(web/src/api/types.ts): [${browserMembers.join(', ')}]. ${REMEDY}`
        ).toEqual(serverMembers);
    });
});
