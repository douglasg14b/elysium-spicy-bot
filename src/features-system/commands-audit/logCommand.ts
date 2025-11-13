import {
    ChannelType,
    ChatInputCommandInteraction,
    Events,
    GuildBasedChannel,
    TextBasedChannel,
    ThreadOnlyChannel,
} from 'discord.js';
import { DISCORD_CLIENT } from '../../discordClient';
import { commandAuditLogRepo } from './data';
import { jsonIfy } from '../../shared';
import { ApplicationCommandInteraction, InteractionHandlerResult } from '../commands/types';

// TODO: Switch this up to automatically load all commands, and then later
// We update them with success or not, and their time
export async function logCommand(
    interaction: ChatInputCommandInteraction,
    result: InteractionHandlerResult,
    executionTime: number
) {
    try {
        const channelName =
            (interaction?.channel && ('name' in interaction.channel ? interaction.channel.name : 'unknown')) ||
            'unknown';

        await commandAuditLogRepo.insert({
            command: interaction.commandName,
            subcommand: interaction.options.getSubcommand(false),

            channelId: interaction.channelId,
            channelName: channelName,

            guildId: interaction.guildId ?? 'none',
            guildName: interaction.guild ? interaction.guild.name : 'Not A Guild',

            userId: interaction.user.id,
            userName: interaction.user.username,
            userDiscriminator: interaction.user.discriminator || null,

            parameters: jsonIfy(getCommandParameters(interaction.options)),
            result: result.status,
            resultMessage: result.message || null,
            resultData: jsonIfy(result.additionalData || null),
            executionTimeMs: executionTime,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Error logging command:', error);
    }
}

function getCommandParameters(options: ChatInputCommandInteraction['options']) {
    const params: Record<string, any> = {};

    options.data.forEach((option) => {
        if (option.type === 1) {
            // Subcommand
            params[option.name] = getCommandParameters({ ...options, data: option.options || [] } as any);
        } else if (option.type === 2) {
            // Subcommand Group
            params[option.name] = getCommandParameters({ ...options, data: option.options || [] } as any);
        } else {
            params[option.name] = option.value;
        }
    });

    return params;
}
