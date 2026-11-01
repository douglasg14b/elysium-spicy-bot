import {
    Events,
    GatewayDispatchEvents,
    GatewayOpcodes,
    GuildChannel,
    Status,
    type Client,
    type GatewayDispatchPayload,
    type Interaction,
} from 'discord.js';
import type { EventDeferral } from './restRouter';
import type { EventSink, HarnessEvent, ServerChannelPayload, ServerState } from './serverState';
import { TestDiscordError } from './testDiscordError';

/**
 * Gateway dispatch into a real discord.js client, with no socket.
 *
 * Packets go through discord.js's own `handlePacket`, so the client's packet handlers,
 * actions and caches are the real ones. What the harness adds is the check discord.js does
 * not make: **after every dispatch, the client's cache must actually reflect it.**
 *
 * That check exists because of one trap. Until the client's gateway status is `Ready`,
 * `handlePacket` quietly queues every dispatch outside a short whitelist — CHANNEL_UPDATE,
 * CHANNEL_CREATE and GUILD_ROLE_CREATE among them — and returns without error. A harness
 * that trusted the dispatch would then run a test against a cache that never changed, and
 * a silent no-op there reads exactly like a passing test. `handlePacket` does return false
 * when it queues, so the harness reads that first and checks the cache on the rest.
 */

/**
 * The slice of discord.js's gateway internals the harness drives.
 *
 * Both members are private in the typings (`WebSocketManager#handlePacket` and
 * `#triggerClientReady`). They are the only way to feed a dispatch into a client without
 * a socket, and the one cast that reaches them is confined to {@link internalsOf}.
 */
interface GatewayInternals {
    handlePacket(packet: GatewayDispatchPayload, shard: ShardStub): boolean;
    triggerClientReady(): void;
}

/**
 * What discord.js's packet handlers read off the shard a dispatch arrived on.
 *
 * READY calls `checkReady()`, GUILD_CREATE reads `id` and GUILD_MEMBER_ADD reads `status`.
 * A real `WebSocketShard` would start readiness timers of its own, which is why it is not
 * used. `checkReady` does nothing because readiness is driven explicitly in
 * {@link GatewayLink.connect}.
 */
interface ShardStub {
    readonly id: number;
    readonly status: Status;
    checkReady(): void;
    /**
     * What the bot sends up the gateway. `guild.members.fetch()` with no id, or with many,
     * sends a RequestGuildMembers here (through `guild.shard`, looked up in `client.ws.shards`).
     */
    send(payload: GatewayShardPayload): void;
}

/** A payload the bot sends up the gateway, as discord.js hands it to a shard. */
interface GatewayShardPayload {
    readonly op: GatewayOpcodes;
    readonly d?: unknown;
}

/** RequestGuildMembers as discord.js sends it (`GuildMemberManager#_fetchMany`). */
interface RequestGuildMembersData {
    readonly guild_id: string;
    readonly user_ids?: string | readonly string[];
    readonly query?: string;
    readonly limit?: number;
    readonly presences?: boolean;
    readonly nonce?: string;
}

function internalsOf(client: Client): GatewayInternals {
    // Private members, reached on purpose — see GatewayInternals. Casts stay in the harness.
    return client.ws as unknown as GatewayInternals;
}

/**
 * Put `shard` where `guild.shard` finds it. A client that never logged in has no shards,
 * so without this every gateway send throws before reaching the harness.
 */
function installShard(client: Client, shard: ShardStub): void {
    // A stub in place of discord.js's `WebSocketShard`. Casts stay in the harness.
    (client.ws.shards as unknown as Map<number, ShardStub>).set(shard.id, shard);
}

/** Why the client's copy of a channel differs from Discord's, or undefined if it does not. */
function describeChannelMismatch(client: Client, channel: ServerChannelPayload): string | undefined {
    const cached = client.channels.cache.get(channel.id);
    if (!cached) return `the client holds no channel ${channel.id}`;
    if (!(cached instanceof GuildChannel)) return `the client holds ${channel.id} as a non-guild channel`;

    const differences: string[] = [];
    if (cached.type !== channel.type) differences.push(`type is ${cached.type}, Discord holds ${channel.type}`);
    if (cached.name !== channel.name) differences.push(`name is "${cached.name}", Discord holds "${channel.name}"`);

    const parentId = channel.parent_id ?? null;
    if (cached.parentId !== parentId) differences.push(`parent is ${cached.parentId}, Discord holds ${parentId}`);

    const overwrites = channel.permission_overwrites ?? [];
    if (cached.permissionOverwrites.cache.size !== overwrites.length) {
        differences.push(
            `${cached.permissionOverwrites.cache.size} overwrites cached, Discord holds ${overwrites.length}`
        );
    }
    for (const overwrite of overwrites) {
        const held = cached.permissionOverwrites.cache.get(overwrite.id);
        const agrees =
            held?.type === overwrite.type &&
            held.allow.bitfield === BigInt(overwrite.allow) &&
            held.deny.bitfield === BigInt(overwrite.deny);
        if (!agrees) differences.push(`overwrite ${overwrite.id} differs`);
    }

    return differences.length > 0 ? `channel ${channel.id}: ${differences.join('; ')}` : undefined;
}

/** Why the client does not reflect an event it was just sent, or undefined if it does. */
function describeMismatch(client: Client, event: HarnessEvent): string | undefined {
    switch (event.t) {
        case GatewayDispatchEvents.ChannelCreate:
        case GatewayDispatchEvents.ChannelUpdate:
            return describeChannelMismatch(client, event.d);

        case GatewayDispatchEvents.ChannelDelete:
            return client.channels.cache.has(event.d.id) ? `the client still holds channel ${event.d.id}` : undefined;

        case GatewayDispatchEvents.ChannelPinsUpdate: {
            const channel = client.channels.cache.get(event.d.channel_id);
            const expected = event.d.last_pin_timestamp ? Date.parse(event.d.last_pin_timestamp) : null;
            if (!channel?.isTextBased() || !('lastPinTimestamp' in channel)) {
                return `the client holds no text channel ${event.d.channel_id} to record a pin on`;
            }
            return channel.lastPinTimestamp === expected
                ? undefined
                : `channel ${event.d.channel_id} records its last pin at ${channel.lastPinTimestamp}, Discord holds ${expected}`;
        }

        case GatewayDispatchEvents.GuildRoleCreate: {
            const role = client.guilds.cache.get(event.d.guild_id)?.roles.cache.get(event.d.role.id);
            return role?.name === event.d.role.name ? undefined : `the client holds no role ${event.d.role.id}`;
        }

        case GatewayDispatchEvents.GuildMemberAdd:
            return client.guilds.cache.get(event.d.guild_id)?.members.cache.has(event.d.user.id)
                ? undefined
                : `the client holds no member ${event.d.user.id}`;

        case GatewayDispatchEvents.GuildMemberUpdate: {
            const member = client.guilds.cache.get(event.d.guild_id)?.members.cache.get(event.d.user.id);
            if (!member) return `the client holds no member ${event.d.user.id}`;
            const agrees =
                member.nickname === (event.d.nick ?? null) &&
                member.user.username === event.d.user.username &&
                member.user.globalName === event.d.user.global_name;
            return agrees ? undefined : `member ${event.d.user.id} does not carry the nickname or names Discord sent`;
        }

        case GatewayDispatchEvents.GuildMembersChunk: {
            const cache = client.guilds.cache.get(event.d.guild_id)?.members.cache;
            const missing = event.d.members.filter((member) => !cache?.has(member.user.id));
            return missing.length === 0 ? undefined : `the client holds no member ${missing[0]?.user.id} from the chunk`;
        }

        // Holds whether or not discord.js emitted anything: an uncached member with no
        // GuildMember partial is dropped without touching the cache, and that is the
        // case a consumer's own assertion has to catch, not this one.
        case GatewayDispatchEvents.GuildMemberRemove:
            return client.guilds.cache.get(event.d.guild_id)?.members.cache.has(event.d.user.id)
                ? `the client still holds member ${event.d.user.id}`
                : undefined;

        case GatewayDispatchEvents.GuildCreate: {
            const guild = client.guilds.cache.get(event.d.id);
            if (!guild?.available) return `guild ${event.d.id} is not available in the client`;
            // discord.js caches active threads in `guild.channels` beside the channels.
            const held = event.d.channels.length + event.d.threads.length;
            if (guild.channels.cache.size !== held) {
                return `guild ${event.d.id} has ${guild.channels.cache.size} channels and threads cached, Discord holds ${held}`;
            }
            return guild.members.me ? undefined : `guild ${event.d.id} has no cached member for the bot`;
        }

        case GatewayDispatchEvents.MessageCreate: {
            // `lastMessageId` rather than the message cache: discord.js moves it on every
            // MESSAGE_CREATE it applies, whatever the client's cache limits keep.
            const channel = client.channels.cache.get(event.d.channel_id);
            if (!channel?.isTextBased()) return `the client holds no text channel ${event.d.channel_id}`;
            return channel.lastMessageId === event.d.id
                ? undefined
                : `channel ${event.d.channel_id} records its last message as ${channel.lastMessageId}, Discord sent ${event.d.id}`;
        }

        case GatewayDispatchEvents.MessageUpdate: {
            const channel = client.channels.cache.get(event.d.channel_id);
            if (!channel?.isTextBased()) return `the client holds no text channel ${event.d.channel_id}`;
            const cached = channel.messages.cache.get(event.d.id);
            // Nothing to hold it to. A queued update never gets here (`deliver` reads the
            // queue signal first), so this is discord.js dropping an update for a message
            // it does not hold — as it does without message partials; with them it builds
            // one and caches it, and that copy is checked below.
            if (!cached) return undefined;
            // discord.js keeps an existing edit time when the event carries none, so only
            // a present one is held to.
            const editAgrees =
                !event.d.edited_timestamp || cached.editedTimestamp === Date.parse(event.d.edited_timestamp);
            const agrees = cached.content === event.d.content && cached.pinned === event.d.pinned && editAgrees;
            return agrees ? undefined : `message ${event.d.id} does not carry the content, pin or edit time Discord sent`;
        }

        case GatewayDispatchEvents.MessageDelete: {
            const channel = client.channels.cache.get(event.d.channel_id);
            if (!channel?.isTextBased()) return `the client holds no text channel ${event.d.channel_id}`;
            return channel.messages.cache.has(event.d.id) ? `the client still holds message ${event.d.id}` : undefined;
        }

        // discord.js caches no interaction, only the presser as a member; whether it emitted
        // the press at all is checked in `deliver`, which listened for it.
        case GatewayDispatchEvents.InteractionCreate: {
            const userId = event.d.member.user.id;
            return client.guilds.cache.get(event.d.guild_id)?.members.cache.has(userId)
                ? undefined
                : `the client holds no member ${userId} for the press`;
        }

        default: {
            const unverified: never = event;
            throw new TestDiscordError(`No self-check exists for ${JSON.stringify(unverified)}.`);
        }
    }
}

/**
 * Listen, for the length of one dispatch, for discord.js emitting the interaction `id`.
 * Emission is synchronous inside `handlePacket`, so by the time it returns the answer is in.
 */
function listenForInteraction(client: Client, id: string): { emitted(): boolean; stop(): void } {
    let emitted = false;
    const listener = (interaction: Interaction): void => {
        if (interaction.id === id) emitted = true;
    };
    client.on(Events.InteractionCreate, listener);
    return {
        emitted: () => emitted,
        stop: () => {
            client.off(Events.InteractionCreate, listener);
        },
    };
}

/**
 * The connection between server state and one client. Every delivered event is verified.
 *
 * ## When events arrive
 *
 * The gateway is one ordered stream, so events are delivered in the order they happened.
 * What varies is *when*:
 *
 *  - An **operator action** in a test is delivered immediately, having first delivered
 *    anything still pending — nothing that happened earlier can arrive later.
 *  - A change caused by a **REST write** is held back until the test calls
 *    `TestDiscord.flushGateway()` or acts as an operator. Discord answers the request and
 *    announces the change independently, with no ordering between the two, so delivering
 *    the event before the response resolved would promise the client something Discord
 *    never does. The visible case is the permission PUT: Discord answers 204, discord.js
 *    leaves its cache alone, and the change reaches the cache only with the event.
 */
export class GatewayLink implements EventSink, EventDeferral {
    private sequence = 0;
    private client: Client | undefined;
    private deferring = 0;
    private readonly pending: HarnessEvent[] = [];
    private readonly shard: ShardStub = {
        id: 0,
        status: Status.Ready,
        // Readiness is driven explicitly in `connect`; a real shard would start timers.
        checkReady: () => undefined,
        send: (payload) => this.answer(payload),
    };

    constructor(private readonly state: ServerState) {}

    /**
     * The handshake real Discord performs: READY announcing every guild as unavailable, a
     * GUILD_CREATE for each, then the client marked ready by discord.js's own code.
     */
    connect(client: Client): void {
        this.client = client;
        installShard(client, this.shard);

        this.send({
            op: GatewayOpcodes.Dispatch,
            s: this.nextSequence(),
            t: GatewayDispatchEvents.Ready,
            d: this.state.readyPayload(),
        });
        if (client.user?.id !== this.state.botUser.id) {
            throw new TestDiscordError('READY was dispatched but the client did not adopt the bot user.');
        }

        for (const guildId of this.state.guildIds) {
            this.publish({ t: GatewayDispatchEvents.GuildCreate, d: this.state.guildCreatePayload(guildId) });
        }

        internalsOf(client).triggerClientReady();
    }

    publish(event: HarnessEvent): void {
        if (this.deferring > 0) {
            this.pending.push(event);
            return;
        }
        this.flush();
        this.deliver(event);
    }

    /** Hold back every event `work` causes, for a later {@link flush}. */
    deferDuring<T>(work: () => T): T {
        this.deferring += 1;
        try {
            return work();
        } finally {
            this.deferring -= 1;
        }
    }

    /** Deliver everything pending, oldest first. */
    flush(): void {
        for (let next = this.pending.shift(); next; next = this.pending.shift()) {
            this.deliver(next);
        }
    }

    private deliver(event: HarnessEvent): void {
        const client = this.connectedClient();
        const heard = event.t === GatewayDispatchEvents.InteractionCreate ? listenForInteraction(client, event.d.id) : undefined;
        let applied: boolean;
        try {
            applied = this.send({ op: GatewayOpcodes.Dispatch, s: this.nextSequence(), ...event });
        } finally {
            heard?.stop();
        }

        // `handlePacket` says outright when it queued a dispatch instead of applying it,
        // which the cache alone cannot always show — a dropped MESSAGE_UPDATE and a
        // queued one leave it looking the same. The cache check still runs on everything
        // discord.js did apply. A press leaves nothing in the cache to check, and discord.js
        // drops one it cannot classify without a word, so it must also have been emitted.
        const mismatch = !applied
            ? 'discord.js queued the dispatch instead of applying it'
            : heard && !heard.emitted()
              ? 'discord.js emitted no interactionCreate for it'
              : describeMismatch(client, event);
        if (mismatch) {
            throw new TestDiscordError(
                `TestDiscord dispatched ${event.t} but the client's cache does not reflect it: ${mismatch}. ` +
                    `The client's gateway status is ${Status[client.ws.status]}, and discord.js silently queues ` +
                    'any dispatch outside its before-ready whitelist until that status is Ready. A dispatch that ' +
                    'never applied would read as a passing test, so the harness stops here instead.'
            );
        }
    }

    /**
     * Answer what the bot sent up the gateway. Only a member request is modelled — every
     * member, or the ones named — and anything else is refused by name.
     *
     * Answered on a later turn of the event loop, never inside the send: discord.js starts
     * listening for the chunk only after sending, as it can over a real socket, and the
     * request and its answer are no more ordered against anything else than that.
     */
    private answer(payload: GatewayShardPayload): void {
        if (payload.op !== GatewayOpcodes.RequestGuildMembers) {
            throw new TestDiscordError(`TestDiscord does not model gateway opcode ${GatewayOpcodes[payload.op]} sent by the bot.`);
        }
        const request = payload.d as RequestGuildMembersData;
        if (request.presences || request.query || request.limit) {
            throw new TestDiscordError(
                'TestDiscord models a member request for every member, or for named ids — not a name query, a limit or presences.'
            );
        }
        const userIds =
            request.user_ids === undefined
                ? undefined
                : typeof request.user_ids === 'string'
                  ? [request.user_ids]
                  : request.user_ids;
        const chunk = this.state.membersChunk(request.guild_id, { userIds, nonce: request.nonce });
        setImmediate(() => {
            this.publish({ t: GatewayDispatchEvents.GuildMembersChunk, d: chunk });
        });
    }

    /** Whether discord.js applied the packet — false when it queued it until Ready. */
    private send(packet: GatewayDispatchPayload): boolean {
        return internalsOf(this.connectedClient()).handlePacket(packet, this.shard);
    }

    private connectedClient(): Client {
        if (!this.client) {
            throw new TestDiscordError('The gateway has no client to deliver to. Call TestDiscord.start() first.');
        }
        return this.client;
    }

    private nextSequence(): number {
        this.sequence += 1;
        return this.sequence;
    }
}
