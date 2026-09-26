import type { Client, Guild, PermissionsString } from 'discord.js';
import { GatewayLink } from './gateway';
import { ServerGuild } from './handles';
import { createRestTransport, type RecordedRequest, type TransportLog } from './restRouter';
import { ServerState } from './serverState';
import { createTestClient } from './testClient';
import { TestDiscordError } from './testDiscordError';

export interface CreateGuildOptions {
    readonly name?: string;
    /** The bot's side of the guild. Nested because the owner's sketch groups bot setup. */
    readonly bot?: {
        /** What the bot's integration role may do. Absent means only what `@everyone` may. */
        readonly permissions?: readonly PermissionsString[];
    };
}

/**
 * A fake Discord for integration tests: real discord.js, with only the network faked.
 *
 * discord.js does the parsing, caching, `PermissionsBitField` arithmetic and
 * `DiscordAPIError` construction for real. The fake is "HTTP request in, JSON out" plus
 * gateway dispatch, and nothing more — because the risk with any fake is one that is wrong
 * in the same direction as the code, and the less it models the less it can share a
 * mistake with.
 *
 * Build state with {@link createGuild} and the handles it returns, then {@link start} a
 * client. The same builders work before and after start; after it, each also dispatches
 * the gateway event real Discord would, and verifies the client applied it.
 *
 * **Gateway events caused by the bot's own REST writes are held back** until
 * {@link flushGateway} or the next operator action, because Discord makes no promise that
 * they arrive before the REST response does. A test that reads the client's cache after a
 * write whose response carries no body — a permission PUT — must flush first, and saying
 * so in the test is the point.
 *
 * Assert on the handles, which read what Discord holds, rather than on the client's cache.
 */
export class TestDiscord {
    private readonly state = new ServerState();
    private readonly log: TransportLog = { requests: [], faults: [] };
    private readonly gateway = new GatewayLink(this.state);
    private client: Client<true> | undefined;

    /** Every request the bot sent, in order, including ones Discord rejected. */
    get requests(): readonly RecordedRequest[] {
        return this.log.requests;
    }

    /** Every write the bot sent that names this object — any non-GET request whose path carries its id. */
    writesTo(target: { readonly id: string }): readonly RecordedRequest[] {
        return this.log.requests.filter(
            (request) => request.method !== 'GET' && request.path.split('/').includes(target.id)
        );
    }

    /** A new guild with the bot installed. Dispatched as a GUILD_CREATE if the client is already running. */
    createGuild(options: CreateGuildOptions = {}): ServerGuild {
        const id = this.state.createGuild({
            name: options.name ?? this.state.nextName('guild'),
            botPermissions: options.bot?.permissions ?? [],
        });
        return new ServerGuild(this.state, id);
    }

    /**
     * Connect a client: gateway handshake, then every later change is dispatched to it.
     *
     * Takes no bot yet. Provisioning drives service functions with a `Guild` rather than
     * booting the bot, so this returns the client for {@link clientGuild} to read from.
     */
    async start(): Promise<Client<true>> {
        if (this.client) {
            throw new TestDiscordError('TestDiscord is already started.');
        }

        const client = createTestClient(createRestTransport(this.state, this.log, this.gateway));
        try {
            this.gateway.connect(client);
        } catch (error) {
            await client.destroy();
            throw error;
        }

        if (!client.isReady()) {
            await client.destroy();
            throw new TestDiscordError(
                'The client did not become ready after the gateway handshake, so every later dispatch would be silently queued.'
            );
        }

        this.state.connect(this.gateway);
        this.client = client;
        return client;
    }

    /** The connected client's own `Guild` for a server-side guild — what product code is handed. */
    clientGuild(guild: ServerGuild): Guild {
        if (!this.client) {
            throw new TestDiscordError('TestDiscord has not been started, so there is no client guild yet.');
        }
        const cached = this.client.guilds.cache.get(guild.id);
        if (!cached) {
            throw new TestDiscordError(`The client holds no guild ${guild.id}.`);
        }
        return cached;
    }

    /** Deliver the gateway events Discord has sent for the bot's REST writes, oldest first, each verified. */
    flushGateway(): void {
        this.gateway.flush();
    }

    /**
     * Deliver anything still held back, destroy the client, then fail if the harness
     * faulted along the way.
     *
     * The final flush is so no event escapes its self-check just because the test ended
     * before asking for it. The rethrow is what makes a harness gap loud even when product
     * code caught it: a request with no handler throws inside discord.js, and a service
     * that turns errors into a `failure` string would otherwise report it as an ordinary
     * failed apply.
     */
    async destroy(): Promise<void> {
        if (this.client) {
            try {
                this.gateway.flush();
            } catch (error) {
                this.log.faults.push(error instanceof Error ? error : new TestDiscordError(String(error)));
            }
        }
        this.state.disconnect();
        await this.client?.destroy();
        this.client = undefined;

        const faults = this.log.faults.splice(0);
        if (faults.length > 0) {
            throw new TestDiscordError(
                `TestDiscord faulted ${faults.length} time(s) while answering requests, possibly inside a catch in product code:\n` +
                    faults.map((fault) => `  - ${fault.message}`).join('\n')
            );
        }
    }
}
