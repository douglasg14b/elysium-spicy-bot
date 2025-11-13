import {
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    PermissionsBitField,
    TextChannel,
    ChannelType,
    Guild,
} from 'discord.js';
import { commandSuccess, commandError } from '../../../features-system/commands';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { CreateModTicketChannelEmbedComponent } from '../components';
import { ticketingRepo } from '../data/ticketingRepo';
import { SUPPORT_TICKET_NAME_TEMPLATE } from '../constants';
import { verifyCommandPermissions } from '../../../utils';

export function DeployTicketCommand() {}

/**
 * Validates that the bot has all required permissions for the ticketing system
 */
function validateBotPermissions(guild: Guild): { valid: boolean; missingPermissions: string[] } {
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

export const deployTicketSystemCommand = new SlashCommandBuilder()
    .setName('deploy-ticket-system')
    .setDescription('Deploy the mod ticket system to a channel')
    .addChannelOption((option) =>
        option
            .setName('channel')
            .setDescription('Channel to deploy the ticket system to')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild);

export async function handleDeployTicketSystem(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.guild) {
        await interaction.reply({
            content: '❌ This command can only be used in a server.',
            ephemeral: true,
        });
        return commandError('Not in guild');
    }

    // Check if user has manage server permissions
    if (!interaction.memberPermissions?.has('ManageGuild')) {
        await interaction.reply({
            content: '❌ You need Manage Server permissions to deploy the ticket system.',
            ephemeral: true,
        });
        return commandError('Insufficient permissions');
    }

    // Validate bot permissions
    const permissionCheck = validateBotPermissions(interaction.guild);
    if (!permissionCheck.valid) {
        await interaction.reply({
            content:
                `❌ **Bot Missing Permissions**\n\n` +
                `The bot needs these permissions to operate the ticketing system:\n` +
                `• ${permissionCheck.missingPermissions.join('\n• ')}\n\n` +
                `Please ensure the bot role has these permissions in the server settings.`,
            ephemeral: true,
        });
        return commandError('Bot missing permissions');
    }

    // Get target channel (use current channel if not specified)
    const targetChannel =
        (interaction.options.getChannel('channel') as TextChannel) || (interaction.channel as TextChannel);

    if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
        await interaction.reply({
            content: '❌ Please specify a valid text channel or use this command in a text channel.',
            ephemeral: true,
        });
        return commandError('Invalid channel');
    }

    try {
        // Get existing configuration
        const existingConfig = await ticketingRepo.get(interaction.guild.id);

        // Handle existing deployed message - try to delete it if it exists
        if (
            existingConfig?.config?.modTicketsDeployedMessageId &&
            existingConfig?.config?.modTicketsDeployedChannelId
        ) {
            try {
                const oldChannel = interaction.guild.channels.cache.get(
                    existingConfig.config.modTicketsDeployedChannelId
                ) as TextChannel;
                if (oldChannel) {
                    const oldMessage = await oldChannel.messages.fetch(
                        existingConfig.config.modTicketsDeployedMessageId
                    );
                    if (oldMessage) {
                        await oldMessage.delete();
                    }
                }
            } catch (error) {
                // Message might have been already deleted or channel doesn't exist - continue silently
                console.log('Previous deployed message not found or already deleted:', error);
            }
        }

        // Create embed with current config
        const embedComponent = CreateModTicketChannelEmbedComponent(existingConfig || undefined);
        const messageData = embedComponent.messageEmbed;

        // Deploy the message
        const deployedMessage = await targetChannel.send(messageData);

        // Update or create config with new deployment info
        let newConfig;
        if (existingConfig?.config) {
            // Update existing config - preserve all settings but update deployment details
            newConfig = {
                ...existingConfig.config,
                modTicketsDeployed: true,
                modTicketsDeployedChannelId: targetChannel.id,
                modTicketsDeployedMessageId: deployedMessage.id,
                ticketChannelNameTemplate: SUPPORT_TICKET_NAME_TEMPLATE,
            };
        } else {
            // Create minimal config for first-time deployment
            newConfig = {
                modTicketsDeployed: true,
                modTicketsDeployedChannelId: targetChannel.id,
                modTicketsDeployedMessageId: deployedMessage.id,
                userTicketsDeployed: false,
                userTicketsDeployedChannelId: null,
                userTicketsDeployedMessageId: null,
                supportTicketCategoryName: '',
                closedTicketCategoryName: '',
                ticketChannelNameTemplate: SUPPORT_TICKET_NAME_TEMPLATE,
                moderationRoles: [],
            };
        }

        if (existingConfig) {
            await ticketingRepo.update({
                guildId: interaction.guild.id,
                config: JSON.stringify(newConfig),
            });
        } else {
            await ticketingRepo.upsert({
                guildId: interaction.guild.id,
                config: JSON.stringify(newConfig),
                ticketNumberInc: 0,
                entityVersion: 1,
            });
        }

        await interaction.reply({
            content:
                `✅ Ticket system ${
                    existingConfig ? 're-deployed' : 'deployed'
                } successfully in ${targetChannel}!\n\n` +
                `📝 **Next Steps:**\n` +
                `• Use \`/tickets config\` to configure the system\n` +
                `• Set up categories and moderation roles\n` +
                `• The deployed message will update automatically when configured`,
            ephemeral: true,
        });

        return commandSuccess(`Ticket system ${existingConfig ? 're-deployed' : 'deployed'}`);
    } catch (error) {
        console.error('Error deploying ticket system:', error);
        await interaction.reply({
            content: '❌ Failed to deploy ticket system. Please check bot permissions.',
            ephemeral: true,
        });
        return commandError('Failed to deploy');
    }
}
