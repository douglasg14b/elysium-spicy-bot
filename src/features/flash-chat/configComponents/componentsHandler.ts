import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ComponentType,
    ButtonInteraction,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalSubmitInteraction,
    PermissionsBitField,
    APIButtonComponent,
    ActionRowData,
    MessageActionRowComponentData,
    MessageActionRowComponentBuilder,
    ChannelSelectMenuBuilder,
    StringSelectMenuBuilder,
    ChannelType,
} from 'discord.js';
import { FlashChatConfig } from '../flashChatInstance';
import { flashChatInstanceStore } from '../flashChatInstanceStore';
import {
    buildAllComponents,
    buildConfigSummaryEmbed,
    buildTimeoutInputModal,
    FlashChatButtonComponentIds,
} from './configComponents';

export const flashChatConfigCommand = new SlashCommandBuilder()
    .setName('flash-config')
    .setDescription('View and configure flash chat settings for this server')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels);

export const handleFlashConfigCommand = async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const guildId = interaction.guildId!;

    // Get all flash chat configs for this guild
    const configs = await getFlashChatConfigs(guildId);

    const embed = buildConfigSummaryEmbed(configs);

    // Arrange components in rows
    const components = buildAllComponents(configs);

    // Modal for timeout number input (triggered by timeoutButton)
    const timeoutModal = buildTimeoutInputModal();

    const response = await interaction.reply({
        embeds: [embed],
        components: [...components.inputs, components.buttonsRow],
        ephemeral: true,
    });

    // response.edit({
    //     embeds: [embed],
    //     components: [...components.inputs, components.buttonsRow],
    // });

    // Handle button interactions
    const collector = response.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 300_000, // 5 minutes
    });

    collector.on('collect', async (buttonInteraction: ButtonInteraction) => {
        console.log('Button interaction:', buttonInteraction.customId, buttonInteraction.user.id);
        if (buttonInteraction.user.id !== interaction.user.id) {
            await buttonInteraction.reply({
                content: 'Only the command user can interact with these buttons!',
                ephemeral: true,
            });
            return;
        }

        const interactionId = buttonInteraction.customId as FlashChatButtonComponentIds;

        switch (interactionId) {
            case 'flash_save_config_button':
                break;
            case 'flash_refresh_button':
                break;
            case 'flash_remove_channel_button':
                await handleRemoveChannel(buttonInteraction, configs);
                break;
            case 'flash_refresh_button':
                // Re-run the original command logic
                await handleFlashConfigCommand(buttonInteraction as any);
                break;
            case 'flash_timeout_button':
                await buttonInteraction.showModal(timeoutModal);
                await buttonInteraction
                    .awaitModalSubmit({
                        time: 300_000,
                        filter: (i) => i.customId === 'flash_timeout_modal',
                    })
                    .then(async (modalInteraction: ModalSubmitInteraction) => {
                        const timeoutValue = modalInteraction.fields.getTextInputValue('timeout_seconds_input_modal');
                        const timeoutSeconds = parseInt(timeoutValue, 10);
                        if (isNaN(timeoutSeconds) || timeoutSeconds <= 0) {
                            await modalInteraction.reply({
                                content: 'Please enter a valid positive number for the timeout.',
                                ephemeral: true,
                            });
                            return;
                        }

                        // Save the new timeout to all configs as an example (you might want to target specific ones)
                        for (const config of configs) {
                            config.messageTimeoutMs = timeoutSeconds * 1000;
                            await saveFlashChatConfig(config);
                        }

                        await modalInteraction.reply({
                            content: `✅ Message timeout updated to ${timeoutSeconds} seconds for all configured channels.`,
                            ephemeral: true,
                        });
                    })
                    .catch(async (error) => {
                        console.error('Modal submission error:', error);
                        await buttonInteraction.followUp({
                            content: '❌ You did not submit the modal in time.',
                            ephemeral: true,
                        });
                    });
        }
    });

    collector.on('end', async () => {
        // Disable buttons after timeout
        const disabledRow = ActionRowBuilder.from<ButtonBuilder>(components.buttonsRow);
        disabledRow.components.forEach((button) => (button as ButtonBuilder).setDisabled(true));

        await interaction.editReply({ components: [disabledRow] }).catch(() => {});
    });
};

// Handle removing a channel (simplified - you'd want a select menu for multiple channels)
const handleRemoveChannel = async (interaction: ButtonInteraction, configs: FlashChatConfig[]): Promise<void> => {
    // For simplicity, just show a modal asking for channel ID
    // In practice, you might want a select menu if there are many channels

    const modal = new ModalBuilder().setCustomId('flash_remove_modal').setTitle('Remove Flash Chat Channel');

    const channelInput = new TextInputBuilder()
        .setCustomId('channel_id')
        .setLabel('Channel ID to Remove')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Channel ID')
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(channelInput));

    await interaction.showModal(modal);

    const modalSubmission = await interaction.awaitModalSubmit({
        time: 300_000,
        filter: (i) => i.customId === 'flash_remove_modal',
    });

    const channelId = modalSubmission.fields.getTextInputValue('channel_id');

    await removeFlashChatConfig(channelId, interaction.guildId!);

    await modalSubmission.reply({
        content: `✅ Flash chat removed from <#${channelId}>!`,
        ephemeral: true,
    });
};

// Placeholder storage functions (implement based on your storage)
const getFlashChatConfigs = async (guildId: string): Promise<FlashChatConfig[]> => {
    return Array.from(flashChatInstanceStore.instances.values())
        .map((x) => x.config)
        .filter((c) => c.guildId === guildId);
};

const saveFlashChatConfig = async (config: FlashChatConfig): Promise<void> => {
    // TODO: Implement based on your storage
    console.log('Saving config:', config);
};

const removeFlashChatConfig = async (channelId: string, guildId: string): Promise<void> => {
    // TODO: Implement based on your storage
    console.log('Removing config for channel:', channelId);
};
