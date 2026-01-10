import {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalSubmitInteraction,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
} from 'discord.js';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { birthdayRepository } from '../data/birthdayRepo';
import { Birthday } from '../data/birthdaySchema';
import { commandSuccess, commandError } from '../../../features-system/commands';
import { parseBirthdayInput, formatBirthday } from '../utils';

const BIRTHDAY_MODAL_ID = 'birthday_modal';
const BIRTHDAY_ACTION_SELECT_ID = 'birthday_action_select';

const MONTH_INPUT_ID = 'birthday_month';
const DAY_INPUT_ID = 'birthday_day';
const YEAR_INPUT_ID = 'birthday_year';

export class BirthdayModalComponent {
    static buildComponent(existingBirthday?: Birthday | null): ModalBuilder {
        const monthInput = new TextInputBuilder()
            .setCustomId(MONTH_INPUT_ID)
            .setLabel('Month (1-12)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 3 for March')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(2);

        const dayInput = new TextInputBuilder()
            .setCustomId(DAY_INPUT_ID)
            .setLabel('Day (1-31)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 15')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(2);

        const yearInput = new TextInputBuilder()
            .setCustomId(YEAR_INPUT_ID)
            .setLabel('Year (optional, for age based sassing)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., 1990')
            .setRequired(false)
            .setMinLength(4)
            .setMaxLength(4);

        // Pre-fill with existing data if available
        if (existingBirthday) {
            monthInput.setValue(existingBirthday.month.toString());
            dayInput.setValue(existingBirthday.day.toString());
            if (existingBirthday.year) {
                yearInput.setValue(existingBirthday.year.toString());
            }
        }

        const modal = new ModalBuilder()
            .setCustomId(BIRTHDAY_MODAL_ID)
            .setTitle(existingBirthday ? 'Update Your Birthday' : 'Set Your Birthday');

        const firstRow = new ActionRowBuilder<TextInputBuilder>().addComponents(monthInput);
        const secondRow = new ActionRowBuilder<TextInputBuilder>().addComponents(dayInput);
        const thirdRow = new ActionRowBuilder<TextInputBuilder>().addComponents(yearInput);

        modal.addComponents(firstRow, secondRow, thirdRow);

        return modal;
    }

    static async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<InteractionHandlerResult> {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
            return commandError('Not in a guild');
        }

        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const displayName = interaction.user.displayName || interaction.user.username;
        const username = interaction.user.username;

        try {
            // Validate and parse input
            const monthStr = interaction.fields.getTextInputValue(MONTH_INPUT_ID);
            const dayStr = interaction.fields.getTextInputValue(DAY_INPUT_ID);
            const yearStr = interaction.fields.getTextInputValue(YEAR_INPUT_ID);

            const parseResult = parseBirthdayInput(monthStr, dayStr, yearStr);

            if (!parseResult.isValid) {
                await interaction.reply({
                    content: parseResult.errorMessage!,
                    ephemeral: true,
                });
                return commandError(parseResult.errorMessage!);
            }

            const { month, day, year } = parseResult.data!;

            // Save the birthday
            const birthday = await birthdayRepository.upsert({
                guildId,
                userId,
                month,
                day,
                year,
                displayName,
                username,
            });

            // Format response
            const formattedDate = formatBirthday(month, day, year);

            await interaction.reply({
                content: `🎉 Your birthday has been set to **${formattedDate}**!`,
                ephemeral: true,
            });

            return commandSuccess();
        } catch (error) {
            console.error('Error handling birthday modal submission:', error);

            await interaction.reply({
                content: '❌ An error occurred while saving your birthday. Please try again.',
                ephemeral: true,
            });

            return commandError(error instanceof Error ? error.message : 'Unknown error');
        }
    }
}

export { BIRTHDAY_MODAL_ID };
