import {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalSubmitInteraction,
    RoleSelectMenuBuilder,
    LabelBuilder,
} from 'discord.js';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { ticketingRepo } from '../data/ticketingRepo';
import { TicketingConfig } from '../data/ticketingSchema';
import { updateDeployedTicketMessage } from '../utils/updateDeployedMessage';
import { defaultTicketTypes } from '../data/defaultTicketTypes';
// Direct path rather than the `../logic` barrel: that barrel now re-exports
// `setTicketTypes`, which pulls the repo and the database handle in behind it. This
// handler needs one category helper, not the whole domain layer.
import { findOrCreateModeratorCategory } from '../logic/ticketChannelPermissions';
import { validateTicketCategoryPermissions } from '../utils';

const TICKET_CONFIG_MODAL_ID = 'ticket_config_modal';

const SUPPORT_CATEGORY_INPUT_ID = 'support_category_input';
const CLOSED_CATEGORY_INPUT_ID = 'closed_category_input';
const CLAIMED_CATEGORY_INPUT_ID = 'claimed_category_input';
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
                new ActionRowBuilder<TextInputBuilder>({ components: [closedCategoryInput] })
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

            // Three layers, and the order is the whole point.
            //
            // 1. Deployment defaults, which only apply when no row exists — deployment
            //    state belongs to `/deploy-ticket-system`, so a config written before any
            //    deploy says "not deployed" rather than guessing.
            // 2. ⚠️ **The spread**, which is load-bearing. This was a complete object
            //    literal with no spread, so it silently dropped every config member it
            //    did not list — which made it a destructor the moment `ticketTypes`
            //    joined the shape. Anything added to `TicketingConfig` later survives a
            //    save here only because of this line.
            // 3. The four members this modal actually owns, plus the type seed.
            const newConfig: TicketingConfig = {
                modTicketsDeployed: false,
                modTicketsDeployedChannelId: null,
                modTicketsDeployedMessageId: null,

                ...existingConfig?.config,

                supportTicketCategoryName: supportCategoryName,
                claimedTicketCategoryName: claimedCategoryName,
                closedTicketCategoryName: closedCategoryName,
                moderationRoles,
                // Every path creating a `ticketing_config` row seeds the types, because
                // the migration is an `UPDATE` and never reaches a guild that had no row.
                // On the update path the spread has already supplied them; this only
                // fills the gap for a guild configuring before it ever deployed.
                ticketTypes: existingConfig?.config?.ticketTypes ?? defaultTicketTypes(),
            };

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

            // Refresh the deployed panel, which renders the categories and the type
            // count. Once, not once per arm — and non-fatally: the config is already
            // saved by this point, so letting a failed panel edit report "Failed to
            // save" would send the operator back to re-save something that persisted.
            await updateDeployedTicketMessage(interaction.guild.id).catch((error: unknown) => {
                console.error('Ticket config saved, but the deployed panel could not be refreshed:', error);
            });

            await interaction.reply({
                content:
                    `✅ Ticket system configuration updated successfully!\n\n` +
                    `**Support Category:** ${supportCategoryName}\n` +
                    `**Claimed Category:** ${claimedCategoryName}\n` +
                    `**Closed Category:** ${closedCategoryName}\n` +
                    `**Ticket Types:** ${Object.keys(newConfig.ticketTypes ?? {}).length} declared\n` +
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
