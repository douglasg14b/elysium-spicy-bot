import {
    EmbedBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { formatDuration } from '../../../utils';
import { FlashChatConfig } from '../data/flashChatSchema';

export const FLASH_CHAT_COMPONENTS = [
    {
        name: 'channelSelect',
        id: 'flash_channel_select',
        fn: () => {
            return new ChannelSelectMenuBuilder()
                .setCustomId('flash_channel_select')
                .setPlaceholder('Select a channel to configure')
                .addChannelTypes(ChannelType.GuildText)
                .setMinValues(1)
                .setMaxValues(1);
        },
    },
    {
        name: 'timeoutButton',
        id: 'flash_timeout_button',
        fn: () => {
            return new ButtonBuilder()
                .setCustomId('flash_timeout_button')
                .setLabel('Set Timeout (seconds)')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('⏱️');
        },
    },
    {
        name: 'preservePinnedSelect',
        id: 'flash_preserve_pinned_select',
        fn: () => {
            return new StringSelectMenuBuilder()
                .setCustomId('flash_preserve_pinned_select')
                .setPlaceholder('Preserve pinned messages?')
                .addOptions(
                    {
                        label: 'Yes - Keep pinned messages',
                        description: 'Pinned messages will not be auto-deleted',
                        value: 'true',
                        emoji: '📌',
                    },
                    {
                        label: 'No - Delete all messages',
                        description: 'All messages including pinned will be deleted',
                        value: 'false',
                        emoji: '🗑️',
                    }
                );
        },
    },
    {
        name: 'preserveHistorySelect',
        id: 'flash_preserve_history_select',
        fn: () => {
            return new StringSelectMenuBuilder()
                .setCustomId('flash_preserve_history_select')
                .setPlaceholder('Preserve message history?')
                .addOptions(
                    {
                        label: 'Yes - Keep message history',
                        description: 'Messages remain visible in Discord history',
                        value: 'true',
                        emoji: '📚',
                    },
                    {
                        label: 'No - Clear history completely',
                        description: 'Messages are permanently removed from history',
                        value: 'false',
                        emoji: '🧹',
                    }
                );
        },
    },
    {
        name: 'saveButton',
        id: 'flash_save_config_button',
        fn: () => {
            return new ButtonBuilder()
                .setCustomId('flash_save_config_button')
                .setLabel('Save Configuration')
                .setStyle(ButtonStyle.Success)
                .setEmoji('💾')
                .setDisabled(true); // Enabled when all selections are made
        },
    },
    {
        name: 'removeButton',
        id: 'flash_remove_channel_button',
        fn: (configs: FlashChatConfig[]) => {
            return new ButtonBuilder()
                .setCustomId('flash_remove_channel_button')
                .setLabel('Remove Channel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️')
                .setDisabled(configs.length === 0);
        },
    },
    {
        name: 'refreshButton',
        id: 'flash_refresh_button',
        fn: () => {
            return new ButtonBuilder()
                .setCustomId('flash_refresh_button')
                .setLabel('Refresh')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔄');
        },
    },
] as const;

type FlashChatComponentId = (typeof FLASH_CHAT_COMPONENTS)[number]['id'];

export type FlashChatButtonComponentIds = Extract<
    (typeof FLASH_CHAT_COMPONENTS)[number],
    { fn: (...args: any) => ButtonBuilder }
>['id'];

type FlashChatComponentMap = {
    [K in (typeof FLASH_CHAT_COMPONENTS)[number] as K['id']]: K;
};

const FLASH_COMPONENTS_ID_MAP = Object.fromEntries(
    FLASH_CHAT_COMPONENTS.map((component) => [component.id, component])
) as FlashChatComponentMap;

function getComponent<TId extends FlashChatComponentId>(
    id: TId,
    configs: FlashChatConfig[]
): ReturnType<FlashChatComponentMap[TId]['fn']> {
    const componentConfig = FLASH_COMPONENTS_ID_MAP[id];

    return componentConfig.fn(configs) as ReturnType<FlashChatComponentMap[TId]['fn']>;
}

function getActionRowForComponent<TId extends FlashChatComponentId>(id: TId, configs: FlashChatConfig[]) {
    const component = getComponent(id, configs);

    return new ActionRowBuilder<ReturnType<FlashChatComponentMap[TId]['fn']>>().addComponents(component);
}

export function buildTimeoutInputModal(currentTimeout?: number) {
    const timeoutModal = new ModalBuilder().setCustomId('flash_timeout_modal').setTitle('Set Message Timeout');

    const timeoutInput = new TextInputBuilder()
        .setCustomId('timeout_seconds_input_modal')
        .setLabel('Timeout in seconds')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(`${currentTimeout}` || '3600 (1 hour)')
        .setMinLength(1)
        .setMaxLength(8)
        .setRequired(true);

    timeoutModal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(timeoutInput));

    return timeoutModal;
}

export function buildAllComponents(configs: FlashChatConfig[]) {
    return {
        inputs: [
            getActionRowForComponent('flash_channel_select', configs),
            getActionRowForComponent('flash_preserve_history_select', configs),
            getActionRowForComponent('flash_preserve_pinned_select', configs),
            getActionRowForComponent('flash_timeout_button', configs),
        ],
        buttonsRow: new ActionRowBuilder<ButtonBuilder>().addComponents(
            getComponent('flash_save_config_button', configs),
            getComponent('flash_remove_channel_button', configs),
            getComponent('flash_refresh_button', configs)
        ),
    };
}

export function buildConfigSummaryEmbed(configs: FlashChatConfig[]) {
    const embed = new EmbedBuilder()
        .setTitle('⚡ Flash Chat Configuration')
        .setDescription(
            configs.length > 0
                ? `Found ${configs.length} configured channel(s)`
                : 'No channels configured for flash chat'
        )
        .setColor(0x0099ff);

    // Add field for each configured channel
    configs.forEach((config, index) => {
        const timeout = formatDuration(config.timeoutSeconds * 1000);
        const features = [
            config.preservePinned ? '📌 Preserve Pinned' : '🗑️ Delete Pinned',
            config.preserveHistory ? '📚 Keep History' : '🧹 Clear History',
        ].join(' • ');

        embed.addFields({
            name: `<#${config.channelId}>`,
            value: `⏱️ ${timeout}\n${features}`,
            inline: true,
        });
    });

    return embed;
}
