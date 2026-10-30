import {
    ChannelType,
    ChatInputCommandInteraction,
    PermissionsBitField,
    SlashCommandBuilder,
    type Guild,
} from 'discord.js';
import { WEB_ENABLED, WEB_PUBLIC_URL } from '../../environment';
import { commandError, commandSuccess } from '../../features-system/commands';
import { InteractionHandlerResult } from '../../features-system/commands/types';
import { FLASH_CHAT_MAX_TIMEOUT_SECONDS } from './constants';
import { flashChatRepo, type FlashChatSettings } from './data/flashChatRepo';
import { flashChatManager } from './flashChatManager';
import { flashChatService } from './flashChatService';
import { checkFlashChatChannel } from './logic/flashChatChannel';
import { formatFlashChatTimeout } from './logic/flashChatNotices';

type CommandArgs =
    | { subcommand: 'config' }
    | { subcommand: 'off'; channelId: string }
    | { subcommand: 'setup' | 'on'; channelId: string; settings: FlashChatSettings; replace: boolean };

export const FLASH_CHAT_COMMAND_NAME = 'flash-chat';

export const flashChatCommand = new SlashCommandBuilder()
    .setName(FLASH_CHAT_COMMAND_NAME)
    .setDescription('Manage flash chat messages')
    .addSubcommand((subcommand) =>
        subcommand.setName('config').setDescription('View and configure flash chat settings for this server'),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName('setup')
            .setDescription('Configure flash chat for a specific channel')
            .addChannelOption((option) =>
                option
                    .setName('channel')
                    .setDescription('The channel to manage')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText),
            )
            .addIntegerOption(
                (option) =>
                    option
                        .setName('timeout')
                        .setDescription('The message timeout in seconds')
                        .setRequired(true)
                        .setMinValue(1) // 1 second min
                        .setMaxValue(FLASH_CHAT_MAX_TIMEOUT_SECONDS),
            )
            .addBooleanOption((option) =>
                option
                    .setName('preserve-pinned')
                    .setDescription('Whether to preserve pinned messages')
                    .setRequired(true),
            )
            .addBooleanOption((option) =>
                option
                    .setName('preserve-history')
                    .setDescription('Whether to preserve message history')
                    .setRequired(true),
            )
            .addBooleanOption((option) =>
                option
                    .setName('replace')
                    .setDescription('Replace existing flash-chat config if it exists')
                    .setRequired(true),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName('on')
            .setDescription('Enable flash chat in the current channel')
            .addIntegerOption((option) =>
                option
                    .setName('timeout')
                    .setDescription('The message timeout in seconds')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(FLASH_CHAT_MAX_TIMEOUT_SECONDS),
            )
            .addBooleanOption((option) =>
                option
                    .setName('preserve-pinned')
                    .setDescription('Whether to preserve pinned messages')
                    .setRequired(true),
            )
            .addBooleanOption((option) =>
                option
                    .setName('preserve-history')
                    .setDescription('Whether to preserve message history')
                    .setRequired(true),
            )
            .addBooleanOption((option) =>
                option
                    .setName('replace')
                    .setDescription('Replace existing flash-chat config if it exists')
                    .setRequired(true),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand.setName('off').setDescription('Disable flash chat in the current channel'),
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels);

function readSettings(interaction: ChatInputCommandInteraction): FlashChatSettings {
    return {
        timeoutSeconds: interaction.options.getInteger('timeout', true),
        preservePinned: interaction.options.getBoolean('preserve-pinned', true),
        preserveHistory: interaction.options.getBoolean('preserve-history', true),
    };
}

function resolveCommandArgs(interaction: ChatInputCommandInteraction): CommandArgs {
    const subcommand = interaction.options.getSubcommand();
    switch (subcommand) {
        case 'config':
            return { subcommand };
        case 'off':
            return { subcommand, channelId: interaction.channelId };
        case 'setup':
            return {
                subcommand,
                channelId: interaction.options.getChannel('channel', true).id,
                settings: readSettings(interaction),
                replace: interaction.options.getBoolean('replace', true),
            };
        case 'on':
            return {
                subcommand,
                channelId: interaction.channelId,
                settings: readSettings(interaction),
                replace: interaction.options.getBoolean('replace', true),
            };
        default:
            throw new Error(`Unknown /${FLASH_CHAT_COMMAND_NAME} subcommand: ${subcommand}`);
    }
}

export const handleFlashChatCommand = async (
    interaction: ChatInputCommandInteraction,
): Promise<InteractionHandlerResult> => {
    const commandArgs = resolveCommandArgs(interaction);
    const guild = interaction.guild;

    if (!guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Not in a guild');
    }

    // Saving and switching off post in the channel before answering, which can outrun Discord's three seconds.
    await interaction.deferReply({ ephemeral: true });

    // Once deferred, the registry no longer answers a throw, so this handler must.
    try {
        return await runSubcommand(interaction, guild, commandArgs);
    } catch (error) {
        console.error(`/${FLASH_CHAT_COMMAND_NAME} ${commandArgs.subcommand} failed:`, error);
        await interaction.editReply('❌ Flash chat tripped over its own feet. Try again in a moment.');
        return commandError(`Error in /${FLASH_CHAT_COMMAND_NAME} ${commandArgs.subcommand}`, {
            error: (error as Error).message,
        });
    }
};

async function runSubcommand(
    interaction: ChatInputCommandInteraction,
    guild: Guild,
    commandArgs: CommandArgs,
): Promise<InteractionHandlerResult> {
    if (commandArgs.subcommand === 'config') {
        await interaction.editReply(
            WEB_ENABLED
                ? `⚙️ Flash chat lives in the dashboard now: ${WEB_PUBLIC_URL}/flash-chat`
                : "⚙️ The dashboard isn't switched on for this bot. Use /flash-chat setup to configure channels.",
        );
        return commandSuccess();
    }

    if (commandArgs.subcommand === 'off') {
        const removed = await flashChatService.remove(guild, commandArgs.channelId);
        await interaction.editReply(
            removed
                ? `⚡ Flash chat has been disabled in <#${commandArgs.channelId}>.`
                : `❌ Flash chat is not enabled in <#${commandArgs.channelId}>.`,
        );
        return commandSuccess();
    }

    const { channelId, settings, replace } = commandArgs;

    const check = checkFlashChatChannel(guild, channelId);
    if (!check.ok) {
        await interaction.editReply(`❌ ${check.message}`);
        return commandError('Channel cannot run flash chat', { channelId });
    }

    if (!replace && (await flashChatRepo.get(guild.id, channelId))) {
        await interaction.editReply(
            `❌ Flash chat is already on in ${check.channel}. Set \`replace\` to true to change it.`,
        );
        return commandSuccess();
    }

    await flashChatService.configure({ channel: check.channel, settings, by: interaction.user });

    if (!flashChatManager.has(guild.id, channelId)) {
        await interaction.editReply(
            `⚠️ Saved, but I couldn't start deleting in ${check.channel}. Check I can still see it and manage messages there, then run this again.`,
        );
        return commandError('Flash chat saved but not running', { channelId });
    }

    await interaction.editReply({
        embeds: [
            {
                title: '⚡ Flash Chat Configured',
                color: 0x00ff00,
                fields: [
                    { name: '📺 Channel', value: `${check.channel}`, inline: true },
                    { name: '⏱️ Timeout', value: formatFlashChatTimeout(settings.timeoutSeconds), inline: true },
                    { name: '📌 Preserve Pinned', value: settings.preservePinned ? '✅ Yes' : '❌ No', inline: true },
                    { name: '🗂️ Preserve History', value: settings.preserveHistory ? '✅ Yes' : '❌ No', inline: true },
                ],
                footer: {
                    text: `Configured by ${interaction.user.tag}`,
                    icon_url: interaction.user.displayAvatarURL(),
                },
                timestamp: new Date().toISOString(),
            },
        ],
    });

    return commandSuccess();
}
