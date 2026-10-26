import { describe, expect, it } from 'vitest';
import type { FlowAttachment } from '@brattybot/web-sdk';
import { builderResourcesTarget } from '../resourceSaveTarget';

/**
 * Where the builder saves its journey's Resources (pick 7): through the journey once the flow
 * is linked to one, and through the flow until then — the flow route is the one that writes
 * the link, and the journey route would store a journey nothing names.
 */

const FLOW_ID = 'flow-1';

function attachment(overrides: Partial<FlowAttachment>): FlowAttachment {
    return { journeyKey: 'welcome', linked: true, name: 'Welcome', resourceCount: 2, sharedWith: [], ...overrides };
}

describe('builderResourcesTarget', () => {
    it('saves through the flow while the attachment has not been read', () => {
        expect(builderResourcesTarget(FLOW_ID, null)).toEqual({ kind: 'flow', flowId: FLOW_ID });
    });

    it('saves through the flow while only the pre-link fallback answers', () => {
        // Keyed by the flow's own id, with no link row: the first save through the flow writes it.
        const fallback = attachment({ journeyKey: FLOW_ID, linked: false, resourceCount: 0 });

        expect(builderResourcesTarget(FLOW_ID, fallback)).toEqual({ kind: 'flow', flowId: FLOW_ID });
    });

    it('saves through the journey once the flow is linked to it, shared or not', () => {
        expect(builderResourcesTarget(FLOW_ID, attachment({}))).toEqual({ kind: 'journey', journeyKey: 'welcome' });
        expect(
            builderResourcesTarget(FLOW_ID, attachment({ sharedWith: [{ flowId: 'flow-2', name: 'Goodbye' }] }))
        ).toEqual({ kind: 'journey', journeyKey: 'welcome' });
    });
});
