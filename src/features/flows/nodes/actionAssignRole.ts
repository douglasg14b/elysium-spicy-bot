import { z } from 'zod';
import type { ActionNodeDefinition } from './types';

export const ACTION_ASSIGN_ROLE = 'action.assignRole';

export const assignRoleConfigSchema = z.object({
    roleId: z.string().min(1),
});

export type AssignRoleConfig = z.infer<typeof assignRoleConfigSchema>;

export const actionAssignRoleNode: ActionNodeDefinition<AssignRoleConfig> = {
    type: ACTION_ASSIGN_ROLE,
    kind: 'action',
    label: 'Assign Role',
    configSchema: assignRoleConfigSchema,
    async execute(config, context) {
        await context.member.roles.add(config.roleId);
    },
};
