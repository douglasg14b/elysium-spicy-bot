import { z } from 'zod';
import type { ActionNodeDefinition } from './types';

export const ACTION_REMOVE_ROLE = 'action.removeRole';

export const removeRoleConfigSchema = z.object({
    roleId: z.string().min(1),
});

export type RemoveRoleConfig = z.infer<typeof removeRoleConfigSchema>;

export const actionRemoveRoleNode: ActionNodeDefinition<RemoveRoleConfig> = {
    type: ACTION_REMOVE_ROLE,
    kind: 'action',
    label: 'Remove Role',
    configSchema: removeRoleConfigSchema,
    async execute(config, context) {
        await context.member.roles.remove(config.roleId);
    },
};
