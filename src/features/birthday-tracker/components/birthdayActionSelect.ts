import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ButtonInteraction, EmbedBuilder } from 'discord.js';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { birthdayRepository } from '../data/birthdayRepo';
import { Birthday } from '../data/birthdaySchema';
import { commandSuccess, commandError } from '../../../features-system/commands';
import { BirthdayModalComponent } from './birthdayModal';
import { formatBirthday, calculateAge } from '../utils';

const BIRTHDAY_UPDATE_BUTTON_ID = 'birthday_update_button';
const BIRTHDAY_DELETE_BUTTON_ID = 'birthday_delete_button';

export class BirthdayActionSelectComponent {
    static buildComponent(birthday: Birthday): ActionRowBuilder<ButtonBuilder> {
        const updateButton = new ButtonBuilder()
            .setCustomId(BIRTHDAY_UPDATE_BUTTON_ID)
            .setLabel('Update Birthday')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️');

        const deleteButton = new ButtonBuilder()
            .setCustomId(BIRTHDAY_DELETE_BUTTON_ID)
            .setLabel('Delete Birthday')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️');

        return new ActionRowBuilder<ButtonBuilder>().addComponents(updateButton, deleteButton);
    }

    static buildBirthdayInfoEmbed(birthday: Birthday): EmbedBuilder {
        const formattedDate = formatBirthday(birthday.month, birthday.day, birthday.year);
        const age = birthday.year ? calculateAge(birthday.year) : null;
        const ageDisplay = age ? ` - You are ${age} years old` : '';

        return new EmbedBuilder()
            .setTitle('🎂 Your Birthday')
            .setDescription(`**${formattedDate}**${ageDisplay}`)
            .setColor(0x00ae86)
            .addFields({
                name: '📅 What would you like to do?',
                value: 'Use the buttons below to update or delete your birthday.',
                inline: false,
            })
            .setTimestamp();
    }

    static async handleButtonInteraction(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
            return commandError('Not in a guild');
        }

        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const action = interaction.customId;

        try {
            const existingBirthday = await birthdayRepository.get(guildId, userId);

            if (!existingBirthday) {
                await interaction.reply({
                    content: "❌ You don't have a birthday set in this server.",
                    ephemeral: true,
                });
                return commandError('No birthday found');
            }

            if (action === BIRTHDAY_DELETE_BUTTON_ID) {
                await birthdayRepository.delete(guildId, userId);

                await interaction.reply({
                    content: '✅ Your birthday has been removed from this server.',
                    ephemeral: true,
                });

                return commandSuccess();
            }

            if (action === BIRTHDAY_UPDATE_BUTTON_ID) {
                // Show the birthday modal for updating
                const modal = BirthdayModalComponent.buildComponent(existingBirthday);
                await interaction.showModal(modal);

                return commandSuccess();
            }

            await interaction.reply({
                content: '❌ Invalid action selected.',
                ephemeral: true,
            });

            return commandError('Invalid action');
        } catch (error) {
            console.error('Error handling birthday button interaction:', error);

            await interaction.reply({
                content: '❌ An error occurred while processing your request.',
                ephemeral: true,
            });

            return commandError(error instanceof Error ? error.message : 'Unknown error');
        }
    }
}

export { BIRTHDAY_UPDATE_BUTTON_ID, BIRTHDAY_DELETE_BUTTON_ID };
