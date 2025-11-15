import { Guild, PermissionsBitField } from 'discord.js';
import { verifyCommandPermissions } from '../../../utils';

interface ValidateBotPermissionsResult {
    valid: boolean;
    missingPermissions: string[];
}

/**
 * Validates that the bot has all required permissions for the ticketing system
 */
export function validateTicketingPermissions(guild: Guild): ValidateBotPermissionsResult {
    const botMember = guild.members.me;
    if (!botMember) {
        return { valid: false, missingPermissions: ['Bot not found in guild'] };
    }

    const requiredPermissions = [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageRoles, // For permission overwrites
    ];

    const missingPermissions = verifyCommandPermissions(botMember.permissions, requiredPermissions);

    return {
        valid: missingPermissions.length === 0,
        missingPermissions,
    };
}
