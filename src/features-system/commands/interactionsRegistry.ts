import {
    CacheType,
    ChatInputCommandInteraction,
    Interaction,
    InteractionType,
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
} from 'discord.js';
import {
    BUILDER_INTERACTIONS_REF,
    BuilderToInteraction,
    BuilderInteractionType,
    InteractionHandler,
    InteractionHandlerResult,
    isSlashCommandBuilder,
    SupportedInteractionBuilder,
    ApplicationCommandInteraction,
    ModalSubmitInteractionType,
    MessageComponentInteraction,
    InteractionToBuilder,
} from './types';
import { AdditionalData } from '../../shared';
import { logCommand } from '../commands-audit/logCommand';

function resolveCommandNameOrId(builder: SupportedInteractionBuilder): string {
    if (isSlashCommandBuilder(builder)) {
        return builder.name;
    }

    if (!builder.data.custom_id) {
        throw new Error('Command builder does not have a custom_id');
    }

    return builder.data.custom_id;
}

type InteractionHandlerWrapper<TInteraction extends Interaction = Interaction> = {
    handler: InteractionHandler<TInteraction>;
    builder: InteractionToBuilder<TInteraction>;
    type: BuilderInteractionType;
};

type InteractionCommandOrId = string;

/**
 * A registry for all commands and interactions, will route incoming interactions to their handlers
 */
export class InteractionsRegistry {
    private interactionHandlers = new Map<InteractionCommandOrId, InteractionHandlerWrapper>();

    register<TBuilder extends SupportedInteractionBuilder>(
        builder: TBuilder,
        handler: InteractionHandler<BuilderToInteraction<TBuilder>>
    ) {
        const commandName = resolveCommandNameOrId(builder);
        const type = BUILDER_INTERACTIONS_REF.find((d) => d.builderGuard(builder))?.type;

        if (!type) {
            throw new Error('Unsupported builder type for registration');
        }

        if (this.interactionHandlers.has(commandName)) {
            throw new Error(`Handler already registered for command: ${commandName}`);
        }

        this.interactionHandlers.set(commandName, {
            handler: handler as InteractionHandler<Interaction<CacheType>>,
            builder,
            type: type,
        });
    }

    getSlashCommandBuilders(): SupportedInteractionBuilder[] {
        return Array.from(this.interactionHandlers.values())
            .filter((cmd) => cmd.type === 'slash')
            .map((cmd) => cmd.builder);
    }

    async handleInteraction(interaction: Interaction): Promise<void> {
        const now = performance.now();
        let result: InteractionHandlerResult | null = null;

        try {
            switch (interaction.type) {
                case InteractionType.ApplicationCommand:
                    result = await this.handleCommandInteraction(interaction);
                    break;
                case InteractionType.ModalSubmit:
                    result = await this.handleModalSubmitInteraction(interaction);
                    break;
                case InteractionType.MessageComponent:
                    result = await this.handleMessageComponentInteraction(interaction);
                    break;
                default:
                    throw new Error(`Unsupported interaction type: ${interaction.type}`);
            }
        } catch (error) {
            result = {
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error',
            };
            console.error('Error handling interaction:', error);

            if (interaction.isRepliable()) {
                // Send error response on unhandled exception
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: 'An error occurred while processing your command.',
                        ephemeral: true,
                    });
                }
            }
        } finally {
            if (!result) throw new Error('Command result is null');

            const end = performance.now();
            const executionTime = end - now;

            // If result has a message, but interaction not yet replied/deferred, send it
            if (interaction.isRepliable() && result.message && !interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: result.message,
                    ephemeral: true,
                });
            }

            if (interaction instanceof ChatInputCommandInteraction) {
                await logCommand(interaction, result, executionTime);
            }
        }
    }

    private async handleCommandInteraction(
        interaction: ApplicationCommandInteraction
    ): Promise<InteractionHandlerResult> {
        const command = this.interactionHandlers.get(interaction.commandName);
        if (!command) {
            throw new Error(`No handler found for command: ${interaction.commandName}`);
        }

        return await command.handler(interaction);
    }

    private async handleModalSubmitInteraction(
        interaction: ModalSubmitInteractionType
    ): Promise<InteractionHandlerResult> {
        const command = this.interactionHandlers.get(interaction.customId);

        if (!command) {
            throw new Error(`No handler found for modal submit: ${interaction.customId}`);
        }

        return await command.handler(interaction);
    }

    private async handleMessageComponentInteraction(
        interaction: MessageComponentInteraction
    ): Promise<InteractionHandlerResult> {
        const command = this.interactionHandlers.get(interaction.customId);

        if (!command) {
            throw new Error(`No handler found for message component: ${interaction.customId}`);
        }

        return await command.handler(interaction);
    }
}

export const interactionsRegistry = new InteractionsRegistry();
