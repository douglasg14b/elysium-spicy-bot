import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { changeableRole } from '../../logic/roleSafety';
import { MEMBER_CHOICE_CARD_PART, MEMBER_CHOICE_FIELD, memberChoiceSchema, memberFor } from '../memberChoice';

export const ACTION_REMOVE_ROLE = 'action.removeRole';

export const removeRoleConfigSchema = z.object({
    roleId: z.string().min(1),
    member: memberChoiceSchema,
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
            description: 'The role to take back, from whoever you pick below.',
            control: 'rolePicker',
        },
        MEMBER_CHOICE_FIELD,
    ],
    cardSummary: [{ key: 'roleId', prefix: 'Remove ', emptyText: 'no role picked' }, MEMBER_CHOICE_CARD_PART],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    // The member choice says who it needs: the member, or whoever set this off.
    requires: [],
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
        await memberFor(context, config.member).roles.remove(role.role.id);
        return { kind: 'continue' };
    },
};
