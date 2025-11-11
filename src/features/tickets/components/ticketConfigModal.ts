import {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalSubmitInteraction,
    ChannelType,
    RoleSelectMenuBuilder,
    LabelBuilder,
} from 'discord.js';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { ticketingRepo } from '../data/ticketingRepo';
import { TicketingConfig } from '../data/ticketingSchema';
import { updateDeployedTicketMessage } from '../utils/updateDeployedMessage';
import { SUPPORT_TICKET_NAME_TEMPLATE } from '../constants';

const TICKET_CONFIG_MODAL_ID = 'ticket_config_modal';

const SUPPORT_CATEGORY_INPUT_ID = 'support_category_input';
const CLOSED_CATEGORY_INPUT_ID = 'closed_category_input';
const CHANNEL_TEMPLATE_INPUT_ID = 'channel_template_input';
const MODERATION_ROLES_INPUT_ID = 'moderation_roles_input';

export function TicketConfigModalComponent() {
    function buildComponent(existingConfig?: TicketingConfig) {
        const supportCategoryInput = new TextInputBuilder()
            .setCustomId(SUPPORT_CATEGORY_INPUT_ID)
            .setLabel('Support Ticket Category Name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., Support Tickets')
            .setRequired(true)
            .setMaxLength(50);

        if (existingConfig?.supportTicketCategoryName) {
            supportCategoryInput.setValue(existingConfig.supportTicketCategoryName);
        }

        const closedCategoryInput = new TextInputBuilder()
            .setCustomId(CLOSED_CATEGORY_INPUT_ID)
            .setLabel('Closed Ticket Category Name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., Closed Tickets')
            .setRequired(true)
            .setMaxLength(50);

        if (existingConfig?.closedTicketCategoryName) {
            closedCategoryInput.setValue(existingConfig.closedTicketCategoryName);
        }

        const channelTemplateInput = new TextInputBuilder()
            .setCustomId(CHANNEL_TEMPLATE_INPUT_ID)
            .setLabel('Channel Name Template (Read-only)')
            .setStyle(TextInputStyle.Short)
            .setValue(existingConfig?.ticketChannelNameTemplate || SUPPORT_TICKET_NAME_TEMPLATE)
            .setRequired(false)
            .setMaxLength(100);

        const moderationRolesLabel = new LabelBuilder().setLabel('Moderation Roles').setRoleSelectMenuComponent(
            new RoleSelectMenuBuilder()
                .setCustomId(MODERATION_ROLES_INPUT_ID)
                .setMaxValues(10)
                .setMinValues(1)
                .addDefaultRoles(existingConfig?.moderationRoles || [])
                .setPlaceholder('Select moderation roles')
        );

        const modal = new ModalBuilder()
            .setCustomId(TICKET_CONFIG_MODAL_ID)
            .setTitle('Configure Ticket System')
            .addLabelComponents(moderationRolesLabel)
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>({ components: [supportCategoryInput] }),
                new ActionRowBuilder<TextInputBuilder>({ components: [closedCategoryInput] }),
                new ActionRowBuilder<TextInputBuilder>({ components: [channelTemplateInput] })
            );

        return modal;
    }

    async function handler(interaction: ModalSubmitInteraction): Promise<InteractionHandlerResult> {
        if (!interaction.guild) {
            return { status: 'error', message: '❌ This command can only be used in a server.' };
        }

        // Check if user has administrator permissions
        if (!interaction.memberPermissions?.has('Administrator')) {
            return {
                status: 'error',
                message: '❌ You need Administrator permissions to configure the ticket system.',
            };
        }

        const supportCategoryName = interaction.fields.getTextInputValue(SUPPORT_CATEGORY_INPUT_ID);
        const closedCategoryName = interaction.fields.getTextInputValue(CLOSED_CATEGORY_INPUT_ID);
        const channelTemplate = interaction.fields.getTextInputValue(CHANNEL_TEMPLATE_INPUT_ID);
        const selectedRoles = interaction.fields.getSelectedRoles(MODERATION_ROLES_INPUT_ID);

        // Convert selected roles to IDs
        const moderationRoles = selectedRoles
            ? Array.from(selectedRoles.values())
                  .map((role) => role?.id)
                  .filter((id): id is string => Boolean(id))
            : [];

        if (moderationRoles.length === 0) {
            return {
                status: 'error',
                message: '❌ You must select at least one moderation role.',
            };
        }

        // Validate category names (check if they exist or can be created)
        const supportCategory = interaction.guild.channels.cache.find(
            (channel) => channel.type === ChannelType.GuildCategory && channel.name === supportCategoryName
        );

        const closedCategory = interaction.guild.channels.cache.find(
            (channel) => channel.type === ChannelType.GuildCategory && channel.name === closedCategoryName
        );

        if (!supportCategory) {
            try {
                await interaction.guild.channels.create({
                    name: supportCategoryName,
                    type: ChannelType.GuildCategory,
                    reason: 'Created by ticket system configuration',
                });
            } catch (error) {
                return {
                    status: 'error',
                    message: `❌ Failed to create support category "${supportCategoryName}". Please check permissions.`,
                };
            }
        }

        if (!closedCategory) {
            try {
                await interaction.guild.channels.create({
                    name: closedCategoryName,
                    type: ChannelType.GuildCategory,
                    reason: 'Created by ticket system configuration',
                });
            } catch (error) {
                return {
                    status: 'error',
                    message: `❌ Failed to create closed category "${closedCategoryName}". Please check permissions.`,
                };
            }
        }

        try {
            // Get existing config or create new one
            const existingConfig = await ticketingRepo.get(interaction.guild.id);

            const newConfig: TicketingConfig = {
                modTicketsDeployed: existingConfig?.config?.modTicketsDeployed || false,
                modTicketsDeployedChannelId: existingConfig?.config?.modTicketsDeployedChannelId || null,
                modTicketsDeployedMessageId: existingConfig?.config?.modTicketsDeployedMessageId || null,
                userTicketsDeployed: existingConfig?.config?.userTicketsDeployed || false,
                userTicketsDeployedChannelId: existingConfig?.config?.userTicketsDeployedChannelId || null,
                userTicketsDeployedMessageId: existingConfig?.config?.userTicketsDeployedMessageId || null,
                supportTicketCategoryName: supportCategoryName,
                closedTicketCategoryName: closedCategoryName,
                ticketChannelNameTemplate: SUPPORT_TICKET_NAME_TEMPLATE, // Non-configurable
                moderationRoles,
            };

            if (existingConfig) {
                await ticketingRepo.update({
                    guildId: interaction.guild.id,
                    config: JSON.stringify(newConfig),
                });

                // Update deployed message if it exists
                await updateDeployedTicketMessage(interaction.guild.id);
            } else {
                await ticketingRepo.upsert({
                    guildId: interaction.guild.id,
                    config: JSON.stringify(newConfig),
                    ticketNumberInc: 0,
                    entityVersion: 1,
                });
            }

            // Update deployed message if it exists
            await updateDeployedTicketMessage(interaction.guild.id);

            await interaction.reply({
                content:
                    `✅ Ticket system configuration updated successfully!\n\n` +
                    `**Support Category:** ${supportCategoryName}\n` +
                    `**Closed Category:** ${closedCategoryName}\n` +
                    `**Channel Template:** ${channelTemplate}\n` +
                    `**Moderation Roles:** ${moderationRoles.length} role(s) configured`,
                ephemeral: true,
            });

            return { status: 'success' };
        } catch (error) {
            console.error('Error updating ticket configuration:', error);
            return {
                status: 'error',
                message: '❌ Failed to save ticket configuration. Please try again or contact an administrator.',
            };
        }
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_CONFIG_MODAL_ID,
    };
}
