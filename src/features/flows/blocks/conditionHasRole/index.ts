import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const CONDITION_HAS_ROLE = 'condition.hasRole';

export const hasRoleConfigSchema = z.object({
    roleId: z.string().min(1),
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
    ],
    cardSummary: [{ key: 'roleId', prefix: 'Checks for ', emptyText: 'no role picked' }],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
    ],
    outputs: [],
    requires: ['member'],
    capabilities: [],
    canSuspend: false,
    run(config, context) {
        return {
            kind: 'continue',
            handle: context.member.roles.cache.has(config.roleId) ? 'true' : 'false',
        };
    },
};
