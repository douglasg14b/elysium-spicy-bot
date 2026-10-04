import { ModalBuilder, ModalSubmitInteraction, RoleSelectMenuBuilder, LabelBuilder } from 'discord.js';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { ticketingRepo } from '../data/ticketingRepo';
import { TicketingConfig } from '../data/ticketingSchema';
import { updateDeployedTicketMessage } from '../utils/updateDeployedMessage';
import { defaultTicketTypes } from '../data/defaultTicketTypes';

const TICKET_CONFIG_MODAL_ID = 'ticket_config_modal';

const MODERATION_ROLES_INPUT_ID = 'moderation_roles_input';

/**
 * The Discord-side ticket setup: moderation roles only.
 *
 * It used to take three category **names** too, and find-or-create a category for each
 * by matching `channel.name` — issue #22. Categories are now chosen on the dashboard,
 * where an operator can pick an existing one by id or name a new one for the bot to make,
 * and that is the only place they are chosen. A Discord modal has no category picker
 * that could carry an id, so keeping name fields here would mean keeping name matching.
 */
export function TicketConfigModalComponent() {
    function buildComponent(existingConfig?: TicketingConfig) {
        const moderationRolesLabel = new LabelBuilder().setLabel('Moderation Roles').setRoleSelectMenuComponent(
            new RoleSelectMenuBuilder()
                .setCustomId(MODERATION_ROLES_INPUT_ID)
                .setMaxValues(10)
                .setMinValues(1)
                .addDefaultRoles(existingConfig?.moderationRoles || [])
                .setPlaceholder('Select moderation roles')
        );

        return new ModalBuilder()
            .setCustomId(TICKET_CONFIG_MODAL_ID)
            .setTitle('Configure Ticket System')
            .addLabelComponents(moderationRolesLabel);
    }

    async function handler(interaction: ModalSubmitInteraction): Promise<InteractionHandlerResult> {
        if (!interaction.guild) {
            return { status: 'error', message: '❌ This command can only be used in a server.' };
        }

        // Check if user has manage server permissions
        if (!interaction.memberPermissions?.has('ManageGuild')) {
            return {
                status: 'error',
                message: '❌ You need Manage Server permissions to configure the ticket system.',
            };
        }

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

        try {
            // Three layers, and the order is the whole point.
            //
            // 1. Defaults, which only apply when no row exists — deployment state belongs
            //    to `/deploy-ticket-system`, and categories to the dashboard, so a config
            //    written before either says "not deployed" and "nothing chosen" rather
            //    than guessing.
            // 2. ⚠️ **The spread**, which is load-bearing. This was a complete object
            //    literal with no spread, so it silently dropped every config member it
            //    did not list — which made it a destructor the moment `ticketTypes`
            //    joined the shape. Anything added to `TicketingConfig` later survives a
            //    save here only because of this line, `categories` included.
            // 3. The one member this modal actually owns, plus the type seed.
            //
            // Through `mutateConfig`, so the spread is of the row as it is *now*: a
            // separate read then write would put back category bindings that a dashboard
            // save or a recreate wrote in between, and those ids cannot be re-derived.
            const withRoles = (current: TicketingConfig | undefined): TicketingConfig => ({
                modTicketsDeployed: false,
                modTicketsDeployedChannelId: null,
                modTicketsDeployedMessageId: null,
                categories: { open: null, claimed: null, closed: null },

                ...current,

                moderationRoles,
                // Every path creating a `ticketing_config` row seeds the types, because
                // the migration is an `UPDATE` and never reaches a guild that had no row.
                // On the update path the spread has already supplied them; this only
                // fills the gap for a guild configuring before it ever deployed.
                ticketTypes: current?.ticketTypes ?? defaultTicketTypes(),
            });

            let newConfig = await ticketingRepo.mutateConfig(interaction.guild.id, (row) => withRoles(row.config));
            if (!newConfig) {
                newConfig = withRoles(undefined);
                await ticketingRepo.upsert({
                    guildId: interaction.guild.id,
                    config: JSON.stringify(newConfig),
                    ticketNumberInc: 0,
                    entityVersion: 1,
                });
            }

            // Refresh the deployed panel, which renders the categories and the type
            // count. Non-fatally: the config is already saved by this point, so letting
            // a failed panel edit report "Failed to save" would send the operator back to
            // re-save something that persisted.
            await updateDeployedTicketMessage(interaction.guild).catch((error: unknown) => {
                console.error('Ticket config saved, but the deployed panel could not be refreshed:', error);
            });

            await interaction.reply({
                content:
                    `✅ Moderation roles saved — ${moderationRoles.length} role(s) can work tickets now.\n\n` +
                    `**Ticket Types:** ${Object.keys(newConfig.ticketTypes ?? {}).length} declared\n` +
                    `Categories are chosen on the dashboard's ticket settings page: pick ones you have, or name new ones and the bot makes them.`,
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
