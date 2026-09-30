import {
    ChannelType,
    OverwriteType,
    PermissionsBitField,
    type APIOverwrite,
    type PermissionsString,
} from 'discord.js';
import { toMessageView, type ServerMessageView } from './messageState';
import type { GuildCreateRoute, InjectedRejection } from './restRouter';
import type { ModelledChannelType, ServerState } from './serverState';
import { TestDiscordError } from './testDiscordError';

/** One permission overwrite as Discord holds it, translated to flag names. */
export interface OverwriteView {
    readonly id: string;
    readonly type: 'role' | 'member';
    /** Sorted, so an assertion does not depend on discord.js's flag declaration order. */
    readonly allow: readonly PermissionsString[];
    readonly deny: readonly PermissionsString[];
}

/** What an operator grants or denies when editing one overwrite. */
export interface OverwriteGrant {
    readonly allow?: readonly PermissionsString[];
    readonly deny?: readonly PermissionsString[];
}

export type OverwriteTarget = ServerRole | ServerMember;

function toNames(bits: string): PermissionsString[] {
    return new PermissionsBitField(BigInt(bits)).toArray().sort();
}

function toView(overwrite: APIOverwrite): OverwriteView {
    return {
        id: overwrite.id,
        type: overwrite.type === OverwriteType.Role ? 'role' : 'member',
        allow: toNames(overwrite.allow),
        deny: toNames(overwrite.deny),
    };
}

/** A role Discord holds. Usable wherever an overwrite needs a target. */
export class ServerRole {
    readonly kind = 'role';

    constructor(
        readonly guildId: string,
        readonly id: string
    ) {}
}

/** A member Discord holds, keyed by their user id — which is what an overwrite for them uses. */
export class ServerMember {
    readonly kind = 'member';

    constructor(
        readonly guildId: string,
        readonly id: string
    ) {}
}

/**
 * A channel as Discord holds it: what a test acts on and asserts against.
 *
 * Every getter reads **the server's state**, never the client's cache. That is the point
 * of asserting here — the question a live test answers is "did Discord actually change",
 * and a cache can agree with the code that filled it while the server does not.
 *
 * Every action is an operator doing something in the Discord client. It mutates server
 * state and, once the bot is connected, dispatches the gateway event real Discord would
 * send. Handles hold no state of their own, so two handles for one channel cannot
 * disagree. Permissions are spoken in discord.js flag names, so no test writes a wire
 * field.
 */
export class ServerChannel {
    constructor(
        private readonly state: ServerState,
        readonly guildId: string,
        readonly id: string
    ) {}

    get type(): ModelledChannelType {
        return this.state.channel(this.id).type;
    }

    get name(): string {
        return this.state.channel(this.id).name;
    }

    /** The category this sits under, or null at the top level. */
    get parentId(): string | null {
        return this.state.channel(this.id).parent_id ?? null;
    }

    get overwrites(): readonly OverwriteView[] {
        return (this.state.channel(this.id).permission_overwrites ?? []).map(toView);
    }

    overwriteFor(target: OverwriteTarget): OverwriteView | undefined {
        return this.overwrites.find((overwrite) => overwrite.id === target.id);
    }

    /** Every message Discord holds here, oldest first — the bot's and the notices Discord posts itself. */
    get messages(): readonly ServerMessageView[] {
        // Throws for a channel Discord no longer holds, rather than reading out its old messages.
        this.state.channel(this.id);
        return this.state.messages.inChannel(this.id).map(toMessageView);
    }

    /** One message Discord holds here, as it is now. */
    message(messageId: string): ServerMessageView {
        const found = this.messages.find((message) => message.id === messageId);
        if (!found) {
            throw new TestDiscordError(`Channel ${this.id} holds no message ${messageId}.`);
        }
        return found;
    }

    /** Whether Discord still holds this channel. */
    get exists(): boolean {
        return this.state.hasChannel(this.id);
    }

    /** An operator renaming the channel in Discord. */
    rename(name: string): void {
        this.state.editChannel(this.id, { name });
    }

    /**
     * An operator dragging the channel into a category, or out to the top level.
     *
     * Moves only. The Discord client offers to sync permissions as a separate step, and
     * this does not take it — an operator drag leaves the overwrites exactly as they were.
     */
    moveTo(category: ServerChannel | null): void {
        this.state.editChannel(this.id, { parentId: category?.id ?? null });
    }

    /** An operator setting one overwrite by hand. Every other overwrite is left alone. */
    setOverwrite(target: OverwriteTarget, grant: OverwriteGrant): void {
        this.state.putOverwrite(this.id, {
            id: target.id,
            type: target.kind === 'role' ? OverwriteType.Role : OverwriteType.Member,
            allow: PermissionsBitField.resolve([...(grant.allow ?? [])]).toString(),
            deny: PermissionsBitField.resolve([...(grant.deny ?? [])]).toString(),
        });
    }

    /** An operator deleting one overwrite by hand. */
    removeOverwrite(target: OverwriteTarget): void {
        this.state.removeOverwrite(this.id, target.id);
    }

    delete(): void {
        this.state.deleteChannel(this.id);
    }

    /**
     * Make Discord refuse the bot's writes to this channel from now on — every write, or
     * only one route.
     *
     * Explicit injection, and deliberately the only way a write fails. The harness does
     * **not** reimplement Discord's server-side permission enforcement: a fake that decided
     * for itself when the bot lacks access would encode the same model of Discord's rules
     * the product encodes, and would agree with the product exactly where both are wrong.
     * Whether Discord really refuses a given write is only provable against a live guild.
     * Client-side arithmetic (`permissionsFor(me)`) is real discord.js and needs nothing here.
     */
    rejectWrites(rejection: InjectedRejection): void {
        this.state.rejectWrites(this.id, rejection);
    }
}

/**
 * A guild as Discord holds it, with the bot already installed.
 *
 * The builders work before and after `TestDiscord.start()`. Before, they only populate
 * state; after, each also dispatches the event Discord would send for it.
 */
export class ServerGuild {
    constructor(
        private readonly state: ServerState,
        readonly id: string
    ) {}

    /** `@everyone`, whose id is the guild's own. */
    get everyone(): ServerRole {
        return new ServerRole(this.id, this.id);
    }

    /** The bot's own member in this guild. */
    get bot(): ServerMember {
        return new ServerMember(this.id, this.state.botUser.id);
    }

    /** A handle for a channel Discord holds — including ones the bot created over REST. */
    channel(channelId: string): ServerChannel {
        if (this.state.channel(channelId).guild_id !== this.id) {
            throw new TestDiscordError(`Channel ${channelId} is not in guild ${this.id}.`);
        }
        return new ServerChannel(this.state, this.id, channelId);
    }

    /**
     * Make Discord answer the bot's next create on `route` in this guild with one 429.
     *
     * Explicit injection, like `ServerChannel.rejectWrites`, and for the same reason: the
     * harness does not decide for itself when Discord would throttle. See
     * `InjectedRateLimit` in `restRouter.ts` for what this does and does not prove.
     */
    rateLimitNext(route: GuildCreateRoute, retryAfterMs = 50): void {
        this.state.rateLimitNext(this.id, { route, retryAfterMs });
    }

    /** A handle for a role Discord holds — including ones the bot created over REST. */
    role(roleId: string): ServerRole {
        if (!this.state.hasRole(this.id, roleId)) {
            throw new TestDiscordError(`Guild ${this.id} holds no role ${roleId}.`);
        }
        return new ServerRole(this.id, roleId);
    }

    createCategory(options: { readonly name?: string } = {}): ServerChannel {
        const channel = this.state.addChannel(this.id, {
            type: ChannelType.GuildCategory,
            name: options.name ?? this.state.nextName('category'),
            parentId: null,
            overwrites: [],
        });
        return new ServerChannel(this.state, this.id, channel.id);
    }

    createTextChannel(options: { readonly name?: string; readonly parent?: ServerChannel } = {}): ServerChannel {
        const channel = this.state.addChannel(this.id, {
            type: ChannelType.GuildText,
            name: options.name ?? this.state.nextName('channel'),
            parentId: options.parent?.id ?? null,
            overwrites: [],
        });
        return new ServerChannel(this.state, this.id, channel.id);
    }

    createRole(options: { readonly name?: string; readonly permissions?: readonly PermissionsString[] } = {}): ServerRole {
        const role = this.state.addRole(this.id, {
            name: options.name ?? this.state.nextName('role'),
            permissions: PermissionsBitField.resolve([...(options.permissions ?? [])]).toString(),
        });
        return new ServerRole(this.id, role.id);
    }

    createMember(options: { readonly username?: string; readonly roles?: readonly ServerRole[] } = {}): ServerMember {
        const member = this.state.addMember(this.id, {
            username: options.username ?? this.state.nextName('member'),
            roleIds: (options.roles ?? []).map((role) => role.id),
        });
        return new ServerMember(this.id, member.user.id);
    }
}
