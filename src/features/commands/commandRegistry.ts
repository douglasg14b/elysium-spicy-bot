import { ChatInputCommandInteraction, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder } from 'discord.js';
import { SupportedCommandBuilder } from './types';
import { AdditionalData } from '../../shared';
import { logCommand } from '../commands-audit/logCommand';

export type CommandHandlerResult = {
    status: 'success' | 'error' | 'skipped';
    message?: string;
    additionalData?: AdditionalData;
};
export type CommandHandler = (interaction: ChatInputCommandInteraction) => Promise<CommandHandlerResult>;

export class CommandRegistry {
    private commands = new Map<
        string,
        {
            builder: SupportedCommandBuilder;
            handler: CommandHandler;
        }
    >();

    register(builder: SupportedCommandBuilder, handler: CommandHandler) {
        this.commands.set(builder.name, { builder, handler });
    }

    getBuilders(): SupportedCommandBuilder[] {
        return Array.from(this.commands.values()).map((cmd) => cmd.builder);
    }

    async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
        const now = performance.now();
        let result: CommandHandlerResult | null = null;

        try {
            const command = this.commands.get(interaction.commandName);
            if (!command) {
                throw new Error(`No handler found for command: ${interaction.commandName}`);
            }

            result = await command.handler(interaction);
        } catch (error) {
            result = {
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error',
            };
            console.error('Error handling interaction:', error);

            // Send error response on unhandled exception
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: 'An error occurred while processing your command.',
                    ephemeral: true,
                });
            }
        } finally {
            if (!result) throw new Error('Command result is null');

            const end = performance.now();
            const executionTime = end - now;

            await logCommand(interaction, result, executionTime);
        }
    }
}

export const commandRegistry = new CommandRegistry();
