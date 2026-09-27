import {
    ChannelType,
    EmbedType,
    GatewayDispatchEvents,
    MessageType,
    SnowflakeUtil,
    type APIActionRowComponent,
    type APIComponentInMessageActionRow,
    type APIEmbed,
    type APIMessage,
    type APIUser,
} from 'discord.js';
import type { CreateMessageBody, EditMessageBody } from './messageSchemas';
import type { HarnessEvent, ServerState } from './serverState';
import { TestDiscordError } from './testDiscordError';

/**
 * The messages Discord holds, per channel, as Discord's own JSON.
 *
 * Kept beside `ServerState` rather than inside it because messages are the one kind of
 * record channels own that nothing else reads, and the channel code has enough to say
 * already. It changes state through the same rule, though: every primitive that Discord
 * would announce over the gateway publishes the event here, and readers get copies.
 *
 * ## What is modelled, and what is refused
 *
 *  - **Send, fetch, edit and pin** of messages the bot writes. Discord's replies are
 *    built from what was sent, with the members Discord adds on the way back:
 *    `type: 'rich'` on every embed, the mentioned users, `edited_timestamp` on an edit.
 *  - **Embeds and components are stored as sent** otherwise. Discord re-serialises an
 *    embed's timestamp (`+00:00` and microseconds) and gives each component a numeric
 *    `id`; neither is modelled, so nothing may assert on either.
 *  - **Pinning** posts the system notice Discord posts (type `ChannelPinnedMessage`,
 *    referencing the pinned message, which the API documents) and announces
 *    CHANNEL_PINS_UPDATE, which the `Guilds` intent delivers.
 *  - **No MESSAGE_CREATE or MESSAGE_UPDATE is dispatched**, because Discord only sends
 *    them to a client holding the `GuildMessages` intent and the harness client does not
 *    declare it. A client that does would be owed those events, so every write faults
 *    for one instead of quietly leaving its cache behind.
 *  - **Mentions** resolve only for `<@id>` tokens naming a guild member, with
 *    `allowed_mentions` absent or parsing users. Role and `@everyone` mentions, users
 *    outside the guild, and suppressed user mentions all fault: whether Discord still
 *    lists a suppressed mention in `mentions` is not something the harness knows.
 */

/** What the router has already checked a message write to be. */
export type MessageDraft = CreateMessageBody;

/** A message as a test reads it: the parts an assertion is about, in plain names. */
export interface ServerMessageView {
    readonly id: string;
    readonly type: MessageType;
    readonly authorId: string;
    readonly content: string;
    readonly embeds: readonly APIEmbed[];
    readonly components: readonly APIActionRowComponent<APIComponentInMessageActionRow>[];
    readonly pinned: boolean;
    /** Whether anybody has edited it since it was sent. */
    readonly edited: boolean;
    /** The message a system notice points at, such as the one a pin notice announces. */
    readonly referencedMessageId: string | null;
}

/** The slice of `ServerState` messages lean on. */
type MessageHost = Pick<ServerState, 'botUser' | 'channel' | 'member' | 'noteChannelActivity'>;

/** Global, for `matchAll`. Never call `.test` on it: a global regex keeps its place between calls. */
const USER_MENTIONS = /<@!?(\d{17,20})>/g;
const ANY_MENTION = /<@!?&?\d+>|@everyone|@here/;
const UNMODELLED_MENTION = /<@&\d+>|@everyone|@here/;

export function toMessageView(message: APIMessage): ServerMessageView {
    return {
        id: message.id,
        type: message.type,
        authorId: message.author.id,
        content: message.content,
        embeds: structuredClone(message.embeds),
        components: structuredClone(
            (message.components ?? []).filter(
                (component): component is APIActionRowComponent<APIComponentInMessageActionRow> =>
                    'components' in component
            )
        ),
        pinned: message.pinned,
        edited: message.edited_timestamp !== null,
        referencedMessageId: message.message_reference?.message_id ?? null,
    };
}

export class ServerMessages {
    private readonly byChannel = new Map<string, APIMessage[]>();
    private clientReceivesMessageEvents = false;

    constructor(
        private readonly host: MessageHost,
        private readonly publish: (event: HarnessEvent) => void
    ) {}

    /** Told by `TestDiscord.start()` whether the client subscribed to message events. */
    setClientReceivesMessageEvents(receives: boolean): void {
        this.clientReceivesMessageEvents = receives;
    }

    /** Every message in a channel, oldest first. The channel must exist; callers check. */
    inChannel(channelId: string): readonly APIMessage[] {
        return structuredClone(this.byChannel.get(channelId) ?? []);
    }

    find(channelId: string, messageId: string): APIMessage | undefined {
        const found = this.byChannel.get(channelId)?.find((message) => message.id === messageId);
        return found ? structuredClone(found) : undefined;
    }

    /** Refuse a send the harness cannot model. Reads only, so the router can run it before a rejection. */
    checkSend(channelId: string, draft: MessageDraft): void {
        this.refuseWithoutMessageEvents();
        const channel = this.host.channel(channelId);
        if (channel.type !== ChannelType.GuildText) {
            throw new TestDiscordError(
                `TestDiscord received a message for ${channelId}, which is not a text channel. What Discord answers is not modelled.`
            );
        }
        if (!draft.content && !draft.embeds?.length && !draft.components?.length) {
            throw new TestDiscordError(
                `TestDiscord received an empty message for ${channelId}. Discord refuses one with a 400 the harness does not model.`
            );
        }
        this.mentionedUsers(channel.guild_id, draft);
    }

    send(channelId: string, draft: MessageDraft): APIMessage {
        this.checkSend(channelId, draft);
        const guildId = this.host.channel(channelId).guild_id;

        const message: APIMessage = {
            ...this.newMessage(channelId, MessageType.Default),
            content: draft.content ?? '',
            mentions: this.mentionedUsers(guildId, draft),
            embeds: (draft.embeds ?? []).map(richEmbed),
            components: structuredClone(draft.components ?? []),
        };
        this.store(channelId, message);
        return structuredClone(message);
    }

    /** Refuse an edit the harness cannot model. Reads only; the message must exist. */
    checkEdit(channelId: string, messageId: string, body: EditMessageBody): void {
        this.refuseWithoutMessageEvents();
        const message = this.locate(channelId, messageId);
        if (message.author.id !== this.host.botUser.id) {
            throw new TestDiscordError(
                `TestDiscord received an edit of message ${messageId}, which the bot did not write. Discord refuses that with an error the harness does not model.`
            );
        }
        if (body.content !== undefined && ANY_MENTION.test(body.content)) {
            throw new TestDiscordError(
                `TestDiscord received an edit of ${messageId} whose content mentions somebody. How Discord recomputes mentions on an edit is not modelled.`
            );
        }
    }

    edit(channelId: string, messageId: string, body: EditMessageBody): APIMessage {
        this.checkEdit(channelId, messageId, body);
        const message = this.locate(channelId, messageId);

        if (body.content !== undefined) message.content = body.content;
        if (body.embeds !== undefined) message.embeds = body.embeds.map(richEmbed);
        if (body.components !== undefined) message.components = structuredClone(body.components);
        message.edited_timestamp = new Date().toISOString();

        return structuredClone(message);
    }

    /** Refuse a pin the harness cannot model. Reads only; the message must exist. */
    checkPin(channelId: string, messageId: string): void {
        this.refuseWithoutMessageEvents();
        if (this.locate(channelId, messageId).pinned) {
            throw new TestDiscordError(
                `TestDiscord received a pin of message ${messageId}, which is already pinned. Whether Discord posts a second notice is not modelled.`
            );
        }
    }

    pin(channelId: string, messageId: string): void {
        this.checkPin(channelId, messageId);
        const message = this.locate(channelId, messageId);
        const guildId = this.host.channel(channelId).guild_id;
        message.pinned = true;

        // Discord announces a pin in the channel as a system message pointing at what
        // was pinned — the notice members see as "pinned a message to this channel".
        const notice = this.newMessage(channelId, MessageType.ChannelPinnedMessage);
        this.store(channelId, {
            ...notice,
            message_reference: { message_id: messageId, channel_id: channelId, guild_id: guildId },
        });
        this.host.noteChannelActivity(channelId, { lastPinTimestamp: notice.timestamp });

        this.publish({
            t: GatewayDispatchEvents.ChannelPinsUpdate,
            d: { guild_id: guildId, channel_id: channelId, last_pin_timestamp: notice.timestamp },
        });
    }

    private refuseWithoutMessageEvents(): void {
        if (this.clientReceivesMessageEvents) {
            throw new TestDiscordError(
                'The connected client declares the GuildMessages intent, so Discord would dispatch MESSAGE_CREATE and MESSAGE_UPDATE for this write. TestDiscord does not model message events; drive the harness client from `TestDiscord.start()` instead.'
            );
        }
    }

    /** The users `content` mentions, as Discord lists them. Throws on any mention it cannot model. */
    private mentionedUsers(guildId: string, draft: MessageDraft): APIUser[] {
        const content = draft.content ?? '';
        if (UNMODELLED_MENTION.test(content)) {
            throw new TestDiscordError(
                'TestDiscord received a message mentioning a role, @everyone or @here. How Discord resolves those is not modelled.'
            );
        }

        const ids = [...new Set([...content.matchAll(USER_MENTIONS)].map((match) => match[1] ?? ''))];
        if (ids.length === 0) return [];

        const parse = draft.allowed_mentions?.parse;
        if (parse && !parse.includes('users')) {
            throw new TestDiscordError(
                'TestDiscord received a user mention with allowed_mentions suppressing users. Whether Discord still lists it in `mentions` is not modelled.'
            );
        }

        return ids.map((userId) => {
            const member = this.host.member(guildId, userId);
            if (!member) {
                throw new TestDiscordError(
                    `TestDiscord received a mention of ${userId}, who is not a member of guild ${guildId}. How Discord resolves that is not modelled.`
                );
            }
            return structuredClone(member.user);
        });
    }

    private newMessage(channelId: string, type: MessageType.Default | MessageType.ChannelPinnedMessage): APIMessage {
        return {
            id: SnowflakeUtil.generate().toString(),
            channel_id: channelId,
            author: structuredClone(this.host.botUser),
            content: '',
            timestamp: new Date().toISOString(),
            edited_timestamp: null,
            tts: false,
            mention_everyone: false,
            mentions: [],
            mention_roles: [],
            attachments: [],
            embeds: [],
            pinned: false,
            type,
            components: [],
        };
    }

    private store(channelId: string, message: APIMessage): void {
        const messages = this.byChannel.get(channelId) ?? [];
        messages.push(message);
        this.byChannel.set(channelId, messages);
        this.host.noteChannelActivity(channelId, { lastMessageId: message.id });
    }

    private locate(channelId: string, messageId: string): APIMessage {
        const found = this.byChannel.get(channelId)?.find((message) => message.id === messageId);
        if (!found) {
            throw new TestDiscordError(`TestDiscord holds no message ${messageId} in channel ${channelId}.`);
        }
        return found;
    }
}

/** Discord stamps every embed a bot sends as `rich`. */
function richEmbed(embed: APIEmbed): APIEmbed {
    return { ...structuredClone(embed), type: EmbedType.Rich };
}
