import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const ACTION_ASSIGN_ROLE = 'action.assignRole';

export const assignRoleConfigSchema = z.object({
    roleId: z.string().min(1),
});

export type AssignRoleConfig = z.infer<typeof assignRoleConfigSchema>;

export const block: BlockManifest<AssignRoleConfig> = {
    type: ACTION_ASSIGN_ROLE,
    kind: 'action',
    label: 'Assign Role',
    description: 'Give them a role. The usual way to let someone in — this is what unlocks the good stuff.',
    group: 'actions',
    icon: '➕',
    configSchema: assignRoleConfigSchema,
    configFields: [
        {
            key: 'roleId',
            label: 'Role to assign',
            description: 'The role to hand out. Given to the member this run is about.',
            control: 'rolePicker',
        },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['member'],
    capabilities: ['manageRoles'],
    canSuspend: false,
    async run(config, context) {
        await context.member.roles.add(config.roleId);
        return { kind: 'continue' };
    },
};
