import {
    ChannelType,
    ChatInputCommandInteraction,
    PermissionFlagsBits,
    PermissionsBitField,
    SlashCommandBuilder,
} from 'discord.js';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { commandSuccess, commandError } from '../../../features-system/commands';
import { birthdayConfigRepository } from '../data/birthdayConfigRepo';

export const BIRTHDAY_CONFIG_COMMAND_NAME = 'birthday-config';

export const birthdayConfigCommand = new SlashCommandBuilder()
    .setName(BIRTHDAY_CONFIG_COMMAND_NAME)
    .setDescription('Set the channel where public birthday announcements are posted')
    .addChannelOption((option) =>
        option
            .setName('channel')
            .setDescription('Text channel for birthday announcements')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild);

export async function handleBirthdayConfigCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
        await interaction.reply({
            content: 'This command can only be used in a server.',
            ephemeral: true,
        });
        return commandError('Not in guild');
    }

    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
            content: 'You need **Manage Server** to configure birthday announcements.',
            ephemeral: true,
        });
        return commandError('Missing ManageGuild');
    }

    const selectedChannel = interaction.options.getChannel('channel', true);

    if (selectedChannel.type !== ChannelType.GuildText) {
        await interaction.reply({
            content: 'Pick a server text channel for announcements.',
            ephemeral: true,
        });
        return commandError('Invalid channel type');
    }

    const guildChannel = await interaction.guild.channels.fetch(selectedChannel.id);
    if (!guildChannel || guildChannel.type !== ChannelType.GuildText) {
        await interaction.reply({
            content: 'Could not load that channel. Pick another or try again.',
            ephemeral: true,
        });
        return commandError('Channel fetch failed');
    }

    const me = interaction.guild.members.me;
    if (!me) {
        await interaction.reply({
            content: 'Could not verify the bot member in this server. Try again in a moment.',
            ephemeral: true,
        });
        return commandError('Bot member missing');
    }

    const perms = guildChannel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        await interaction.reply({
            content:
                'I need **View Channel** and **Send Messages** in that channel. Pick another channel or fix my permissions.',
            ephemeral: true,
        });
        return commandError('Bot channel permissions');
    }

    try {
        await birthdayConfigRepository.upsertAnnouncementChannel(interaction.guildId, guildChannel.id);
    } catch (error) {
        console.error('birthday-config upsert failed:', error);
        const errorPayload = {
            content: 'Could not save configuration. Try again later.',
            ephemeral: true,
        } as const;
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply(errorPayload);
        } else if (interaction.isRepliable()) {
            await interaction.followUp(errorPayload).catch((followUpError) => {
                console.error('Failed to send birthday-config error follow-up:', followUpError);
            });
        }
        return commandError('Birthday config upsert failed');
    }

    const successPayload = {
        content: `Birthday announcements will post in ${guildChannel}.`,
        ephemeral: true,
    } as const;

    try {
        await interaction.reply(successPayload);
    } catch (replyError) {
        console.error('Failed to send birthday-config success reply:', replyError);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply(successPayload).catch((retryError) => {
                console.error('Failed to retry birthday-config success reply:', retryError);
            });
        } else if (interaction.isRepliable()) {
            await interaction.followUp(successPayload).catch((followUpError) => {
                console.error('Failed to send birthday-config success follow-up:', followUpError);
            });
        }
    }

    return commandSuccess();
}
