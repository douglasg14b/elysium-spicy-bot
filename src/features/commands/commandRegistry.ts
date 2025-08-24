import { ChatInputCommandInteraction, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder } from 'discord.js';
import { SupportedCommandBuilder } from './types';

export class CommandRegistry {
    private commands = new Map<
        string,
        {
            builder: SupportedCommandBuilder;
            handler: (interaction: ChatInputCommandInteraction) => Promise<void>;
        }
    >();

    register(builder: SupportedCommandBuilder, handler: (interaction: ChatInputCommandInteraction) => Promise<void>) {
        this.commands.set(builder.name, { builder, handler });
    }

    getBuilders(): SupportedCommandBuilder[] {
        return Array.from(this.commands.values()).map((cmd) => cmd.builder);
    }

    async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
        const command = this.commands.get(interaction.commandName);
        if (!command) {
            throw new Error(`No handler found for command: ${interaction.commandName}`);
        }

        await command.handler(interaction);
    }
}

export const commandRegistry = new CommandRegistry();
