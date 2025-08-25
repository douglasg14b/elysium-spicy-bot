import {
    ChannelType,
    ChatInputCommandInteraction,
    PermissionsBitField,
    SlashCommandBuilder,
    TextChannel,
} from 'discord.js';
import { stringToTitleCase, verifyCommandPermissions } from '../../utils';
import { flashChatRepo } from './flashChatRepo';
import { handleFlashConfigCommand } from './component';

const REQUIRED_PERMISSIONS = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
];

type SubCommand = 'config' | 'setup' | 'on' | 'off';

type CommandOptions =
    | {
          subcommand: 'setup';
          channel: TextChannel;
          timeout: number;
          preservePinned: boolean;
          preserveHistory: boolean;
      }
    | {
          subcommand: 'on';
          timeout: number;
          preservePinned: boolean;
          preserveHistory: boolean;
      }
    | {
          subcommand: 'off';
      };

type CommandArgs =
    | {
          subcommand: 'config';
          channel: TextChannel;
      }
    | {
          subcommand: 'setup' | 'on';
          channel: TextChannel;
          timeout: number;
          preservePinned: boolean;
          preserveHistory: boolean;
      }
    | {
          subcommand: 'off';
          channel: TextChannel;
      };

export const FLASH_CHAT_COMMAND_NAME = 'flash-chat';

export const flashChatCommand = new SlashCommandBuilder()
    .setName(FLASH_CHAT_COMMAND_NAME)
    .setDescription('Manage flash chat messages')
    .addSubcommand((subcommand) =>
        subcommand.setName('config').setDescription('View and configure flash chat settings for this server')
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
                    .addChannelTypes(ChannelType.GuildText)
            )
            .addIntegerOption(
                (option) =>
                    option
                        .setName('timeout')
                        .setDescription('The message timeout in seconds')
                        .setRequired(true)
                        .setMinValue(1) // 1 second min
                        .setMaxValue(60 * 60 * 24 * 14) // 14 days max
            )
            .addBooleanOption((option) =>
                option
                    .setName('preserve-pinned')
                    .setDescription('Whether to preserve pinned messages')
                    .setRequired(true)
            )
            .addBooleanOption((option) =>
                option
                    .setName('preserve-history')
                    .setDescription('Whether to preserve message history')
                    .setRequired(true)
            )
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
                    .setMaxValue(60 * 60 * 24 * 14)
            )
            .addBooleanOption((option) =>
                option
                    .setName('preserve-pinned')
                    .setDescription('Whether to preserve pinned messages')
                    .setRequired(true)
            )
            .addBooleanOption((option) =>
                option
                    .setName('preserve-history')
                    .setDescription('Whether to preserve message history')
                    .setRequired(true)
            )
    )
    .addSubcommand((subcommand) =>
        subcommand.setName('off').setDescription('Disable flash chat in the current channel')
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels);

function resolveCommandArgs(interaction: ChatInputCommandInteraction): CommandArgs {
    const subcommand = interaction.options.getSubcommand() as SubCommand;
    if (subcommand === 'config') {
        return { subcommand, channel: interaction.channel as TextChannel };
    } else if (subcommand === 'setup') {
        return {
            subcommand,
            channel: interaction.options.getChannel('channel', true) as TextChannel,
            timeout: interaction.options.getInteger('timeout', true),
            preservePinned: interaction.options.getBoolean('preserve-pinned', true),
            preserveHistory: interaction.options.getBoolean('preserve-history', true),
        };
    } else if (subcommand === 'on') {
        return {
            subcommand,
            channel: interaction.channel as TextChannel,
            timeout: interaction.options.getInteger('timeout', true),
            preservePinned: interaction.options.getBoolean('preserve-pinned', true),
            preserveHistory: interaction.options.getBoolean('preserve-history', true),
        };
    } else {
        return { subcommand, channel: interaction.channel as TextChannel };
    }
}

export const handleFlashChatCommand = async (interaction: ChatInputCommandInteraction): Promise<void> => {
    // Get command options
    const commandArgs = resolveCommandArgs(interaction);
    const { subcommand } = commandArgs;

    if (subcommand === 'config') {
        // Not yet implemented
        await interaction.reply({
            content: `⚙️ Flash chat configuration UI is under development. Please use /flash-chat setup to configure channels for now.`,
            ephemeral: true,
        });
        // handleFlashConfigCommand(interaction);
        return;
    }

    if (subcommand === 'off') {
        if (!flashChatRepo.has(commandArgs.channel.id)) {
            await interaction.reply({
                content: `❌ Flash chat is not enabled in ${commandArgs.channel}.`,
                ephemeral: true,
            });
            return;
        }

        await flashChatRepo.stopInstance(commandArgs.channel.id);

        await interaction.reply({
            content: `⚡ Flash chat has been disabled in ${commandArgs.channel}.`,
            ephemeral: true,
        });

        await commandArgs.channel.send({
            embeds: [
                {
                    title: '⚡ Flash Chat Disabled',
                    description: 'Flash chat has been turned off in this channel.',
                    color: 0xff0000,
                },
            ],
        });
        return;
    }

    const { channel, timeout, preservePinned, preserveHistory } = commandArgs;

    // Check bot permissions in target channel
    const botMember = interaction.guild?.members.me;
    const channelPermissions = channel.permissionsFor(botMember!);

    const missingPermissions = verifyCommandPermissions(channelPermissions!, REQUIRED_PERMISSIONS);
    if (missingPermissions.length > 0) {
        await interaction.reply({
            content: `❌ I'm missing these permissions in ${channel}: **${missingPermissions.join(', ')}**`,
            ephemeral: true,
        });
        return;
    }

    try {
        if (flashChatRepo.has(channel.id)) {
            await interaction.reply({
                content: `❌ Flash chat is already enabled in ${channel}. Please disable it first with /flash-chat off.`,
                ephemeral: true,
            });
            return;
        }

        flashChatRepo.startInstance({
            channelId: channel.id,
            guildId: interaction.guildId!,
            messageTimeoutMs: timeout * 1000, // Convert to milliseconds
            preservePinned,
            preserveHistory,
        });

        // Save flash chat configuration
        await saveFlashChatConfig({
            channelId: channel.id,
            guildId: interaction.guildId!,
            timeout: timeout * 1000, // Convert to milliseconds
            preservePinned,
            preserveHistory,
            enabled: true,
            configuredBy: interaction.user.id,
            configuredAt: new Date(),
        });

        // Create success embed
        const replyEmbed = {
            title: '⚡ Flash Chat Configured',
            color: 0x00ff00,
            fields: [
                { name: '📺 Channel', value: `${channel}`, inline: true },
                { name: '⏱️ Timeout', value: formatTimeout(timeout), inline: true },
                { name: '📌 Preserve Pinned', value: preservePinned ? '✅ Yes' : '❌ No', inline: true },
                { name: '🗂️ Preserve History', value: preserveHistory ? '✅ Yes' : '❌ No', inline: true },
            ],
            footer: {
                text: `Configured by ${interaction.user.tag}`,
                icon_url: interaction.user.displayAvatarURL(),
            },
            timestamp: new Date().toISOString(),
            ephemeral: true,
        };

        await interaction.reply({ embeds: [replyEmbed], ephemeral: true, options: { ephemeral: true } });

        // Send notification to the configured channel
        try {
            await channel.send({
                embeds: [
                    {
                        title: '⚡ Flash Chat Enabled',
                        description: `Messages in this channel will be automatically deleted after **${formatTimeout(
                            timeout
                        )}**`,
                        color: 0xffa500,
                        footer: {
                            text: preservePinned ? 'Pinned messages will be preserved' : 'All messages will be deleted',
                        },
                    },
                ],
            });
        } catch (error) {
            console.warn('Could not send notification to target channel:', error);
        }
    } catch (error) {
        console.error('Error saving flash chat config:', error);
        await interaction.reply({
            content: '❌ Failed to configure flash chat. Please try again.',
            ephemeral: true,
        });
    }
};

// Helper function to format timeout duration
const formatTimeout = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}h ${minutes}m ${secs}s`;
};

// Interface for flash chat configuration
interface FlashChatConfig {
    channelId: string;
    guildId: string;
    timeout: number; // in milliseconds
    preservePinned: boolean;
    preserveHistory: boolean;
    enabled: boolean;
    configuredBy: string;
    configuredAt: Date;
}

// Placeholder for storage function
const saveFlashChatConfig = async (config: FlashChatConfig): Promise<void> => {
    // TODO: Implement based on your storage solution
    console.log('Saving flash chat config:', config);
};
