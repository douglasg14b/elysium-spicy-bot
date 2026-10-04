import {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalSubmitInteraction,
    TextChannel,
    UserSelectMenuBuilder,
    LabelBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    DiscordjsErrorCodes,
    DiscordjsTypeError,
} from 'discord.js';
import { DISCORD_CLIENT } from '../../../discordClient';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { ticketingRepo } from '../data/ticketingRepo';
import {
    isTicketingConfigConfigured,
    TICKET_TYPE_LABEL_MAX_LENGTH,
    type TicketTypeDefinition,
} from '../data/ticketingSchema';
import { attachTicketChannel, openTicket, recordTicketStateMessage } from '../ticketService';
import { createTicketChannelForTicket } from '../logic/ticketChannelOps';
import { buildTicketButtons, buildTicketEmbed } from '../logic/ticketPresentation';
import { getTicketTypeDefinition } from '../logic/ticketTypes';
import { resolveTicketIdentity } from '../logic/resolveTicketIdentity';
import { TICKETING_NOT_CONFIGURED_MESSAGE, ticketErrorMessage } from '../logic/ticketErrorMessage';

const MOD_TICKET_MODAL_ID = 'mod_ticket_create_modal';

const TYPE_INPUT_ID = 'mod_ticket_type_input';
const USER_INPUT_ID = 'mod_ticket_user_input';
const TITLE_INPUT_ID = 'mod_ticket_title_input';
const REASON_INPUT_ID = 'mod_ticket_reason_input';

/** Discord refuses a string select with more options than this. */
const SELECT_OPTION_LIMIT = 25;

/**
 * **A bridge, to be removed.** Saving a type now refuses a label over
 * `TICKET_TYPE_LABEL_MAX_LENGTH` (45 — the builders' limit for an option in a modal's
 * labelled select), but rows saved before that limit existed can still hold a longer one,
 * and one of those would make `showModal` throw for the whole guild. This cut keeps the
 * picker working for them; once no stored label exceeds the limit it can go. The value
 * is the key, so the cut label never decides which type is opened.
 *
 * Cut in UTF-16 units, as the validator counts, without leaving half an emoji behind.
 */
function optionLabel(label: string): string {
    if (label.length <= TICKET_TYPE_LABEL_MAX_LENGTH) {
        return label;
    }
    return `${label.slice(0, TICKET_TYPE_LABEL_MAX_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/**
 * The type picker, offering the guild's declared types in the order given — callers
 * pass `listTicketTypes(config)`, the order every surface lists them in.
 *
 * Past Discord's 25 the rest are named in a warning, and the placeholder tells the
 * moderator the list is short, rather than dropping them quietly.
 */
function buildTypeSelect(ticketTypes: readonly TicketTypeDefinition[]): StringSelectMenuBuilder {
    const offered = ticketTypes.slice(0, SELECT_OPTION_LIMIT);
    const omitted = ticketTypes.slice(SELECT_OPTION_LIMIT);
    if (omitted.length > 0) {
        console.warn(
            `Mod ticket modal: ${ticketTypes.length} ticket types declared but Discord shows only ` +
                `${SELECT_OPTION_LIMIT}; not offered: ${omitted.map((definition) => definition.type).join(', ')}`
        );
    }

    return new StringSelectMenuBuilder()
        .setCustomId(TYPE_INPUT_ID)
        .setRequired(true)
        .setMinValues(1)
        .setMaxValues(1)
        .setPlaceholder(
            omitted.length > 0
                ? `Pick a ticket type (${offered.length} of ${ticketTypes.length} shown, Discord's cap)`
                : 'Pick a ticket type'
        )
        .addOptions(
            offered.map((definition) =>
                new StringSelectMenuOptionBuilder()
                    .setValue(definition.type)
                    .setLabel(optionLabel(definition.label))
                    .setDefault(offered.length === 1)
            )
        );
}

export function CreateModTicketModalComponent() {
    /**
     * Built per guild at show time, because the type options are the guild's own.
     * The registry reads only the `custom_id`, so registration passes no types.
     */
    function buildComponent(ticketTypes: readonly TicketTypeDefinition[]): ModalBuilder {
        const typeLabel = new LabelBuilder()
            .setLabel('Type')
            .setStringSelectMenuComponent(buildTypeSelect(ticketTypes));

        const userLabel = new LabelBuilder()
            .setLabel('User')
            .setUserSelectMenuComponent(
                new UserSelectMenuBuilder().setCustomId(USER_INPUT_ID).setMaxValues(1).setPlaceholder('Select a user')
            );

        const titleInput = new TextInputBuilder()
            .setCustomId(TITLE_INPUT_ID)
            .setLabel('Ticket Title')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Brief description of the issue')
            .setRequired(true)
            .setMaxLength(100);

        const reasonInput = new TextInputBuilder()
            .setCustomId(REASON_INPUT_ID)
            .setLabel('Reason/Details (Optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Additional context or details about this ticket')
            .setRequired(false)
            .setMaxLength(1000);

        const modal = new ModalBuilder()
            .setCustomId(MOD_TICKET_MODAL_ID)
            .setTitle('Create Mod Ticket')
            .addLabelComponents(typeLabel, userLabel)
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>({ components: [titleInput] }),
                new ActionRowBuilder<TextInputBuilder>({ components: [reasonInput] })
            );

        return modal;
    }

    async function handler(interaction: ModalSubmitInteraction): Promise<InteractionHandlerResult> {
        // Required, so a current form always carries exactly one value. A form opened
        // before the picker shipped has no such field, and discord.js throws for that.
        let pickedType: string;
        try {
            pickedType = interaction.fields.getStringSelectValues(TYPE_INPUT_ID)[0];
        } catch (error) {
            if (
                error instanceof DiscordjsTypeError &&
                error.code === DiscordjsErrorCodes.ModalSubmitInteractionFieldNotFound
            ) {
                return {
                    status: 'error',
                    message:
                        "❌ This form is out of date — it's older than the bot's last update. Open the panel again.",
                };
            }
            throw error;
        }
        const userInput = interaction.fields.getSelectedUsers(USER_INPUT_ID);
        const title = interaction.fields.getTextInputValue(TITLE_INPUT_ID);
        const reason = interaction.fields.getTextInputValue(REASON_INPUT_ID) || 'No additional details provided';
        const userId = userInput?.first()?.id;

        if (!userId) {
            return { status: 'error', message: '❌ You must select a user for the ticket.' };
        }

        if (!interaction.guild) {
            return { status: 'error', message: '❌ This command can only be used in a server.' };
        }

        // Try to get the user
        let targetUser;
        try {
            targetUser = await DISCORD_CLIENT.users.fetch(userId);
        } catch (error) {
            return {
                status: 'error',
                message: '❌ Could not find a user with that ID. Please check the user ID and try again.',
            };
        }

        const configEntity = await ticketingRepo.get(interaction.guild.id);
        if (!isTicketingConfigConfigured(configEntity)) {
            return {
                status: 'error',
                message: TICKETING_NOT_CONFIGURED_MESSAGE,
            };
        }
        const ticketsConfig = configEntity.config;

        // Resolved before anything is written. The type was offered when the modal
        // opened, but it can be deleted while the moderator is typing, so the guild
        // that lost it gets told which one rather than a half-made ticket.
        const definition = getTicketTypeDefinition(ticketsConfig, pickedType);
        if (!definition) {
            return {
                status: 'error',
                message:
                    `❌ The \`${pickedType}\` ticket type got deleted while you were busy typing. ` +
                    'Open the panel again and pick one that still exists.',
            };
        }

        try {
            // The same path a flow takes, differing only in having a human
            // opener. Previously this handler had its own creation path: it
            // incremented the counter in memory, created the channel, and then
            // wrote the counter back *absolutely* — so it not only raced itself
            // across a Discord round trip, it would overwrite an atomic
            // increment made by any other opener in the meantime.
            // Two identity snapshots, each one member fetch. A real Discord call on
            // a path whose design goal was to stay off Discord — accepted because it
            // is paid once at open rather than once per render, which is the trade
            // the snapshot columns exist to make. The username comes from the `User`
            // already fetched above, so only the nickname depends on the fetch, and a
            // subject who has left the guild still records a name.
            const [subjectIdentity, openerIdentity] = await Promise.all([
                resolveTicketIdentity(interaction.guild, targetUser),
                resolveTicketIdentity(interaction.guild, interaction.user),
            ]);

            const ticketResult = await openTicket({
                guildId: interaction.guild.id,
                type: pickedType,
                definition,
                subjectId: targetUser.id,
                openerId: interaction.user.id,
                title,
                reason,
                subjectIdentity,
                openerIdentity,
            });
            if (!ticketResult.ok) {
                return {
                    status: 'error',
                    message: `❌ Failed to create ticket: ${ticketErrorMessage(ticketResult.error)}`,
                };
            }
            const ticket = ticketResult.value;

            const ticketChannelResult = await createTicketChannelForTicket({
                guild: interaction.guild,
                ticket,
                config: ticketsConfig,
                subjectName: targetUser.username,
                openerName: interaction.user.username,
            });
            if (!ticketChannelResult.ok) {
                return {
                    status: 'error',
                    message: `❌ Failed to create ticket: ${ticketErrorMessage(ticketChannelResult.error)}`,
                };
            }
            const ticketChannel = ticketChannelResult.value;

            const attached = await attachTicketChannel(ticket.id, ticketChannel.id);
            if (!attached.ok) {
                return {
                    status: 'error',
                    message: `❌ Failed to create ticket: ${ticketErrorMessage(attached.error)}`,
                };
            }

            const initialMessage = await ticketChannel.send({
                content: `${targetUser} - A moderation ticket has been created for you.`,
                embeds: [buildTicketEmbed(attached.value, definition)],
                components: buildTicketButtons(attached.value),
                allowedMentions: { parse: ['users'] },
            });

            // Recorded so a caller with no interaction can re-render this embed, and
            // recording it is what announces the ticket as opened — by the moderator
            // filing it, now that its embed exists. A failure here is not fatal to the
            // ticket — the row is the ticket and its own buttons still work — but it is
            // loud, because silence would leave a column that looks like it is never
            // written, and no flow listening for "opened" will hear this one.
            const stateMessage = await recordTicketStateMessage(attached.value.id, initialMessage.id, {
                actorId: interaction.user.id,
                chainDepth: 0,
            });
            if (!stateMessage.ok) {
                console.error('Failed to record ticket state message id:', stateMessage.error);
            }

            // Pinning is a convenience now rather than load-bearing: the row is
            // the ticket, so an unpinned message costs nothing but scrollback.
            await initialMessage.pin().catch(() => undefined);

            await interaction.reply({
                content: `✅ Ticket created successfully! ${ticketChannel}`,
                ephemeral: true,
            });

            return { status: 'success' };
        } catch (error) {
            console.error('Error creating ticket:', error);
            return {
                status: 'error',
                message: '❌ Failed to create ticket. Please try again or contact an administrator.',
            };
        }
    }

    return {
        handler,
        component: buildComponent,
        interactionId: MOD_TICKET_MODAL_ID,
    };
}
