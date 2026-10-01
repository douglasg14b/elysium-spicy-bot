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
import { defaultTicketTypes } from '../data/defaultTicketTypes';
import { validateTicketingPermissions } from '../utils';
import { TicketingConfig } from '../data/ticketingSchema';

export function DeployTicketCommand() {}

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
    const permissionCheck = validateTicketingPermissions(interaction.guild);
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

        // Write only the deployment members, onto the row as it is *now*. The read above
        // happened before two Discord calls; writing back what it saw would undo any
        // dashboard save or category recreate that landed in between, and category
        // bindings cannot be re-derived once lost.
        const deployed = await ticketingRepo.mutateConfig(interaction.guild.id, (row) => ({
            ...row.config,
            modTicketsDeployed: true,
            modTicketsDeployedChannelId: targetChannel.id,
            modTicketsDeployedMessageId: deployedMessage.id,
            // Seeded here too, not only for a new row: a row can exist without types
            // (written by a process older than the migration, or created after the
            // migration's `UPDATE` had already run), and a guild in that state has a
            // panel whose buttons would refuse.
            ticketTypes: row.config.ticketTypes ?? defaultTicketTypes(),
        }));

        if (!deployed) {
            // First-time deployment. This is one of the two paths that create a
            // `ticketing_config` row, so it seeds the types — the migration is an
            // `UPDATE` and never reaches a guild that had no row.
            const newConfig: TicketingConfig = {
                modTicketsDeployed: true,
                modTicketsDeployedChannelId: targetChannel.id,
                modTicketsDeployedMessageId: deployedMessage.id,
                categories: { open: null, claimed: null, closed: null },
                moderationRoles: [],
                ticketTypes: defaultTicketTypes(),
            };
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
                // Was `/tickets config`, a command that was never registered.
                // The ⚙️ Configure button on the panel is the entry point.
                `• Press **⚙️ Configure** on the posted message to pick moderation roles\n` +
                `• Choose the three ticket categories on the dashboard's ticket settings page — pick existing ones or name new ones\n` +
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
