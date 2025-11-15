import { CategoryChannel, Guild, PermissionsBitField } from 'discord.js';
import { verifyCommandPermissions } from '../../../utils';
import { isTicketingConfigConfigured, TicketingConfig, TicketingConfigEntity } from '../data/ticketingSchema';

interface ValidatePermissionsResult {
    valid: boolean;
    missingPermissions: string[];
}

/**
 * Validates that the bot has all required permissions for the configured ticketing system
 * This will largely catch perm errors when the configured categories already exist
 */
export function validateTicketCategoryPermissions(guild: Guild, category: CategoryChannel): ValidatePermissionsResult {
    const botMember = guild.members.me;
    if (!botMember) {
        return { valid: false, missingPermissions: ['Bot not found in guild'] };
    }

    const canManageInParent = category.permissionsFor(botMember)?.has(PermissionsBitField.Flags.ManageChannels);
    const canSeeParent = category.permissionsFor(botMember)?.has(PermissionsBitField.Flags.ViewChannel);

    const missingPermissions: string[] = [];
    if (!canManageInParent) {
        missingPermissions.push(`Manage Channels permission in category "${category.name}"`);
    }
    if (!canSeeParent) {
        missingPermissions.push(`View Channel permission in category "${category.name}"`);
    }

    return {
        valid: missingPermissions.length === 0,
        missingPermissions,
    };
}
