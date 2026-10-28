import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { changeableRole } from '../../logic/roleSafety';
import { MEMBER_CHOICE_CARD_PART, MEMBER_CHOICE_FIELD, memberChoiceSchema, memberFor } from '../memberChoice';

export const ACTION_ASSIGN_ROLE = 'action.assignRole';

export const assignRoleConfigSchema = z.object({
    roleId: z.string().min(1),
    member: memberChoiceSchema,
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
            description: 'The role to hand out, to whoever you pick below.',
            control: 'rolePicker',
        },
        MEMBER_CHOICE_FIELD,
    ],
    cardSummary: [{ key: 'roleId', prefix: 'Assign ', emptyText: 'no role picked' }, MEMBER_CHOICE_CARD_PART],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    // The member choice says who it needs: the member, or whoever set this off.
    requires: [],
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
        await memberFor(context, config.member).roles.add(role.role.id);
        return { kind: 'continue' };
    },
};
