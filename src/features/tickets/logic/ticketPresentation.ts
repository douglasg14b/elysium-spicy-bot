import { ActionRowBuilder, ButtonBuilder, EmbedBuilder } from 'discord.js';
import type { TicketEntity } from '../data/ticketsSchema';
import {
    TicketClaimButtonComponent,
    TicketCloseButtonComponent,
    TicketDeleteButtonComponent,
    TicketReopenButtonComponent,
    TicketUnclaimButtonComponent,
} from '../components';
import { getTicketTypeDefinition } from './ticketTypes';

const EMBED_FIELD_VALUE_MAX_LENGTH = 1024;

function truncate(value: string, maxLength = EMBED_FIELD_VALUE_MAX_LENGTH): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

/**
 * Renders a ticket record as an embed.
 *
 * The important word is *renders*. Previously the embed **was** the ticket:
 * state lived in it as base64 JSON under a field named `🔧 Internal Data`, and
 * every claim or close was a read-modify-write of the sole copy. Editing this
 * message is now cosmetic — the row is the truth, and a message that is deleted,
 * unpinned or pushed out of history costs nothing but the display.
 *
 * That is also why there is no hidden data field here any more. Nothing reads
 * state back off the message, so nothing needs to be smuggled into it.
 */
export function buildTicketEmbed(ticket: TicketEntity): EmbedBuilder {
    const definition = getTicketTypeDefinition(ticket.type);

    const statusText =
        ticket.status === 'closed'
            ? '🔴 Closed'
            : ticket.status === 'deleted'
              ? '⚫ Deleted'
              : ticket.claimerId
                ? `🔒 Open — claimed by <@${ticket.claimerId}>`
                : '🟢 Open — unclaimed';

    const embed = new EmbedBuilder()
        .setTitle(`🎫 ${definition.label} Ticket #${ticket.ticketNumber}`)
        .setDescription(`**Title:** ${ticket.title}`)
        .addFields(
            { name: '👤 Subject', value: `<@${ticket.subjectId}>`, inline: true },
            {
                name: '👮 Opened By',
                // A flow-opened ticket has no human opener. Said plainly rather
                // than rendered as an empty mention.
                value: ticket.openerId ? `<@${ticket.openerId}>` : 'Automated',
                inline: true,
            },
            { name: '📊 Status', value: statusText, inline: true },
            { name: '📝 Reason', value: truncate(ticket.reason), inline: false }
        )
        .setColor(ticket.status === 'closed' ? 0xff0000 : ticket.claimerId ? 0xffff00 : 0x00ff00)
        .setFooter({ text: `Ticket ID ${ticket.id}` })
        .setTimestamp(new Date(ticket.openedAt));

    return embed;
}

/**
 * Builds the control row, enabling each button from the record.
 *
 * Claim and unclaim are now driven by `claimerId` rather than by a status value,
 * which is what lets an open ticket be unclaimed without first pretending it is
 * in some other lifecycle state.
 */
export function buildTicketButtons(ticket: TicketEntity): ActionRowBuilder<ButtonBuilder>[] {
    const isOpen = ticket.status === 'open';

    return [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            TicketClaimButtonComponent().component(isOpen && !ticket.claimerId) as ButtonBuilder,
            TicketUnclaimButtonComponent().component(isOpen && !!ticket.claimerId) as ButtonBuilder,
            TicketCloseButtonComponent().component(isOpen) as ButtonBuilder,
            TicketReopenButtonComponent().component(ticket.status === 'closed') as ButtonBuilder,
            TicketDeleteButtonComponent().component(ticket.status !== 'deleted') as ButtonBuilder
        ),
    ];
}
