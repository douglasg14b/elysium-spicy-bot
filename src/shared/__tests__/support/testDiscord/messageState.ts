import {
    ChannelType,
    EmbedType,
    GatewayDispatchEvents,
    MessageType,
    SnowflakeUtil,
    type APIActionRowComponent,
    type APIComponentInMessageActionRow,
    type APIEmbed,
    type APIGuildMemberNoUser,
    type APIMessage,
    type APIUser,
    type GatewayMessageCreateDispatchData,
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
 *  - **MESSAGE_CREATE and MESSAGE_UPDATE go only to a client holding the `GuildMessages`
 *    intent**, as Discord sends them. The harness's own client does not declare it, so it
 *    hears none; one driven through `TestDiscord.start({ client })` that does, such as
 *    `DISCORD_CLIENT`, hears them all. A send and a pin notice each announce
 *    MESSAGE_CREATE. An edit announces MESSAGE_UPDATE, and so does a pin, which flips the
 *    pinned message's `pinned`. That last one is observed rather than documented — the
 *    pin endpoint's docs name only CHANNEL_PINS_UPDATE — but it is the behaviour pin-log
 *    bots are built on, and leaving it out would leave a pinned message unpinned in the
 *    cache of every client that asked for message events.
 *  - **A message event carries the whole message as stored**, plus the fields the gateway
 *    adds for a guild message: `guild_id`, and the author's and each mentioned user's
 *    `member` without its `user`. Those are what discord.js reads off one — `guild_id` to
 *    place the message, the members to patch its member cache. MESSAGE_UPDATE carries the
 *    full message too, as Discord now sends it. Content is always present: every message
 *    here is the bot's own, which Discord delivers whether or not the client holds
 *    `MessageContent`.
 *  - **Message events are held like any other event a REST write causes**, until the
 *    gateway is flushed. A pin's three arrive as MESSAGE_UPDATE, MESSAGE_CREATE, then
 *    CHANNEL_PINS_UPDATE; Discord promises no order among them, so nothing may rely on it.
 *  - **Mentions** resolve only for `<@id>` tokens naming a guild member, with
 *    `allowed_mentions` absent or parsing users. Role and `@everyone` mentions, users
 *    outside the guild, and suppressed user mentions all fault: whether Discord still
 *    lists a suppressed mention in `mentions` is not something the harness knows. So does
 *    an edit that brings a mention in or replaces the content of a message holding one,
 *    because how Discord recomputes `mentions` on an edit is not known either.
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

    /** Told by `TestDiscord.start()` whether the client subscribed to message events, which decides whether any are sent. */
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
        this.announceCreate(message);
        return structuredClone(message);
    }

    /** Refuse an edit the harness cannot model. Reads only; the message must exist. */
    checkEdit(channelId: string, messageId: string, body: EditMessageBody): void {
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
        // The same gap from the other side: new content replacing a message that
        // mentioned somebody would leave its stored `mentions` describing text that is gone.
        if (body.content !== undefined && message.mentions.length > 0) {
            throw new TestDiscordError(
                `TestDiscord received an edit replacing the content of ${messageId}, which mentions somebody. How Discord recomputes mentions on an edit is not modelled.`
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
        this.announceUpdate(message);

        return structuredClone(message);
    }

    /** Refuse a pin the harness cannot model. Reads only; the message must exist. */
    checkPin(channelId: string, messageId: string): void {
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
        this.announceUpdate(message);

        // Discord announces a pin in the channel as a system message pointing at what
        // was pinned — the notice members see as "pinned a message to this channel".
        const notice: APIMessage = {
            ...this.newMessage(channelId, MessageType.ChannelPinnedMessage),
            message_reference: { message_id: messageId, channel_id: channelId, guild_id: guildId },
        };
        this.store(channelId, notice);
        this.announceCreate(notice);
        this.host.noteChannelActivity(channelId, { lastPinTimestamp: notice.timestamp });

        this.publish({
            t: GatewayDispatchEvents.ChannelPinsUpdate,
            d: { guild_id: guildId, channel_id: channelId, last_pin_timestamp: notice.timestamp },
        });
    }

    /** MESSAGE_CREATE for a message just stored, if the client asked for message events. */
    private announceCreate(message: APIMessage): void {
        if (!this.clientReceivesMessageEvents) return;
        this.publish({ t: GatewayDispatchEvents.MessageCreate, d: this.gatewayMessage(message) });
    }

    /** MESSAGE_UPDATE for a message just changed, if the client asked for message events. */
    private announceUpdate(message: APIMessage): void {
        if (!this.clientReceivesMessageEvents) return;
        this.publish({ t: GatewayDispatchEvents.MessageUpdate, d: this.gatewayMessage(message) });
    }

    /**
     * A stored message as the gateway carries it: a copy, plus what the gateway adds for a
     * guild message — `guild_id`, and a `member` without `user` for the author and for
     * each mentioned user. See the header for why these fields and no others.
     *
     * Typed as the create payload and used for updates too: Discord sends the full
     * message on both, so the two discord-api-types shapes are the same.
     */
    private gatewayMessage(message: APIMessage): GatewayMessageCreateDispatchData {
        const guildId = this.host.channel(message.channel_id).guild_id;
        return {
            ...structuredClone(message),
            guild_id: guildId,
            member: this.memberWithoutUser(guildId, message.author.id),
            mentions: message.mentions.map((user) => ({
                ...structuredClone(user),
                member: this.memberWithoutUser(guildId, user.id),
            })),
        };
    }

    /**
     * A guild member as a message event carries one. Throws for somebody outside the
     * guild: what Discord puts in the event then is not modelled, and no message the
     * harness stores can have one — mentions are checked against the guild on send.
     */
    private memberWithoutUser(guildId: string, userId: string): APIGuildMemberNoUser {
        const member = this.host.member(guildId, userId);
        if (!member) {
            throw new TestDiscordError(
                `TestDiscord has a message event naming ${userId}, who is not a member of guild ${guildId}. What Discord carries for them is not modelled.`
            );
        }
        const { user: _user, ...withoutUser } = structuredClone(member);
        return withoutUser;
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
