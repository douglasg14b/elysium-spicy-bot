import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { changeableRole } from '../../logic/roleSafety';
import { requireSubject } from '../types';

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
    cardSummary: [{ key: 'roleId', prefix: 'Assign ', emptyText: 'no role picked' }],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['subject'],
    capabilities: ['manageRoles'],
    emits: [],
    canSuspend: false,
    async run(config, context) {
        // Asked again on every run, not only at save: a role somebody granted
        // Administrator after the flow went live is refused from then on.
        const role = changeableRole(context.guild, config.roleId);
        if (!role.ok) {
            return { kind: 'fail', error: role.error };
        }
        await requireSubject(context).roles.add(role.role.id);
        return { kind: 'continue' };
    },
};
