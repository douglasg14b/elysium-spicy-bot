import {
    ActionRowBuilder,
    APIButtonComponentWithCustomId,
    ButtonBuilder,
    Component,
    ComponentBuilder,
    EmbedBuilder,
} from 'discord.js';
import { CreateModTicketButtonComponent } from './createModTicketButton';
import { TicketConfigButtonComponent } from './ticketConfigButton';
import { isTicketingConfigConfigured, TicketingConfigEntity } from '../data/ticketingSchema';
import { SUPPORT_TICKET_NAME_TEMPLATE } from '../constants';

/**
 * Creates the embed message that goes with the persistent button
 */
export function CreateModTicketChannelEmbedComponent(configEntity?: TicketingConfigEntity) {
    function buildComponent(): EmbedBuilder {
        const embed = new EmbedBuilder()
            .setTitle('🎫 Mod Ticket System')
            .setDescription('Click the button below to create a new moderation ticket for a user.')
            .setColor(0x0099ff)
            .addFields({
                name: '📋 Instructions',
                value: '• Click "Create Mod Ticket" button\n• Fill in the user ID/mention and ticket title\n• Optionally add a reason\n• The ticket channel will be created automatically',
                inline: false,
            });

        // Add configuration field if config exists
        if (configEntity?.config) {
            const ticketConfig = configEntity.config;
            const configValue = [
                `**Support Category:** ${ticketConfig.supportTicketCategoryName || 'Not configured'}`,
                `**Closed Category:** ${ticketConfig.closedTicketCategoryName || 'Not configured'}`,
                `**Channel Template:** ${ticketConfig.ticketChannelNameTemplate || SUPPORT_TICKET_NAME_TEMPLATE}`,
                `**Moderation Roles:** ${
                    ticketConfig.moderationRoles?.length
                        ? ticketConfig.moderationRoles.length + ' role(s)'
                        : 'None configured'
                }`,
                `**Next Ticket #:** ${configEntity.ticketNumberInc + 1}`,
            ];

            // Add deployment status if deployed
            if (ticketConfig.modTicketsDeployed && ticketConfig.modTicketsDeployedChannelId) {
                configValue.push(`**Deployed:** <#${ticketConfig.modTicketsDeployedChannelId}>`);
            }

            embed.addFields({
                name: '⚙️ Current Configuration',
                value: configValue.join('\n'),
                inline: false,
            });
        } else {
            embed.addFields({
                name: '⚠️ Configuration Required',
                value: 'The ticket system is not configured yet. Click "⚙️ Configure" to set up the system.',
                inline: false,
            });
        }

        // Add permissions field
        if (configEntity?.config?.moderationRoles?.length) {
            embed.addFields({
                name: '🔒 Permissions',
                value: `Only users with configured moderation roles can create tickets.`,
                inline: false,
            });
        } else {
            embed.addFields({
                name: '🔒 Permissions',
                value: `Only administrators can create tickets until moderation roles are configured.`,
                inline: false,
            });
        }

        return embed.setTimestamp();
    }

    function buildEmbedMessage() {
        const embed = buildComponent();
        const configButton = TicketConfigButtonComponent().component;

        // Check if config exists and is properly set up
        const ticketingIsConfigured = isTicketingConfigConfigured(configEntity);

        const createTicketButton = CreateModTicketButtonComponent(ticketingIsConfigured).component;

        return {
            embeds: [embed],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    createTicketButton as ButtonBuilder,
                    configButton as ButtonBuilder
                ),
            ],
        };
    }

    return {
        component: buildComponent(),
        messageEmbed: buildEmbedMessage(),
    };
}
