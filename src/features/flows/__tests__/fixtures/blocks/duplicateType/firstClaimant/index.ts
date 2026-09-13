import { z } from 'zod';
import type { BlockManifest } from '../../../../../blocks/manifest';

/** Claims `fixture.duplicate`. So does its sibling — which must be an error. */
export const block: BlockManifest<Record<string, never>> = {
    type: 'fixture.duplicate',
    kind: 'action',
    label: 'First Claimant',
    description: 'Claims a type its sibling also claims.',
    group: 'actions',
    icon: '1️⃣',
    configSchema: z.object({}),
    configFields: [],
    handles: [{ label: 'Next', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
