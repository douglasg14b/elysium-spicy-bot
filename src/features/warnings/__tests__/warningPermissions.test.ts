import { PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { memberHasModerateMembers } from '../logic/warningPermissions';

describe('memberHasModerateMembers', () => {
    it('requires the Moderate Members flag', () => {
        expect(memberHasModerateMembers(new PermissionsBitField(PermissionsBitField.Flags.ModerateMembers))).toBe(
            true
        );
        expect(memberHasModerateMembers(new PermissionsBitField(PermissionsBitField.Flags.ManageGuild))).toBe(
            false
        );
        expect(memberHasModerateMembers(null)).toBe(false);
    });
});
