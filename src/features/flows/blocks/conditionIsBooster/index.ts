import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const CONDITION_IS_BOOSTER = 'condition.isBooster';

export const isBoosterConfigSchema = z.object({});

export type IsBoosterConfig = z.infer<typeof isBoosterConfigSchema>;

export const block: BlockManifest<IsBoosterConfig> = {
    type: CONDITION_IS_BOOSTER,
    kind: 'condition',
    label: 'Is Booster?',
    description: 'Split the path on whether they are currently boosting the server.',
    group: 'conditions',
    icon: '💎',
    note: 'Checks their boost status each time the run reaches this block, not when the run started.',
    configSchema: isBoosterConfigSchema,
    configFields: [],
    cardSummary: [{ text: 'Currently boosting?' }],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
    ],
    outputs: [],
    requires: ['subject'],
    capabilities: [],
    canSuspend: false,
    run(_config, context) {
        // `premiumSince` is null both for a member who has never boosted and for one
        // who has stopped, which is exactly the distinction this block is asked about.
        //
        // Read off the member the run carries. On a run resuming from a suspend that
        // member comes from `guild.members.fetch()`, which serves cache first — so a
        // boost change during a long wait may not be seen until the gateway delivers
        // the member update. The `note` promises no more than that.
        return {
            kind: 'continue',
            handle: context.subject.premiumSince ? 'true' : 'false',
        };
    },
};
