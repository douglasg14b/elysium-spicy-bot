import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const ACTION_REMOVE_ROLE = 'action.removeRole';

export const removeRoleConfigSchema = z.object({
    roleId: z.string().min(1),
});

export type RemoveRoleConfig = z.infer<typeof removeRoleConfigSchema>;

export const block: BlockManifest<RemoveRoleConfig> = {
    type: ACTION_REMOVE_ROLE,
    kind: 'action',
    label: 'Remove Role',
    description: 'Take a role away. Good for clearing a temporary pass, or the waiting room.',
    group: 'actions',
    icon: '➖',
    configSchema: removeRoleConfigSchema,
    configFields: [
        {
            key: 'roleId',
            label: 'Role to remove',
            description: 'The role to take back. Taken from the member this run is about.',
            control: 'rolePicker',
        },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['member'],
    capabilities: ['manageRoles'],
    canSuspend: false,
    async run(config, context) {
        await context.member.roles.remove(config.roleId);
        return { kind: 'continue' };
    },
};
