import {
    APIButtonComponent,
    APIButtonComponentWithCustomId,
    ButtonBuilder,
    ButtonInteraction,
    ChatInputCommandInteraction,
    ComponentBuilder,
    Interaction,
    InteractionType,
    ModalBuilder,
    ModalSubmitInteraction,
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
    SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { AdditionalData } from '../../shared';

// All types aside from SlashCommandBuilder are derived interfaces resulting from the fluent interface
export type SupportedSlashCommandBuilder =
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;

export type SupportedInteractionBuilder =
    | SupportedSlashCommandBuilder
    | ModalBuilder
    // Just an annoying way to represent a ButtonBuilder because discordjs types are bad
    | ComponentBuilder<APIButtonComponentWithCustomId>;

export const BUILDER_INTERACTIONS_REF = [
    { type: 'slash', builder: SlashCommandBuilder, builderGuard: isSlashCommandBuilder },
    { type: 'modal', builder: ModalBuilder, builderGuard: isModalBuilder },
    {
        type: 'button',
        builder: ComponentBuilder<APIButtonComponentWithCustomId>,
        builderGuard: isButtonBuilder,
    },
] as const;

export type BuilderInteractionType = (typeof BUILDER_INTERACTIONS_REF)[number]['type'];

// Mapped separately because the `typeof`-ness messed things up with missing types/interfaces and actual classes
type BuilderInteractions = [
    { builder: SupportedSlashCommandBuilder; interaction: ChatInputCommandInteraction },
    { builder: ModalBuilder; interaction: ModalSubmitInteraction },
    { builder: ComponentBuilder<APIButtonComponentWithCustomId>; interaction: ButtonInteraction }
];

export type InteractionKey = ModalSubmitInteraction['type'];

export type BuilderToInteraction<TBuilder extends SupportedInteractionBuilder> =
    TBuilder extends BuilderInteractions[number]['builder']
        ? Extract<BuilderInteractions[number], { builder: TBuilder }>['interaction']
        : never;

export type InteractionToBuilder<TInteraction extends Interaction> =
    TInteraction extends BuilderInteractions[number]['interaction']
        ? Extract<BuilderInteractions[number], { interaction: TInteraction }>['builder']
        : never;

export type ApplicationCommandInteraction = Extract<Interaction, { type: InteractionType.ApplicationCommand }>;
export type MessageComponentInteraction = Extract<Interaction, { type: InteractionType.MessageComponent }>;
export type ModalSubmitInteractionType = Extract<Interaction, { type: InteractionType.ModalSubmit }>;

export type InteractionHandlerResult = {
    status: 'success' | 'error' | 'skipped';
    message?: string;
    additionalData?: AdditionalData;
};

export type InteractionHandler<TInteraction extends Interaction> = (
    interaction: TInteraction
) => Promise<InteractionHandlerResult>;

export function isSlashCommandBuilder(builder: SupportedInteractionBuilder): builder is SupportedSlashCommandBuilder {
    return builder instanceof SlashCommandBuilder;
}

export function isModalBuilder(builder: SupportedInteractionBuilder): builder is ModalBuilder {
    return builder instanceof ModalBuilder;
}

export function isButtonBuilder(
    builder: SupportedInteractionBuilder
): builder is ComponentBuilder<APIButtonComponentWithCustomId> {
    return builder instanceof ButtonBuilder;
}
