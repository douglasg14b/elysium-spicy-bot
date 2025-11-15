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
import { findCategory, findOrCreateModeratorCategory } from '../logic';
import { validateTicketCategoryPermissions } from '../utils';

const TICKET_CONFIG_MODAL_ID = 'ticket_config_modal';

const SUPPORT_CATEGORY_INPUT_ID = 'support_category_input';
const CLOSED_CATEGORY_INPUT_ID = 'closed_category_input';
const CLAIMED_CATEGORY_INPUT_ID = 'claimed_category_input';
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

        const claimedCategoryInput = new TextInputBuilder()
            .setCustomId(CLAIMED_CATEGORY_INPUT_ID)
            .setLabel('Claimed Ticket Category Name')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., Claimed Tickets')
            .setRequired(true)
            .setMaxLength(50);

        if (existingConfig?.claimedTicketCategoryName) {
            claimedCategoryInput.setValue(existingConfig.claimedTicketCategoryName);
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
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>({ components: [supportCategoryInput] }),
                new ActionRowBuilder<TextInputBuilder>({ components: [claimedCategoryInput] }),
                new ActionRowBuilder<TextInputBuilder>({ components: [closedCategoryInput] }),
                new ActionRowBuilder<TextInputBuilder>({ components: [channelTemplateInput] })
            )
            .addLabelComponents(moderationRolesLabel);

        return modal;
    }

    async function handler(interaction: ModalSubmitInteraction): Promise<InteractionHandlerResult> {
        if (!interaction.guild) {
            return { status: 'error', message: '❌ This command can only be used in a server.' };
        }
        const guild = interaction.guild;

        // Check if user has manage server permissions
        if (!interaction.memberPermissions?.has('ManageGuild')) {
            return {
                status: 'error',
                message: '❌ You need Manage Server permissions to configure the ticket system.',
            };
        }

        const supportCategoryName = interaction.fields.getTextInputValue(SUPPORT_CATEGORY_INPUT_ID);
        const claimedCategoryName = interaction.fields.getTextInputValue(CLAIMED_CATEGORY_INPUT_ID);
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
        const supportCategoryResult = await findOrCreateModeratorCategory({
            guild: interaction.guild,
            categoryName: supportCategoryName,
            moderationRoleIds: moderationRoles,
        });
        if (!supportCategoryResult.ok) {
            return {
                status: 'error',
                message: `❌ Failed to create support category "${supportCategoryName}". Please check permissions.`,
            };
        }
        const supportCategory = supportCategoryResult.value;

        const claimedCategoryResult = await findOrCreateModeratorCategory({
            guild: interaction.guild,
            categoryName: claimedCategoryName,
            moderationRoleIds: moderationRoles,
        });
        if (!claimedCategoryResult.ok) {
            return {
                status: 'error',
                message: `❌ Failed to create claimed category "${claimedCategoryName}". Please check permissions.`,
            };
        }
        const claimedCategory = claimedCategoryResult.value;

        const closedCategoryResult = await findOrCreateModeratorCategory({
            guild: interaction.guild,
            categoryName: closedCategoryName,
            moderationRoleIds: moderationRoles,
        });
        if (!closedCategoryResult.ok) {
            return {
                status: 'error',
                message: `❌ Failed to create closed category "${closedCategoryName}". Please check permissions.`,
            };
        }
        const closedCategory = closedCategoryResult.value;

        const supportCategoryPermsResult = validateTicketCategoryPermissions(guild, supportCategory);
        if (!supportCategoryPermsResult.valid) {
            return {
                status: 'error',
                message: `❌ Bot Missing Permissions For Category "${supportCategoryName}": ${supportCategoryPermsResult.missingPermissions.join(
                    ', '
                )}.`,
            };
        }

        const claimedCategoryPermsResult = validateTicketCategoryPermissions(guild, claimedCategory);
        if (!claimedCategoryPermsResult.valid) {
            return {
                status: 'error',
                message: `❌ Bot Missing Permissions For Category "${claimedCategoryName}": ${claimedCategoryPermsResult.missingPermissions.join(
                    ', '
                )}.`,
            };
        }

        const closedCategoryPermsResult = validateTicketCategoryPermissions(guild, closedCategory);
        if (!closedCategoryPermsResult.valid) {
            return {
                status: 'error',
                message: `❌ Bot Missing Permissions For Category "${closedCategoryName}": ${closedCategoryPermsResult.missingPermissions.join(
                    ', '
                )}.`,
            };
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
                claimedTicketCategoryName: claimedCategoryName,
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
                    `**Claimed Category:** ${claimedCategoryName}\n` +
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
