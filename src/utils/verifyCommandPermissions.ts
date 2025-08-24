import { PermissionsBitField } from 'discord.js';
import { stringToTitleCase } from './stringToTitleCase';

// general function to handle verifying perms for any command
export function verifyCommandPermissions(
    channelPerms: Readonly<PermissionsBitField>,
    requiredPerms: bigint[]
): string[] {
    const missingPermissions = requiredPerms.filter((perm) => !channelPerms.has(perm));

    const missingPermsNames: string[] = [];

    Object.entries(PermissionsBitField.Flags).forEach(([key, value]) => {
        if (missingPermissions.includes(value)) {
            // Convert camelCase or PascalCase to Title Case with spaces
            const titleCase = stringToTitleCase(key);
            missingPermsNames.push(titleCase);
        }
    });

    return missingPermsNames;
}
