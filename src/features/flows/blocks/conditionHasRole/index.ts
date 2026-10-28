import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { MEMBER_CHOICE_CARD_PART, MEMBER_CHOICE_FIELD, memberChoiceSchema, memberFor } from '../memberChoice';

export const CONDITION_HAS_ROLE = 'condition.hasRole';

export const hasRoleConfigSchema = z.object({
    roleId: z.string().min(1),
    member: memberChoiceSchema,
});

export type HasRoleConfig = z.infer<typeof hasRoleConfigSchema>;

export const block: BlockManifest<HasRoleConfig> = {
    type: CONDITION_HAS_ROLE,
    kind: 'condition',
    label: 'Has Role?',
    description: 'Split the path on whether they already hold a role.',
    group: 'conditions',
    icon: '🎭',
    configSchema: hasRoleConfigSchema,
    configFields: [
        {
            key: 'roleId',
            label: 'Role to check',
            description: 'The role they must already hold. Leave by Yes if they do, No if they do not.',
            control: 'rolePicker',
        },
        MEMBER_CHOICE_FIELD,
    ],
    cardSummary: [{ key: 'roleId', prefix: 'Checks for ', emptyText: 'no role picked' }, MEMBER_CHOICE_CARD_PART],
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
        return {
            kind: 'continue',
            handle: memberFor(context, config.member).roles.cache.has(config.roleId) ? 'true' : 'false',
        };
    },
};
