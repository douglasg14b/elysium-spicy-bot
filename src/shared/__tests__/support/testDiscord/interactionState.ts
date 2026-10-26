import {
    ComponentType,
    GatewayDispatchEvents,
    InteractionContextType,
    InteractionType,
    Locale,
    SnowflakeUtil,
    type APIButtonComponentWithCustomId,
    type APIInteractionGuildMember,
    type APIMessage,
    type APIMessageComponentButtonInteraction,
} from 'discord.js';
import type { HarnessEvent, ServerState } from './serverState';
import { TestDiscordError } from './testDiscordError';

/**
 * Button presses: a member pressing a button under a message, and what the bot answered.
 *
 * ## What is modelled, and what is refused
 *
 *  - **A press** (`ServerChannel.pressButton`) is an INTERACTION_CREATE of type
 *    MESSAGE_COMPONENT carrying the message as Discord holds it. A button the message does
 *    not hold, or holds disabled, is refused: Discord never sends a press for one.
 *  - **The member's `permissions` and the bot's `app_permissions`** are server-wide —
 *    `@everyone` and every role held, everything for the owner or an Administrator. Discord
 *    sends them with the channel's overwrites applied, which is not modelled, so a press in
 *    a channel holding an overwrite for `@everyone`, the presser, the bot, or a role either
 *    holds is refused rather than answered with permissions that might be wrong.
 *  - **The answer** goes to `POST /interactions/:id/:token/callback`, as one of two kinds:
 *    a deferred update (type 6, which closes the press with no message) and an ephemeral
 *    reply (type 4, flags 64). A public reply, a modal, an edit of the message, and a second
 *    acknowledgement of one press are all refused — Discord answers the last with 40060,
 *    and a product that sends it has a double-reply bug the test should hear about loudly.
 *  - **Follow-ups and edits of the reply** (`/webhooks/:appId/:token…`) are not modelled.
 *    Add them when a test needs one.
 *  - An ephemeral reply lands in no channel: it is kept on the press, and read there.
 */

/** A press as the harness sends it: always in a guild, so always with its guild and member. */
export type ButtonPressPayload = APIMessageComponentButtonInteraction & {
    readonly guild_id: string;
    readonly member: APIInteractionGuildMember;
};

/** What the bot answered one press with, as a test reads it. */
export type InteractionResponseView =
    | { readonly kind: 'deferUpdate' }
    | { readonly kind: 'ephemeralReply'; readonly content: string };

/** One press as Discord holds it. */
interface PressRecord {
    readonly id: string;
    readonly token: string;
    readonly responses: InteractionResponseView[];
}

/** The slice of `ServerState` presses lean on. */
type InteractionHost = Pick<
    ServerState,
    'botUser' | 'channel' | 'member' | 'messages' | 'guildPermissions' | 'refuseOverwritesFor'
>;

/** Every press Discord has sent, and what the bot answered each with. */
export class ServerInteractions {
    private readonly presses = new Map<string, PressRecord>();

    constructor(
        private readonly host: InteractionHost,
        private readonly publish: (event: HarnessEvent) => void
    ) {}

    /**
     * A member pressing the button `customId` under message `messageId` in a text channel.
     * Dispatches INTERACTION_CREATE and returns the press's id.
     */
    pressButton(input: {
        readonly channelId: string;
        readonly messageId: string;
        readonly customId: string;
        readonly userId: string;
    }): string {
        const channel = this.host.channel(input.channelId);
        const message = this.host.messages.find(input.channelId, input.messageId);
        if (!message) {
            throw new TestDiscordError(`Channel ${input.channelId} holds no message ${input.messageId} to press a button on.`);
        }
        const button = findButton(message, input.customId);
        if (!button) {
            throw new TestDiscordError(
                `Message ${input.messageId} holds no button "${input.customId}", so Discord would never send a press for it.`
            );
        }
        if (button.disabled) {
            throw new TestDiscordError(
                `Button "${input.customId}" on message ${input.messageId} is disabled, so Discord would never send a press for it.`
            );
        }
        const member = this.host.member(channel.guild_id, input.userId);
        if (!member) {
            throw new TestDiscordError(`${input.userId} is not a member of guild ${channel.guild_id}, so they cannot press a button there.`);
        }
        this.host.refuseOverwritesFor(input.channelId, input.userId);
        this.host.refuseOverwritesFor(input.channelId, this.host.botUser.id);

        const press: PressRecord = {
            id: SnowflakeUtil.generate().toString(),
            token: `test-discord-interaction-token-${this.presses.size + 1}`,
            responses: [],
        };
        this.presses.set(press.id, press);

        const payload: ButtonPressPayload = {
            id: press.id,
            application_id: this.host.botUser.id,
            type: InteractionType.MessageComponent,
            data: { custom_id: input.customId, component_type: ComponentType.Button },
            guild_id: channel.guild_id,
            channel: structuredClone(channel),
            channel_id: input.channelId,
            member: {
                ...structuredClone(member),
                user: structuredClone(member.user),
                permissions: this.host.guildPermissions(channel.guild_id, input.userId),
            },
            token: press.token,
            version: 1,
            message,
            app_permissions: this.host.guildPermissions(channel.guild_id, this.host.botUser.id),
            locale: Locale.EnglishUS,
            guild_locale: Locale.EnglishUS,
            entitlements: [],
            authorizing_integration_owners: { 0: channel.guild_id },
            context: InteractionContextType.Guild,
            attachment_size_limit: 10 * 1024 * 1024,
        };
        this.publish({ t: GatewayDispatchEvents.InteractionCreate, d: payload });
        return press.id;
    }

    /** What the bot has answered a press with so far, oldest first. */
    responses(interactionId: string): readonly InteractionResponseView[] {
        return structuredClone(this.require(interactionId).responses);
    }

    /** Refuse an answer the harness cannot model. Reads only, so the router can run it first. */
    checkRespond(interactionId: string, token: string): void {
        const press = this.require(interactionId);
        if (press.token !== token) {
            throw new TestDiscordError(`Interaction ${interactionId} was answered with a token that is not its own.`);
        }
        if (press.responses.length > 0) {
            throw new TestDiscordError(
                `Interaction ${interactionId} was acknowledged twice. Discord refuses the second with 40060 ("Interaction has already been acknowledged"); the product has a double-reply bug.`
            );
        }
    }

    respond(interactionId: string, token: string, response: InteractionResponseView): void {
        this.checkRespond(interactionId, token);
        this.require(interactionId).responses.push(response);
    }

    private require(interactionId: string): PressRecord {
        const press = this.presses.get(interactionId);
        if (!press) {
            throw new TestDiscordError(`TestDiscord sent no interaction ${interactionId}.`);
        }
        return press;
    }
}

/** The button a message holds under `customId`, in any of its rows — or undefined. */
function findButton(message: APIMessage, customId: string): APIButtonComponentWithCustomId | undefined {
    for (const row of message.components ?? []) {
        if (!('components' in row)) continue;
        for (const component of row.components) {
            if (component.type === ComponentType.Button && 'custom_id' in component && component.custom_id === customId) {
                return component;
            }
        }
    }
    return undefined;
}
