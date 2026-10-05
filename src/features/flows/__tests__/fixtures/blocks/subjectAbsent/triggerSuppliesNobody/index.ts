import { z } from 'zod';
import type { BlockManifest } from '../../../../../blocks/manifest';

/**
 * A trigger whose runs are about nobody: it declares no `subject` in `requires`, so it
 * supplies no member — the shape step 3's Schedule trigger will have. Test-only, with no
 * `startedBy`, so no dispatcher ever selects it; tests drive it through `executeFlow`.
 */
export const FIXTURE_TRIGGER_SUPPLIES_NOBODY = 'fixture.triggerSuppliesNobody';

export const triggerSuppliesNobodyConfigSchema = z.object({});

export type TriggerSuppliesNobodyConfig = z.infer<typeof triggerSuppliesNobodyConfigSchema>;

export const block: BlockManifest<TriggerSuppliesNobodyConfig> = {
    type: FIXTURE_TRIGGER_SUPPLIES_NOBODY,
    kind: 'trigger',
    label: 'Supplies Nobody',
    description: 'Starts runs about nobody. Test fixture, not for a palette.',
    group: 'triggers',
    icon: '🕳️',
    configSchema: triggerSuppliesNobodyConfigSchema,
    configFields: [],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
