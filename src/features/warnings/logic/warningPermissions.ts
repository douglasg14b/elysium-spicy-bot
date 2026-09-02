import { PermissionsBitField } from 'discord.js';

export function memberHasModerateMembers(
    permissions: Readonly<PermissionsBitField> | null | undefined
): boolean {
    return permissions?.has(PermissionsBitField.Flags.ModerateMembers) ?? false;
}
