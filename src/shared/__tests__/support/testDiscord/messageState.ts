import {
    EmbedType,
    GatewayDispatchEvents,
    MessageFlags,
    MessageType,
    SnowflakeUtil,
    type APIActionRowComponent,
    type APIAttachment,
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
 *  - **Send, fetch, edit, pin and delete** of messages the bot writes. Discord's replies are
 *    built from what was sent, with the members Discord adds on the way back:
 *    `type: 'rich'` on every embed, the mentioned users, `edited_timestamp` on an edit.
 *  - **Messages from others** — a member, the bot from elsewhere, a webhook, a join notice
 *    — arrive through `receive`, plain text only, into a text channel or a thread, and may
 *    be backdated so a test can build the history an outage left behind. Their content is
 *    stored as given whether or not a client could read it: nothing models the
 *    `MessageContent` intent, so nothing may rely on content being withheld.
 *  - **History pages** (`GET /channels/:id/messages`) newest first, as Discord lists them,
 *    with `after` and `limit` only.
 *  - **Embeds and components are stored as sent** otherwise. Discord re-serialises an
 *    embed's timestamp (`+00:00` and microseconds) and gives each component a numeric
 *    `id`; neither is modelled, so nothing may assert on either.
 *  - **Files** arrive with a send or an edit, multipart (`payload_json` plus `files[n]`),
 *    and are stored as the message's `attachments`, named as uploaded, with a CDN-shaped
 *    `url`. The payload's `attachments` must list exactly one entry per file, by index, and
 *    every `attachment://<name>` link in an embed must name a file the same request uploads
 *    — anything else faults, because what Discord does with it is not modelled. Discord
 *    rewrites such a link to the file's CDN link in what it stores; that is **not**
 *    modelled either, so an embed keeps `attachment://<name>` as sent, and nothing may
 *    assert that it came back as a CDN link. On an edit the list is the whole of what the
 *    message keeps: exactly the new files replace every stored attachment, and an empty
 *    list clears them, as discord.js 14 sends an edit given `files`. A list keeping a stored
 *    attachment by its id faults; an edit with no list leaves the attachments alone.
 *  - **Flags**: every message carries `flags`, `0` until a moderator hides its embeds
 *    (`suppressEmbeds`, SUPPRESS_EMBEDS) or an edit sends `flags`, which replaces them.
 *  - **Pinning** posts the system notice Discord posts (type `ChannelPinnedMessage`,
 *    referencing the pinned message, which the API documents) and announces
 *    CHANNEL_PINS_UPDATE, which the `Guilds` intent delivers.
 *  - **MESSAGE_CREATE, MESSAGE_UPDATE and MESSAGE_DELETE go only to a client holding the
 *    `GuildMessages` intent**, as Discord sends them. The harness's own client does not
 *    declare it, so it hears none; one driven through `TestDiscord.start({ client })` that
 *    does, such as `DISCORD_CLIENT`, hears them all. A delete — the bot's, or an
 *    operator's (`ServerChannel.deleteMessage`) — announces MESSAGE_DELETE. A send and a
 *    pin notice each announce MESSAGE_CREATE. An edit announces MESSAGE_UPDATE, and so
 *    does a pin, which flips the pinned message's `pinned`. That last one is observed
 *    rather than documented — the pin endpoint's docs name only CHANNEL_PINS_UPDATE — but
 *    it is the behaviour pin-log bots are built on, and leaving it out would leave a pinned
 *    message unpinned in the cache of every client that asked for message events.
 *  - **A message event carries the whole message as stored**, plus the fields the gateway
 *    adds for a guild message: `guild_id`, and the author's and each mentioned user's
 *    `member` without its `user`. Those are what discord.js reads off one — `guild_id` to
 *    place the message, the members to patch its member cache. MESSAGE_UPDATE carries the
 *    full message too, as Discord now sends it. Content is always present: for the bot's
 *    own messages Discord delivers it whether or not the client holds `MessageContent`,
 *    and for anyone else's see the received-messages caveat above. A webhook's message
 *    carries no `member`.
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

/** One file a multipart request uploaded, as the router read it off the form. */
export interface MessageFile {
    /** `n` of the form's `files[n]` — what the payload's `attachments[].id` names it by. */
    readonly index: number;
    readonly name: string;
    readonly contentType: string;
    readonly bytes: Buffer;
}

/** An attachment as a test reads it. */
export interface ServerAttachmentView {
    readonly filename: string;
    readonly size: number;
    readonly contentType: string | null;
}

/**
 * A message somebody other than the bot's REST calls sent — a member, the bot from
 * elsewhere, or a webhook — as `ServerChannel.receiveMessage` describes it.
 *
 * `sentAt` becomes the message's snowflake as well as its timestamp, exactly as Discord
 * derives one from the other, so a test can place history inside an outage.
 */
export interface IncomingMessage {
    readonly from: { readonly kind: 'member'; readonly userId: string } | { readonly kind: 'webhook' };
    /** `UserJoin` is the join notice Discord posts as the member who joined: a system message. */
    readonly type: MessageType.Default | MessageType.UserJoin;
    readonly content: string;
    readonly sentAt: Date;
}

/** One page of `GET /channels/:id/messages`, as the router has checked it. */
export interface HistoryPage {
    readonly after?: string;
    readonly limit: number;
}

/** A message as a test reads it: the parts an assertion is about, in plain names. */
export interface ServerMessageView {
    readonly id: string;
    readonly type: MessageType;
    readonly authorId: string;
    readonly content: string;
    readonly embeds: readonly APIEmbed[];
    readonly attachments: readonly ServerAttachmentView[];
    readonly components: readonly APIActionRowComponent<APIComponentInMessageActionRow>[];
    readonly pinned: boolean;
    /** Whether anybody has edited it since it was sent. */
    readonly edited: boolean;
    /** The message a system notice points at, such as the one a pin notice announces. */
    readonly referencedMessageId: string | null;
    /** Whether somebody hid its embeds (SUPPRESS_EMBEDS), and no edit has shown them since. */
    readonly embedsSuppressed: boolean;
}

/** The slice of `ServerState` messages lean on. */
type MessageHost = Pick<ServerState, 'botUser' | 'channel' | 'member' | 'noteChannelActivity' | 'messageChannel'>;

/**
 * What Discord sends for "no flags". discord-api-types declares `MessageFlags` without a zero
 * member, so `0` is cast once here, as `serverState.ts` does for its flag enums.
 */
const NO_MESSAGE_FLAGS = 0 as MessageFlags;

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
        attachments: message.attachments.map((attachment) => ({
            filename: attachment.filename,
            size: attachment.size,
            contentType: attachment.content_type ?? null,
        })),
        components: structuredClone(
            (message.components ?? []).filter(
                (component): component is APIActionRowComponent<APIComponentInMessageActionRow> =>
                    'components' in component
            )
        ),
        pinned: message.pinned,
        edited: message.edited_timestamp !== null,
        referencedMessageId: message.message_reference?.message_id ?? null,
        embedsSuppressed: ((message.flags ?? 0) & MessageFlags.SuppressEmbeds) !== 0,
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
    checkSend(channelId: string, draft: MessageDraft, files: readonly MessageFile[] = []): void {
        // A text channel or a thread: the two places the harness keeps messages.
        const { guildId, holdsMessages } = this.host.messageChannel(channelId);
        if (!holdsMessages) {
            throw new TestDiscordError(
                `TestDiscord received a message for ${channelId}, which is not a text channel or a thread. What Discord answers is not modelled.`
            );
        }
        if (!draft.content && !draft.embeds?.length && !draft.components?.length && files.length === 0) {
            throw new TestDiscordError(
                `TestDiscord received an empty message for ${channelId}. Discord refuses one with a 400 the harness does not model.`
            );
        }
        checkFiles(draft, files);
        this.mentionedUsers(guildId, draft);
    }

    send(channelId: string, draft: MessageDraft, files: readonly MessageFile[] = []): APIMessage {
        this.checkSend(channelId, draft, files);
        const { guildId } = this.host.messageChannel(channelId);

        const message: APIMessage = {
            ...this.newMessage(channelId, MessageType.Default),
            content: draft.content ?? '',
            mentions: this.mentionedUsers(guildId, draft),
            embeds: (draft.embeds ?? []).map(richEmbed),
            components: structuredClone(draft.components ?? []),
            attachments: files.map((file) => storedAttachment(channelId, file)),
        };
        this.store(channelId, message);
        this.announceCreate(message);
        return structuredClone(message);
    }

    /**
     * A message arriving from somebody other than the bot's REST calls, into a text
     * channel or a thread. Announced like any other once a client asked for message events.
     *
     * A webhook's message carries `webhook_id`, and its author is the webhook itself —
     * not a member, and marked `bot` as Discord marks every webhook author.
     */
    receive(channelId: string, incoming: IncomingMessage): APIMessage {
        const { guildId, holdsMessages } = this.host.messageChannel(channelId);
        if (!holdsMessages) {
            throw new TestDiscordError(
                `TestDiscord was asked to deliver a message into ${channelId}, which holds no messages.`
            );
        }
        if (incoming.from.kind === 'webhook' && incoming.type !== MessageType.Default) {
            throw new TestDiscordError('A webhook cannot post a join notice; only Discord does, as the member who joined.');
        }

        const author = incoming.from.kind === 'member' ? this.memberUser(guildId, incoming.from.userId) : webhookAuthor();
        const message: APIMessage = {
            ...this.newMessage(channelId, incoming.type, incoming.sentAt),
            author,
            content: incoming.content,
            mentions: this.mentionedUsers(guildId, { content: incoming.content }),
            ...(incoming.from.kind === 'webhook' ? { webhook_id: author.id } : {}),
        };
        this.store(channelId, message);
        this.announceCreate(message);
        return structuredClone(message);
    }

    /**
     * A page of history as Discord answers `GET /channels/:id/messages`: **newest first**.
     *
     * With `after`, the `limit` messages immediately following it, so paging forward means
     * taking the highest id of each page as the next cursor. Without, the newest `limit`.
     */
    history(channelId: string, page: HistoryPage): APIMessage[] {
        const held = this.byChannel.get(channelId) ?? [];
        const { after } = page;
        const selected =
            after === undefined
                ? held.slice(-page.limit)
                : held.filter((message) => BigInt(message.id) > BigInt(after)).slice(0, page.limit);
        return structuredClone(selected).reverse();
    }

    /**
     * Refuse an edit the harness cannot model. Reads only; the message must exist.
     *
     * Files are modelled one way only, the way discord.js 14 sends them on an edit given
     * `files`: `attachments` listing exactly the new files' indices, which replaces what the
     * message held. A listed id naming one of its stored attachments — keeping it — faults, as
     * does an `attachment://` link naming anything but a file the same edit uploads.
     */
    checkEdit(channelId: string, messageId: string, body: EditMessageBody, files: readonly MessageFile[] = []): void {
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
        const kept = (body.attachments ?? []).find((listed) => message.attachments.some((held) => held.id === listed.id));
        if (kept) {
            throw new TestDiscordError(
                `TestDiscord received an edit of ${messageId} keeping its attachment ${kept.id}. Keeping an attachment through an edit is not modelled.`
            );
        }
        if (body.attachments === undefined && files.length > 0) {
            throw new TestDiscordError(
                `TestDiscord received an edit of ${messageId} uploading files with no attachments list. What Discord does with those is not modelled.`
            );
        }
        checkFiles(body, files);
    }

    edit(channelId: string, messageId: string, body: EditMessageBody, files: readonly MessageFile[] = []): APIMessage {
        this.checkEdit(channelId, messageId, body, files);
        const message = this.locate(channelId, messageId);

        if (body.content !== undefined) message.content = body.content;
        if (body.embeds !== undefined) message.embeds = body.embeds.map(richEmbed);
        if (body.components !== undefined) message.components = structuredClone(body.components);
        // The list names only new files (`checkEdit`), so what it leaves out is dropped: the
        // message holds exactly what this edit uploaded — nothing, for an empty list.
        if (body.attachments !== undefined) message.attachments = files.map((file) => storedAttachment(channelId, file));
        if (body.flags !== undefined) message.flags = body.flags === 0 ? NO_MESSAGE_FLAGS : body.flags;
        message.edited_timestamp = new Date().toISOString();
        this.announceUpdate(message);

        return structuredClone(message);
    }

    /**
     * Refuse a delete the harness cannot model: the bot deleting a message it did not write,
     * which needs Manage Messages — not modelled. Reads only; the message must exist.
     */
    checkDelete(channelId: string, messageId: string): void {
        if (this.locate(channelId, messageId).author.id !== this.host.botUser.id) {
            throw new TestDiscordError(
                `TestDiscord received a delete of message ${messageId}, which the bot did not write. Whether Discord allows it is not modelled.`
            );
        }
    }

    /**
     * Remove a message — the bot's DELETE, or an operator deleting it in the Discord client —
     * and announce MESSAGE_DELETE to a client that asked for message events. The channel's
     * last message id is left as it was: Discord does not move it back.
     */
    delete(channelId: string, messageId: string): void {
        const messages = this.byChannel.get(channelId) ?? [];
        const index = messages.findIndex((message) => message.id === messageId);
        if (index === -1) {
            throw new TestDiscordError(`TestDiscord holds no message ${messageId} in channel ${channelId}.`);
        }
        messages.splice(index, 1);

        if (!this.clientReceivesMessageEvents) return;
        const { guildId } = this.host.messageChannel(channelId);
        this.publish({ t: GatewayDispatchEvents.MessageDelete, d: { id: messageId, channel_id: channelId, guild_id: guildId } });
    }

    /**
     * Somebody with Manage Messages hiding a message's embeds in the Discord client ("Remove
     * all embeds"): SUPPRESS_EMBEDS is set on it, which a fetch then carries in `flags`, and
     * MESSAGE_UPDATE is announced to a client that asked for message events. Its `embeds` are
     * stored as they were: what Discord answers for them while hidden is not modelled, so
     * nothing may assert on a hidden message's embeds.
     */
    suppressEmbeds(channelId: string, messageId: string): void {
        const message = this.locate(channelId, messageId);
        message.flags = (message.flags ?? 0) | MessageFlags.SuppressEmbeds;
        this.announceUpdate(message);
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
        const { guildId } = this.host.messageChannel(message.channel_id);
        return {
            ...structuredClone(message),
            guild_id: guildId,
            // A webhook is not a member, so its message carries none.
            ...(message.webhook_id ? {} : { member: this.memberWithoutUser(guildId, message.author.id) }),
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
    private mentionedUsers(guildId: string, draft: Pick<MessageDraft, 'content' | 'allowed_mentions'>): APIUser[] {
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

    private newMessage(
        channelId: string,
        type: MessageType.Default | MessageType.ChannelPinnedMessage | MessageType.UserJoin,
        sentAt: Date = new Date()
    ): APIMessage {
        return {
            // Discord's ids carry their own send time, which is what discord.js reads `createdAt` from.
            id: SnowflakeUtil.generate({ timestamp: sentAt }).toString(),
            channel_id: channelId,
            author: structuredClone(this.host.botUser),
            content: '',
            timestamp: sentAt.toISOString(),
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
            // Discord sends a message's flags on every read; none until somebody sets one.
            flags: NO_MESSAGE_FLAGS,
        };
    }

    /**
     * Keep a channel's messages in id order, which is send order. A received message may be
     * backdated before ones already held, so it is inserted rather than appended, and the
     * channel's last message is the newest held, not the one just stored.
     */
    private store(channelId: string, message: APIMessage): void {
        const messages = this.byChannel.get(channelId) ?? [];
        const later = messages.findIndex((held) => BigInt(held.id) > BigInt(message.id));
        messages.splice(later === -1 ? messages.length : later, 0, message);
        this.byChannel.set(channelId, messages);
        this.host.noteChannelActivity(channelId, { lastMessageId: messages.at(-1)?.id ?? message.id });
    }

    /** A member's user, as a message they wrote carries it. Throws for somebody outside the guild. */
    private memberUser(guildId: string, userId: string): APIUser {
        const member = this.host.member(guildId, userId);
        if (!member) {
            throw new TestDiscordError(`TestDiscord was asked to deliver a message from ${userId}, who is not a member of guild ${guildId}.`);
        }
        return structuredClone(member.user);
    }

    private locate(channelId: string, messageId: string): APIMessage {
        const found = this.byChannel.get(channelId)?.find((message) => message.id === messageId);
        if (!found) {
            throw new TestDiscordError(`TestDiscord holds no message ${messageId} in channel ${channelId}.`);
        }
        return found;
    }
}

/** A webhook as the author of its own message: its id and name, flagged `bot`. */
function webhookAuthor(): APIUser {
    return {
        id: SnowflakeUtil.generate().toString(),
        username: 'test-webhook',
        discriminator: '0000',
        global_name: null,
        avatar: null,
        bot: true,
    };
}

/** Discord stamps every embed a bot sends as `rich`. */
function richEmbed(embed: APIEmbed): APIEmbed {
    return { ...structuredClone(embed), type: EmbedType.Rich };
}

const ATTACHMENT_SCHEME = 'attachment://';

function isAttachmentLink(link: string): boolean {
    return link.startsWith(ATTACHMENT_SCHEME);
}

/** Every link and picture an embed carries: its title link, header icon, thumbnail, image and footer icon. */
function embedLinks(embed: APIEmbed): string[] {
    return [embed.url, embed.author?.icon_url, embed.thumbnail?.url, embed.image?.url, embed.footer?.icon_url].filter(
        (link): link is string => link !== undefined
    );
}

/**
 * Refuse files the harness cannot model: a payload whose `attachments` do not list each
 * uploaded file exactly once by its index, and an embed pointing at `attachment://<name>`
 * where no file the same request uploads has that name. A send or an edit alike.
 */
function checkFiles(draft: Pick<MessageDraft, 'attachments' | 'embeds'>, files: readonly MessageFile[]): void {
    const listed = (draft.attachments ?? []).map((attachment) => Number(attachment.id)).sort((left, right) => left - right);
    const uploaded = files.map((file) => file.index).sort((left, right) => left - right);
    if (listed.length !== uploaded.length || listed.some((index, position) => index !== uploaded[position])) {
        throw new TestDiscordError(
            `TestDiscord received attachments [${listed.join(', ')}] for files [${uploaded.join(', ')}]. A message whose attachments do not match its files is not modelled.`
        );
    }

    const names = new Set(files.map((file) => file.name));
    for (const link of (draft.embeds ?? []).flatMap(embedLinks)) {
        if (isAttachmentLink(link) && !names.has(link.slice(ATTACHMENT_SCHEME.length))) {
            throw new TestDiscordError(
                `TestDiscord received an embed pointing at ${link}, but no uploaded file is named that. What Discord does with it is not modelled.`
            );
        }
    }
}

/** An uploaded file as Discord stores it on the message, with a CDN-shaped link that leads nowhere. */
function storedAttachment(channelId: string, file: MessageFile): APIAttachment {
    const id = SnowflakeUtil.generate().toString();
    const path = `attachments/${channelId}/${id}/${encodeURIComponent(file.name)}`;
    return {
        id,
        filename: file.name,
        size: file.bytes.length,
        url: `https://cdn.discordapp.com/${path}`,
        proxy_url: `https://media.discordapp.net/${path}`,
        content_type: file.contentType,
    };
}
