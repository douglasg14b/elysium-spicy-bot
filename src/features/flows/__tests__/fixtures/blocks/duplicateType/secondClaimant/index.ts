import { z } from 'zod';
import type { BlockManifest } from '../../../../../blocks/manifest';

/** The sibling claiming the same `type`. Discovery must refuse, naming both. */
export const block: BlockManifest<Record<string, never>> = {
    type: 'fixture.duplicate',
    kind: 'action',
    label: 'Second Claimant',
    description: 'Claims a type its sibling also claims.',
    group: 'actions',
    icon: '2️⃣',
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
