import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { changeableRole } from '../../logic/roleSafety';
import { requireSubject } from '../types';

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
    cardSummary: [{ key: 'roleId', prefix: 'Remove ', emptyText: 'no role picked' }],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['subject'],
    capabilities: ['manageRoles'],
    emits: [],
    canSuspend: false,
    async run(config, context) {
        // Asked again on every run, as Assign Role asks it: stripping a moderator's
        // role is as much a privilege change as handing one out.
        const role = changeableRole(context.guild, config.roleId);
        if (!role.ok) {
            return { kind: 'fail', error: role.error };
        }
        await requireSubject(context).roles.remove(role.role.id);
        return { kind: 'continue' };
    },
};
