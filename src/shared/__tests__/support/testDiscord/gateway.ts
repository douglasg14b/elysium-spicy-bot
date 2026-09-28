import {
    GatewayDispatchEvents,
    GatewayOpcodes,
    GuildChannel,
    Status,
    type Client,
    type GatewayDispatchPayload,
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
}

const SHARD: ShardStub = { id: 0, status: Status.Ready, checkReady: () => undefined };

function internalsOf(client: Client): GatewayInternals {
    // Private members, reached on purpose — see GatewayInternals. Casts stay in the harness.
    return client.ws as unknown as GatewayInternals;
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

        case GatewayDispatchEvents.GuildCreate: {
            const guild = client.guilds.cache.get(event.d.id);
            if (!guild?.available) return `guild ${event.d.id} is not available in the client`;
            if (guild.channels.cache.size !== event.d.channels.length) {
                return `guild ${event.d.id} has ${guild.channels.cache.size} channels cached, Discord holds ${event.d.channels.length}`;
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

        default: {
            const unverified: never = event;
            throw new TestDiscordError(`No self-check exists for ${JSON.stringify(unverified)}.`);
        }
    }
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

    constructor(private readonly state: ServerState) {}

    /**
     * The handshake real Discord performs: READY announcing every guild as unavailable, a
     * GUILD_CREATE for each, then the client marked ready by discord.js's own code.
     */
    connect(client: Client): void {
        this.client = client;

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
        const applied = this.send({ op: GatewayOpcodes.Dispatch, s: this.nextSequence(), ...event });

        // `handlePacket` says outright when it queued a dispatch instead of applying it,
        // which the cache alone cannot always show — a dropped MESSAGE_UPDATE and a
        // queued one leave it looking the same. The cache check still runs on everything
        // discord.js did apply.
        const mismatch = applied ? describeMismatch(client, event) : 'discord.js queued the dispatch instead of applying it';
        if (mismatch) {
            throw new TestDiscordError(
                `TestDiscord dispatched ${event.t} but the client's cache does not reflect it: ${mismatch}. ` +
                    `The client's gateway status is ${Status[client.ws.status]}, and discord.js silently queues ` +
                    'any dispatch outside its before-ready whitelist until that status is Ready. A dispatch that ' +
                    'never applied would read as a passing test, so the harness stops here instead.'
            );
        }
    }

    /** Whether discord.js applied the packet — false when it queued it until Ready. */
    private send(packet: GatewayDispatchPayload): boolean {
        return internalsOf(this.connectedClient()).handlePacket(packet, SHARD);
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
