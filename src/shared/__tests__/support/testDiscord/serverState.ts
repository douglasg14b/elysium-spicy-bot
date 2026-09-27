import {
    ApplicationFlags,
    ChannelType,
    GatewayDispatchEvents,
    GuildDefaultMessageNotifications,
    GuildExplicitContentFilter,
    GuildMemberFlags,
    GuildMFALevel,
    GuildNSFWLevel,
    GuildPremiumTier,
    GuildSystemChannelFlags,
    GuildVerificationLevel,
    Locale,
    PermissionsBitField,
    RoleFlags,
    SnowflakeUtil,
    type APIGuildCategoryChannel,
    type APIGuildMember,
    type APIOverwrite,
    type APIRole,
    type APITextChannel,
    type APIUser,
    type GatewayChannelPinsUpdateDispatchData,
    type GatewayGuildCreateDispatchData,
    type GatewayGuildMemberAddDispatchData,
    type GatewayGuildRoleModifyDispatchData,
    type GatewayReadyDispatchData,
    type PermissionsString,
} from 'discord.js';
import { ServerMessages } from './messageState';
import type { InjectedRejection } from './restRouter';
import { TestDiscordError } from './testDiscordError';

/**
 * The channel kinds the harness models. Anything else is a gap, and is refused by name.
 *
 * `guild_id` is optional on the API type because some gateway payloads omit it, but every
 * channel Discord sends in a CHANNEL_* dispatch carries it — and discord.js cannot place a
 * channel in its guild without it.
 */
export type ServerChannelPayload = (APITextChannel | APIGuildCategoryChannel) & { guild_id: string };
export type ModelledChannelType = ServerChannelPayload['type'];

/**
 * A gateway dispatch, minus the envelope the gateway adds.
 *
 * Narrower than `GatewayDispatchPayload` on purpose: this is the closed set of events the
 * harness sends, and the gateway's self-check switches over it exhaustively. Adding an
 * event here without teaching the self-check to verify it is a compile error.
 */
export type HarnessEvent =
    | { readonly t: GatewayDispatchEvents.ChannelCreate; readonly d: ServerChannelPayload }
    | { readonly t: GatewayDispatchEvents.ChannelUpdate; readonly d: ServerChannelPayload }
    | { readonly t: GatewayDispatchEvents.ChannelDelete; readonly d: ServerChannelPayload }
    | { readonly t: GatewayDispatchEvents.ChannelPinsUpdate; readonly d: GatewayChannelPinsUpdateDispatchData }
    | { readonly t: GatewayDispatchEvents.GuildRoleCreate; readonly d: GatewayGuildRoleModifyDispatchData }
    | { readonly t: GatewayDispatchEvents.GuildMemberAdd; readonly d: GatewayGuildMemberAddDispatchData }
    | { readonly t: GatewayDispatchEvents.GuildCreate; readonly d: GatewayGuildCreateDispatchData };

/** Where published events go once a client is connected. Before that, nowhere. */
export interface EventSink {
    publish(event: HarnessEvent): void;
}

/** One change to a channel. Absent fields are left alone, exactly as a PATCH treats them. */
export interface ChannelEdit {
    readonly name?: string;
    readonly parentId?: string | null;
    readonly overwrites?: readonly APIOverwrite[];
}

/** A channel to create. Every field is explicit; defaults belong to the caller. */
export interface NewChannel {
    readonly type: ModelledChannelType;
    readonly name: string;
    readonly parentId: string | null;
    readonly overwrites: readonly APIOverwrite[];
}

/** A guild to create, with the bot already installed in it. */
export interface NewGuild {
    readonly name: string;
    readonly botPermissions: readonly PermissionsString[];
}

/** A role to create. `permissions` is a serialised bitfield, as Discord stores it. */
export interface NewRole {
    readonly name: string;
    readonly permissions: string;
}

interface GuildRecord {
    readonly id: string;
    readonly name: string;
    readonly ownerId: string;
    readonly joinedAt: string;
    readonly roles: Map<string, APIRole>;
    readonly members: Map<string, APIGuildMember>;
    readonly channels: Map<string, ServerChannelPayload>;
}

/*
 * discord-api-types declares its flag enums without a zero member, so `0` — which is what
 * Discord actually sends for "no flags" — does not typecheck against them. Cast once each,
 * here, rather than at every payload.
 */
const NO_ROLE_FLAGS = 0 as RoleFlags;
const NO_MEMBER_FLAGS = 0 as GuildMemberFlags;
const NO_SYSTEM_CHANNEL_FLAGS = 0 as GuildSystemChannelFlags;
const NO_APPLICATION_FLAGS = 0 as ApplicationFlags;

/**
 * What `@everyone` may do in a guild the harness creates.
 *
 * An approximation of Discord's default for a new server, not a bit-for-bit copy. It
 * matters more than it looks: Discord only lets a bot allow or deny a permission in an
 * overwrite if the bot holds that permission itself, and the provisioning compiler writes
 * `SendMessagesInThreads` into every overwrite. A fixture guild where the bot lacked it
 * would certify an install that live Discord refuses with a 50013. The harness does not
 * *enforce* that rule (see `ServerChannel.rejectWrites`), so the fixture has to be one
 * Discord would accept.
 */
const EVERYONE_DEFAULT_PERMISSIONS: readonly PermissionsString[] = [
    'CreateInstantInvite',
    'ChangeNickname',
    'ViewChannel',
    'SendMessages',
    'SendMessagesInThreads',
    'CreatePublicThreads',
    'CreatePrivateThreads',
    'EmbedLinks',
    'AttachFiles',
    'AddReactions',
    'UseExternalEmojis',
    'UseExternalStickers',
    'ReadMessageHistory',
    'UseApplicationCommands',
    'Connect',
    'Speak',
    'Stream',
    'UseVAD',
];

/**
 * Characters Discord rewrites in a text channel's name.
 *
 * Discord stores text channel names lowercased with whitespace turned into hyphens. The
 * exact rules are not modelled, so a name that would be rewritten is refused instead of
 * stored verbatim — storing it verbatim would agree with any product code that also
 * assumes the name comes back exactly as sent, which is the shared mistake this harness
 * must not make.
 */
const REWRITTEN_IN_TEXT_NAMES = /[A-Z\s]/;

/** A real snowflake, from the same generator discord.js uses. Always 17–19 digits. */
function newSnowflake(): string {
    return SnowflakeUtil.generate().toString();
}

function permissionBits(names: readonly PermissionsString[]): string {
    return PermissionsBitField.resolve([...names]).toString();
}

function assertStoredVerbatim(type: ModelledChannelType, name: string): void {
    if (type === ChannelType.GuildText && REWRITTEN_IN_TEXT_NAMES.test(name)) {
        throw new TestDiscordError(
            `Discord would rewrite the text channel name "${name}" (it lowercases and hyphenates them), and the harness does not model how. Use a name Discord stores as sent.`
        );
    }
}

/**
 * What Discord holds, as Discord's own JSON.
 *
 * Every record is a canonical `discord-api-types` payload, mutated in place and handed to
 * the client exactly as the real API would serialise it. Nothing is a harness-specific
 * shape, so there is no second model of a channel that could drift from the one discord.js
 * parses.
 *
 * This is the only place server state changes. Both the REST router (the bot acting) and
 * the handles (an operator acting in Discord) call the same primitives, and every
 * primitive publishes the gateway event real Discord would send — so the two routes into
 * the state cannot disagree about what a change looks like to the client. Readers get
 * `Readonly` records, so nothing can change state without publishing.
 */
export class ServerState {
    /** The one bot every guild here has installed. */
    readonly botUser: APIUser;

    /** Every channel's messages. Publishes through this state's sink, so events cannot take a second route. */
    readonly messages = new ServerMessages(this, (event) => this.sink?.publish(event));

    private readonly guilds = new Map<string, GuildRecord>();
    private readonly rejections = new Map<string, InjectedRejection>();
    private sink: EventSink | undefined;
    private nameSequence = 0;

    constructor() {
        this.botUser = {
            id: newSnowflake(),
            username: 'test-bot',
            discriminator: '0000',
            global_name: null,
            avatar: null,
            bot: true,
        };
    }

    /** From here on every change is also dispatched to the connected client. */
    connect(sink: EventSink): void {
        this.sink = sink;
    }

    /** Stop dispatching, so nothing is sent to a client that has been destroyed. */
    disconnect(): void {
        this.sink = undefined;
    }

    get guildIds(): readonly string[] {
        return [...this.guilds.keys()];
    }

    /** A unique default name, so a test that names nothing still gets distinguishable objects. */
    nextName(prefix: string): string {
        this.nameSequence += 1;
        return `${prefix}-${this.nameSequence}`;
    }

    createGuild(input: NewGuild): string {
        const id = newSnowflake();
        const owner = this.newUser('guild-owner');

        const everyone: APIRole = this.newRole({
            // `@everyone`'s id is the guild's id; discord.js resolves it that way.
            id,
            name: '@everyone',
            position: 0,
            permissions: permissionBits(EVERYONE_DEFAULT_PERMISSIONS),
        });
        const botRole: APIRole = {
            ...this.newRole({
                id: newSnowflake(),
                name: this.botUser.username,
                position: 1,
                permissions: permissionBits(input.botPermissions),
            }),
            // What an integration role looks like: Discord creates one per bot on join.
            managed: true,
            tags: { bot_id: this.botUser.id },
        };

        const record: GuildRecord = {
            id,
            name: input.name,
            ownerId: owner.id,
            joinedAt: new Date().toISOString(),
            roles: new Map([
                [everyone.id, everyone],
                [botRole.id, botRole],
            ]),
            members: new Map([
                [owner.id, this.newMember(owner, [])],
                [this.botUser.id, this.newMember(this.botUser, [botRole.id])],
            ]),
            channels: new Map(),
        };
        this.guilds.set(id, record);

        this.sink?.publish({ t: GatewayDispatchEvents.GuildCreate, d: this.guildCreatePayload(id) });
        return id;
    }

    /** `@everyone`'s permissions, which Discord gives a role created without any. */
    everyonePermissions(guildId: string): string {
        return this.role(guildId, guildId).permissions;
    }

    /**
     * Refuse a channel Discord would reject or rewrite. Reads only.
     *
     * Public so the REST router can run it *before* consulting an injected rejection —
     * a refused channel must still be loud about a request the harness cannot model.
     */
    checkNewChannel(guildId: string, input: Pick<NewChannel, 'type' | 'name' | 'parentId'>): void {
        const guild = this.guild(guildId);
        assertStoredVerbatim(input.type, input.name);
        if (input.parentId !== null) this.requireCategory(guild, input.parentId);
        if (input.type === ChannelType.GuildCategory && input.parentId !== null) {
            throw new TestDiscordError(
                'A category cannot have a parent. Real Discord rejects this with a 400; the harness refuses rather than guessing at the error body.'
            );
        }
    }

    /** Refuse an edit Discord would reject or rewrite. Reads only; public for the same reason as {@link checkNewChannel}. */
    checkEdit(channelId: string, edit: Pick<ChannelEdit, 'name' | 'parentId'>): void {
        const { guild, channel } = this.locateChannel(channelId);
        if (edit.name !== undefined) assertStoredVerbatim(channel.type, edit.name);
        if (edit.parentId === undefined || edit.parentId === null) return;

        if (channel.type === ChannelType.GuildCategory) {
            throw new TestDiscordError(
                `Channel ${channelId} is a category and cannot be given a parent. Real Discord rejects this with a 400; the harness refuses rather than guessing at the error body.`
            );
        }
        this.requireCategory(guild, edit.parentId);
    }

    addChannel(guildId: string, input: NewChannel): ServerChannelPayload {
        this.checkNewChannel(guildId, input);
        const guild = this.guild(guildId);

        const base = {
            id: newSnowflake(),
            guild_id: guildId,
            name: input.name,
            position: guild.channels.size,
            permission_overwrites: input.overwrites.map((overwrite) => ({ ...overwrite })),
        };

        const channel: ServerChannelPayload =
            input.type === ChannelType.GuildText
                ? {
                      ...base,
                      type: ChannelType.GuildText,
                      parent_id: input.parentId,
                      nsfw: false,
                      topic: null,
                      rate_limit_per_user: 0,
                      last_message_id: null,
                  }
                : { ...base, type: ChannelType.GuildCategory, parent_id: null };

        guild.channels.set(channel.id, channel);
        this.sink?.publish({ t: GatewayDispatchEvents.ChannelCreate, d: structuredClone(channel) });
        return structuredClone(channel);
    }

    editChannel(channelId: string, edit: ChannelEdit): ServerChannelPayload {
        this.checkEdit(channelId, edit);
        const { channel } = this.locateChannel(channelId);

        // A category's parent can only ever be null, which `checkEdit` has established.
        if (edit.parentId !== undefined && channel.type === ChannelType.GuildText) channel.parent_id = edit.parentId;
        if (edit.name !== undefined) channel.name = edit.name;
        if (edit.overwrites !== undefined) {
            channel.permission_overwrites = edit.overwrites.map((overwrite) => ({ ...overwrite }));
        }

        this.sink?.publish({ t: GatewayDispatchEvents.ChannelUpdate, d: structuredClone(channel) });
        return structuredClone(channel);
    }

    /** Create or replace the overwrite for one id, leaving every other overwrite alone. */
    putOverwrite(channelId: string, overwrite: APIOverwrite): void {
        const { channel } = this.locateChannel(channelId);
        const others = (channel.permission_overwrites ?? []).filter((entry) => entry.id !== overwrite.id);
        channel.permission_overwrites = [...others, { ...overwrite }];

        this.sink?.publish({ t: GatewayDispatchEvents.ChannelUpdate, d: structuredClone(channel) });
    }

    removeOverwrite(channelId: string, overwriteId: string): void {
        const { channel } = this.locateChannel(channelId);
        const existing = channel.permission_overwrites ?? [];
        if (!existing.some((entry) => entry.id === overwriteId)) {
            throw new TestDiscordError(
                `Channel ${channelId} has no overwrite for ${overwriteId}, so there is nothing to remove. The test is asking for something that is not there.`
            );
        }
        channel.permission_overwrites = existing.filter((entry) => entry.id !== overwriteId);

        this.sink?.publish({ t: GatewayDispatchEvents.ChannelUpdate, d: structuredClone(channel) });
    }

    /**
     * Refuse a delete the harness cannot model. Reads only; public for the same reason as
     * {@link checkNewChannel}.
     */
    checkDeleteChannel(channelId: string): void {
        const { guild } = this.locateChannel(channelId);

        // Deleting a category orphans its children, which Discord announces as a
        // CHANNEL_UPDATE per child. Unmodelled, so refused rather than half-done.
        const hasChildren = [...guild.channels.values()].some(
            (candidate) => candidate.type === ChannelType.GuildText && candidate.parent_id === channelId
        );
        if (hasChildren) {
            throw new TestDiscordError(
                `Deleting category ${channelId} would orphan its channels, which the harness does not model. Move or delete them first.`
            );
        }
    }

    /** Remove a channel, answering with it as it was: Discord's DELETE returns the deleted channel. */
    deleteChannel(channelId: string): ServerChannelPayload {
        this.checkDeleteChannel(channelId);
        const { guild, channel } = this.locateChannel(channelId);

        guild.channels.delete(channelId);
        this.rejections.delete(channelId);
        this.sink?.publish({ t: GatewayDispatchEvents.ChannelDelete, d: structuredClone(channel) });
        return structuredClone(channel);
    }

    /**
     * Add a role at the top of the list.
     *
     * Positions follow creation order, which is a harness choice: Discord inserts new roles
     * just above `@everyone` and shifts the rest. Nothing tested depends on the order, and
     * modelling the shift would mean GUILD_ROLE_UPDATEs for every role above — so any
     * hierarchy check (`editable`, `highest`) against this state answers a question the
     * harness made up. Model the shift before relying on one.
     */
    addRole(guildId: string, input: NewRole): APIRole {
        const guild = this.guild(guildId);
        const role = this.newRole({
            id: newSnowflake(),
            name: input.name,
            position: guild.roles.size,
            permissions: input.permissions,
        });
        guild.roles.set(role.id, role);

        this.sink?.publish({
            t: GatewayDispatchEvents.GuildRoleCreate,
            d: { guild_id: guildId, role: structuredClone(role) },
        });
        return structuredClone(role);
    }

    addMember(guildId: string, input: { readonly username: string; readonly roleIds: readonly string[] }): APIGuildMember {
        const guild = this.guild(guildId);
        for (const roleId of input.roleIds) this.role(guildId, roleId);

        const member = this.newMember(this.newUser(input.username), input.roleIds);
        guild.members.set(member.user.id, member);

        this.sink?.publish({
            t: GatewayDispatchEvents.GuildMemberAdd,
            d: { ...structuredClone(member), guild_id: guildId },
        });
        return structuredClone(member);
    }

    channel(channelId: string): Readonly<ServerChannelPayload> {
        return this.locateChannel(channelId).channel;
    }

    /**
     * Record a text channel's newest message, or its newest pin, as Discord does on each.
     *
     * No CHANNEL_UPDATE: Discord announces these as MESSAGE_CREATE and CHANNEL_PINS_UPDATE,
     * never as a change to the channel, so this updates what a fetch returns and nothing
     * else. The pin's own event is `ServerMessages`' to publish.
     */
    noteChannelActivity(
        channelId: string,
        activity: { readonly lastMessageId?: string; readonly lastPinTimestamp?: string }
    ): void {
        const { channel } = this.locateChannel(channelId);
        if (channel.type !== ChannelType.GuildText) return;
        if (activity.lastMessageId !== undefined) channel.last_message_id = activity.lastMessageId;
        if (activity.lastPinTimestamp !== undefined) channel.last_pin_timestamp = activity.lastPinTimestamp;
    }

    /** A member of a guild, or undefined when the user is not in it. */
    member(guildId: string, userId: string): Readonly<APIGuildMember> | undefined {
        return this.guild(guildId).members.get(userId);
    }

    /** Every channel in a guild as Discord holds it now, for `GET /guilds/:id/channels`. */
    guildChannels(guildId: string): ServerChannelPayload[] {
        return structuredClone([...this.guild(guildId).channels.values()]);
    }

    hasChannel(channelId: string): boolean {
        return this.findChannel(channelId) !== undefined;
    }

    hasRole(guildId: string, roleId: string): boolean {
        return this.guild(guildId).roles.has(roleId);
    }

    rejectWrites(channelId: string, rejection: InjectedRejection): void {
        this.locateChannel(channelId);
        this.rejections.set(channelId, rejection);
    }

    rejectionFor(channelId: string): InjectedRejection | undefined {
        return this.rejections.get(channelId);
    }

    readyPayload(): GatewayReadyDispatchData {
        return {
            v: 10,
            user: structuredClone(this.botUser),
            // Real Discord announces every guild as unavailable in READY, then streams a
            // GUILD_CREATE for each. The harness follows the same sequence.
            guilds: this.guildIds.map((id) => ({ id, unavailable: true })),
            session_id: 'test-discord-session',
            resume_gateway_url: 'wss://gateway.invalid',
            shard: [0, 1],
            application: { id: this.botUser.id, flags: NO_APPLICATION_FLAGS },
        };
    }

    guildCreatePayload(guildId: string): GatewayGuildCreateDispatchData {
        const guild = this.guild(guildId);

        return structuredClone({
            id: guild.id,
            name: guild.name,
            icon: null,
            splash: null,
            discovery_splash: null,
            owner_id: guild.ownerId,
            region: '',
            afk_channel_id: null,
            afk_timeout: 300,
            verification_level: GuildVerificationLevel.None,
            default_message_notifications: GuildDefaultMessageNotifications.AllMessages,
            explicit_content_filter: GuildExplicitContentFilter.Disabled,
            roles: [...guild.roles.values()],
            emojis: [],
            features: [],
            mfa_level: GuildMFALevel.None,
            application_id: null,
            system_channel_id: null,
            system_channel_flags: NO_SYSTEM_CHANNEL_FLAGS,
            rules_channel_id: null,
            vanity_url_code: null,
            description: null,
            banner: null,
            premium_tier: GuildPremiumTier.None,
            preferred_locale: Locale.EnglishUS,
            public_updates_channel_id: null,
            nsfw_level: GuildNSFWLevel.Default,
            stickers: [],
            premium_progress_bar_enabled: false,
            hub_type: null,
            safety_alerts_channel_id: null,
            incidents_data: null,
            joined_at: guild.joinedAt,
            large: false,
            unavailable: false,
            member_count: guild.members.size,
            voice_states: [],
            members: [...guild.members.values()],
            channels: [...guild.channels.values()],
            threads: [],
            presences: [],
            stage_instances: [],
            guild_scheduled_events: [],
            soundboard_sounds: [],
        });
    }

    private guild(guildId: string): GuildRecord {
        const guild = this.guilds.get(guildId);
        if (!guild) {
            throw new TestDiscordError(`TestDiscord holds no guild ${guildId}.`);
        }
        return guild;
    }

    private role(guildId: string, roleId: string): APIRole {
        const role = this.guild(guildId).roles.get(roleId);
        if (!role) {
            throw new TestDiscordError(`Guild ${guildId} holds no role ${roleId}.`);
        }
        return role;
    }

    private findChannel(
        channelId: string
    ): { readonly guild: GuildRecord; readonly channel: ServerChannelPayload } | undefined {
        for (const guild of this.guilds.values()) {
            const channel = guild.channels.get(channelId);
            if (channel) return { guild, channel };
        }
        return undefined;
    }

    private locateChannel(channelId: string): { readonly guild: GuildRecord; readonly channel: ServerChannelPayload } {
        const found = this.findChannel(channelId);
        if (!found) {
            throw new TestDiscordError(`TestDiscord holds no channel ${channelId}.`);
        }
        return found;
    }

    private requireCategory(guild: GuildRecord, channelId: string): void {
        const parent = guild.channels.get(channelId);
        if (parent?.type !== ChannelType.GuildCategory) {
            throw new TestDiscordError(
                `${channelId} is not a category in guild ${guild.id}, so nothing can be placed under it. Real Discord rejects this with a 400; the harness refuses rather than guessing at the error body.`
            );
        }
    }

    private newUser(username: string): APIUser {
        return { id: newSnowflake(), username, discriminator: '0000', global_name: null, avatar: null };
    }

    private newMember(user: APIUser, roleIds: readonly string[]): APIGuildMember {
        return {
            user: structuredClone(user),
            roles: [...roleIds],
            joined_at: new Date().toISOString(),
            deaf: false,
            mute: false,
            flags: NO_MEMBER_FLAGS,
        };
    }

    private newRole(input: {
        readonly id: string;
        readonly name: string;
        readonly position: number;
        readonly permissions: string;
    }): APIRole {
        return {
            ...input,
            color: 0,
            hoist: false,
            managed: false,
            mentionable: false,
            flags: NO_ROLE_FLAGS,
        };
    }
}
