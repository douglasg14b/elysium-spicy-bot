import {
    ChannelType,
    ChatInputCommandInteraction,
    PermissionsBitField,
    SlashCommandBuilder,
} from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { birthdayConfigRepo } from '../data/birthdayConfigRepo';

export const BIRTHDAY_CONFIG_COMMAND_NAME = 'birthday-config';

export const birthdayConfigCommand = new SlashCommandBuilder()
    .setName(BIRTHDAY_CONFIG_COMMAND_NAME)
    .setDescription('Configure birthday announcements for this server')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addChannelOption((option) =>
        option
            .setName('channel')
            .setDescription('Channel where birthday announcements should be posted')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
    )
    .addChannelOption((option) =>
        option
            .setName('context-channel')
            .setDescription('Optional channel to mine for birthday context (e.g. intros)')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText)
    );

export async function handleBirthdayConfigCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Birthday config command used outside a guild');
    }

    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
            content: 'You need Manage Server permission to configure birthday announcements.',
            ephemeral: true,
        });
        return commandError('Missing ManageGuild permission');
    }

    const selectedChannelOption = interaction.options.getChannel('channel', true);
    const selectedChannel = await interaction.guild.channels.fetch(selectedChannelOption.id);
    const contextChannelOption = interaction.options.getChannel('context-channel', false);
    const selectedContextChannel = contextChannelOption
        ? await interaction.guild.channels.fetch(contextChannelOption.id)
        : null;

    if (!selectedChannel || selectedChannel.type !== ChannelType.GuildText) {
        await interaction.reply({
            content: 'Please choose a normal text channel for birthday announcements.',
            ephemeral: true,
        });
        return commandError('Selected channel is not a guild text channel');
    }

    const botMember = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
    const permissions = selectedChannel.permissionsFor(botMember);

    if (!permissions.has(PermissionsBitField.Flags.ViewChannel) || !permissions.has(PermissionsBitField.Flags.SendMessages)) {
        await interaction.reply({
            content: `I need View Channel + Send Messages in <#${selectedChannel.id}> before I can use it.`,
            ephemeral: true,
        });
        return commandError('Bot lacks required permissions in selected channel');
    }

    if (selectedContextChannel && selectedContextChannel.type !== ChannelType.GuildText) {
        await interaction.reply({
            content: 'Context channel must be a normal text channel.',
            ephemeral: true,
        });
        return commandError('Context channel is not a guild text channel');
    }

    if (selectedContextChannel) {
        const contextPermissions = selectedContextChannel.permissionsFor(botMember);
        if (
            !contextPermissions.has(PermissionsBitField.Flags.ViewChannel) ||
            !contextPermissions.has(PermissionsBitField.Flags.ReadMessageHistory)
        ) {
            await interaction.reply({
                content: `I need View Channel + Read Message History in <#${selectedContextChannel.id}> to use it as birthday context.`,
                ephemeral: true,
            });
            return commandError('Bot lacks required permissions in context channel');
        }
    }

    await birthdayConfigRepo.upsertAnnouncementChannel(
        interaction.guildId,
        selectedChannel.id,
        selectedContextChannel?.id || undefined
    );

    await interaction.reply({
        content: selectedContextChannel
            ? `Birthday announcements are now configured for <#${selectedChannel.id}> with context from <#${selectedContextChannel.id}>.`
            : `Birthday announcements are now configured for <#${selectedChannel.id}>.`,
        ephemeral: true,
    });

    return commandSuccess();
}
