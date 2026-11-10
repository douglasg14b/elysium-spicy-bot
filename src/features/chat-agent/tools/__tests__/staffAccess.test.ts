import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { isStaffMember, staffHelpAccess } from '../staffAccess';

const STAFF_ROLE = '300000000000000001';
/** Four members, every one of them cached. */
const guild = { ownerId: 'owner', memberCount: 4, members: { cache: { size: 4 } } };

function member(id: string, options: { roles?: string[]; admin?: boolean; guild?: object } = {}): GuildMember {
    return {
        id,
        guild: options.guild ?? guild,
        permissions: { has: (flag: bigint) => flag === PermissionFlagsBits.Administrator && !!options.admin },
        roles: { cache: new Map((options.roles ?? []).map((roleId) => [roleId, { id: roleId }])) },
    } as unknown as GuildMember;
}

const mod = member('mod', { roles: [STAFF_ROLE] });
const owner = member('owner');
const admin = member('admin', { admin: true });
const vex = member('vex', { roles: ['300000000000000009'] });

describe('isStaffMember', () => {
    it("counts a staff role, the owner and an Administrator, and nobody else", () => {
        expect(isStaffMember(mod, [STAFF_ROLE])).toBe(true);
        expect(isStaffMember(owner, [])).toBe(true);
        expect(isStaffMember(admin, [])).toBe(true);
        expect(isStaffMember(vex, [STAFF_ROLE])).toBe(false);
        // With no staff roles set, a role-holder is not staff.
        expect(isStaffMember(mod, [])).toBe(false);
    });
});

describe('staffHelpAccess', () => {
    it('allows staff only where every reader is staff', () => {
        expect(staffHelpAccess([mod, owner, admin], [STAFF_ROLE])).toBe('allowed');
        expect(staffHelpAccess([mod], [STAFF_ROLE])).toBe('allowed');
    });

    it('refuses a member who is not staff, wherever they ask', () => {
        expect(staffHelpAccess([vex], [STAFF_ROLE])).toBe('askerNotStaff');
        expect(staffHelpAccess([vex, mod], [STAFF_ROLE])).toBe('askerNotStaff');
    });

    it('refuses staff asking where someone who is not staff can read', () => {
        expect(staffHelpAccess([mod, vex], [STAFF_ROLE])).toBe('readersNotStaff');
    });

    it("refuses staff while the server's member list is still loading, since an unseen member could be reading", () => {
        const loading = { ...guild, memberCount: 40 };
        expect(staffHelpAccess([member('mod', { roles: [STAFF_ROLE], guild: loading })], [STAFF_ROLE])).toBe('readersUnknown');
    });
});
