import {
    ActionRowBuilder,
    APIButtonComponentWithCustomId,
    ButtonBuilder,
    Component,
    ComponentBuilder,
    EmbedBuilder,
} from 'discord.js';
import { TICKETING_CONFIG } from '../ticketsConfig';
import { CreateModTicketButtonComponent } from './createModTicketButton';

/**
 * Creates the embed message that goes with the persistent button
 */
export function CreateModTicketChannelEmbedComponent() {
    function buildComponent(): EmbedBuilder {
        return new EmbedBuilder()
            .setTitle('🎫 Mod Ticket System')
            .setDescription('Click the button below to create a new moderation ticket for a user.')
            .setColor(0x0099ff)
            .addFields(
                {
                    name: '📋 Instructions',
                    value: '• Click "Create Mod Ticket" button\n• Fill in the user ID/mention and ticket title\n• Optionally add a reason\n• The ticket channel will be created automatically',
                    inline: false,
                },
                {
                    name: '🔒 Permissions',
                    value: `Only users with the **${TICKETING_CONFIG.moderationRoles.join(
                        ', '
                    )}** role can create tickets.`,
                    inline: false,
                }
            )
            .setTimestamp();
    }

    function buildEmbedMessage() {
        const embed = buildComponent();
        const button = CreateModTicketButtonComponent().component;

        return {
            embeds: [embed],
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button as ButtonBuilder)],
        };
    }

    return {
        component: buildComponent(),
        messageEmbed: buildEmbedMessage(),
    };
}
