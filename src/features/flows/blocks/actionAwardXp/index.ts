import { z } from 'zod';
import { awardFlowXp, type FlowXpRefusal } from '../../../leveling';
import type { BlockManifest } from '../manifest';

export const ACTION_AWARD_XP = 'action.awardXp';

/**
 * `max` is a guard against a typo, not a balance rule.
 *
 * An author who means 100 and types 10000 has skipped a member past every level-gated
 * reward in the guild, and there is no undo: XP is cumulative and nothing subtracts it.
 * A ceiling makes the slip recoverable by making it not happen.
 */
const MAX_FLOW_XP_AWARD = 10_000;

/** See `triggerLevelReached` for why `z.coerce`: a `text` control yields a string. */
export const awardXpConfigSchema = z.object({
    amount: z.coerce.number().int().min(1).max(MAX_FLOW_XP_AWARD),
});

export type AwardXpConfig = z.infer<typeof awardXpConfigSchema>;

/**
 * Why a grant did not happen, in words an author can act on.
 *
 * A `Record` rather than a switch so that a new refusal reason in leveling is a compile
 * error here instead of a run that fails with an empty string.
 */
const REFUSAL_MESSAGE: Readonly<Record<FlowXpRefusal, string>> = {
    disabled:
        'Leveling is turned off in this server, so there is no XP to give. Turn it on before wiring a flow to award any.',
    'not-positive': 'The XP amount has to be a whole number above zero.',
};

export const block: BlockManifest<AwardXpConfig> = {
    type: ACTION_AWARD_XP,
    kind: 'action',
    label: 'Award XP',
    description: 'Hand out XP for good behaviour. Or whatever it is you are rewarding.',
    group: 'actions',
    icon: '✨',
    configSchema: awardXpConfigSchema,
    configFields: [
        {
            key: 'amount',
            label: 'XP to award',
            description: `How much to add to their lifetime total. Up to ${MAX_FLOW_XP_AWARD.toLocaleString()} at a time.`,
            control: 'text',
            placeholder: '100',
            defaultValue: '100',
        },
    ],
    /*
     * `stopIfEmpty`, so an unset amount reads "no amount set" rather than
     * "Awards no amount set XP" — `emptyText` otherwise renders inside the prefix and
     * suffix, which the manifest warns about at the `emptyText` declaration.
     */
    cardSummary: [
        { key: 'amount', prefix: 'Awards ', suffix: ' XP', emptyText: 'no amount set', stopIfEmpty: true },
    ],
    note: 'Announces a level-up in the usual channel if this pushes them over, but will not set off a Reaches Level trigger — that would let two flows feed each other forever.',
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['subject'],
    capabilities: [],
    canSuspend: false,
    async run(config, context) {
        const result = await awardFlowXp({
            client: context.client,
            guild: context.guild,
            userId: context.subject.id,
            xpAmount: config.amount,
        });

        if (!result.ok) {
            return { kind: 'fail', error: REFUSAL_MESSAGE[result.refusal] };
        }

        return { kind: 'continue' };
    },
};
