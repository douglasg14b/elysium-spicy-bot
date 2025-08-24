import type { ChatInputCommand, CommandData, MessageCommand } from 'commandkit';

import { ApplicationCommandOptionType } from 'discord.js';

export const command = {
    name: 'flash-chat',
    description: 'Manage flash chat messages',
    options: [
        {
            name: 'channel',
            description: 'The channel to manage',
            type: ApplicationCommandOptionType.Channel,
            required: true,
        },
        {
            name: 'timeout',
            description: 'The message timeout in seconds',
            type: ApplicationCommandOptionType.Integer,
            required: true,
        },
        {
            name: 'preserve-pinned',
            description: 'Whether to preserve pinned messages',
            type: ApplicationCommandOptionType.Boolean,
            required: true,
        },
    ],
} as const satisfies CommandData;

export const chatInput: ChatInputCommand = async ({ interaction }) => {
    await interaction.reply(interaction.channel?.id ?? 'No channel');
};
