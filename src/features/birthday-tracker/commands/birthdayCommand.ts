import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { commandSuccess, commandError } from '../../../features-system/commands';
import { birthdayRepository } from '../data/birthdayRepo';
import { birthdayConfigRepository } from '../data/birthdayConfigRepo';
import { BirthdayModalComponent } from '../components';
import { BirthdayActionSelectComponent } from '../components/birthdayActionSelect';
import { BIRTHDAY_ANNOUNCEMENT_CONFIG_WARNING } from '../constants';

export const BIRTHDAY_COMMAND_NAME = 'birthday';

export const birthdayCommand = new SlashCommandBuilder()
    .setName(BIRTHDAY_COMMAND_NAME)
    .setDescription('Set, view, or manage your birthday in this server');

export const handleBirthdayCommand = async (
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> => {
    if (!interaction.guildId) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Not in a guild');
    }

    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    try {
        // Check if user already has a birthday set
        const existingBirthday = await birthdayRepository.get(guildId, userId);

        if (existingBirthday) {
            // Show action select with current birthday info
            const embed = BirthdayActionSelectComponent.buildBirthdayInfoEmbed(existingBirthday);
            const actionRow = BirthdayActionSelectComponent.buildComponent(existingBirthday);
            const configured = await birthdayConfigRepository.isConfigured(guildId);
            const content = configured ? undefined : BIRTHDAY_ANNOUNCEMENT_CONFIG_WARNING;

            await interaction.reply({
                content,
                embeds: [embed],
                components: [actionRow],
                ephemeral: true,
            });
        } else {
            // Show birthday creation modal
            const modal = BirthdayModalComponent.buildComponent();
            await interaction.showModal(modal);
        }

        return commandSuccess();
    } catch (error) {
        console.error('Error handling birthday command:', error);

        const errorPayload = {
            content: 'An error occurred while processing your birthday command.',
            ephemeral: true,
        } as const;

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply(errorPayload);
        } else if (interaction.isRepliable()) {
            await interaction.followUp(errorPayload).catch((followUpError) => {
                console.error('Failed to send birthday command error follow-up:', followUpError);
            });
        }

        return commandError(error instanceof Error ? error.message : 'Unknown error');
    }
};
