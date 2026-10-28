import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { MEMBER_CHOICE_CARD_PART, MEMBER_CHOICE_FIELD, memberChoiceSchema, memberFor } from '../memberChoice';

export const CONDITION_IS_BOOSTER = 'condition.isBooster';

export const isBoosterConfigSchema = z.object({
    member: memberChoiceSchema,
});

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
    configFields: [MEMBER_CHOICE_FIELD],
    cardSummary: [{ text: 'Currently boosting?' }, MEMBER_CHOICE_CARD_PART],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
    ],
    outputs: [],
    // The member choice says who it needs: the member, or whoever set this off.
    requires: [],
    capabilities: [],
    emits: [],
    canSuspend: false,
    run(config, context) {
        // `premiumSince` is null both for a member who has never boosted and for one
        // who has stopped, which is exactly the distinction this block is asked about.
        //
        // Read off the member the run carries. On a run resuming from a suspend that
        // member comes from `guild.members.fetch()`, which serves cache first — so a
        // boost change during a long wait may not be seen until the gateway delivers
        // the member update. The `note` promises no more than that.
        return {
            kind: 'continue',
            handle: memberFor(context, config.member).premiumSince ? 'true' : 'false',
        };
    },
};
