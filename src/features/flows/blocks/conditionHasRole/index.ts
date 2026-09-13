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
            label: 'Role',
            description: 'The role to check for.',
            control: 'rolePicker',
        },
    ],
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
