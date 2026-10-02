import { ChannelType, OverwriteType, RESTJSONErrorCodes, type RESTOptions } from 'discord.js';
import { z } from 'zod';
import { createMessageSchema, editMessageSchema } from './messageSchemas';
import type { ServerState } from './serverState';
import { TestDiscordError } from './testDiscordError';

/**
 * The REST edge: an HTTP request in, Discord's JSON out.
 *
 * Plugged into discord.js through `RESTOptions.makeRequest`, which is per-client and
 * touches no global dispatcher — so suites run in parallel without sharing an intercept,
 * and nothing here can reach the network.
 *
 * **Only the routes provisioning, the ticket lifecycle and activity's backfill actually call are modelled**, and
 * every request body and query string is parsed strictly. An unmatched route, or a body carrying a field no handler models,
 * throws a {@link TestDiscordError} naming it. The alternative — a quiet 404 or an empty
 * success — would turn a new API call in product code into a passing test, which is the
 * exact failure this harness exists to prevent. Add a route when a test needs one.
 *
 * The schemas describe what **discord.js 14 puts on the wire**, which is narrower than
 * what Discord accepts: the permission PUT, for one, carries an `id` Discord ignores.
 * Mirroring the client is the point — a new field in its output is a new behaviour to
 * model, not noise to tolerate.
 */

/** One request the bot sent, as it crossed the wire. */
export interface RecordedRequest {
    readonly method: string;
    /** The API path without the version prefix, e.g. `/channels/123`. */
    readonly path: string;
    /** The query string's parameters. Absent when the request carried none. */
    readonly query?: Readonly<Record<string, string>>;
    /** The parsed JSON body, or undefined when none was sent. */
    readonly body: unknown;
    /** What the harness answered with. Absent when the request hit a harness gap. */
    readonly status?: number;
}

/** Where the transport writes what it saw. Owned by `TestDiscord`. */
export interface TransportLog {
    readonly requests: RecordedRequest[];
    /**
     * Harness faults raised while answering a request.
     *
     * Kept as well as thrown, because the throw lands inside product code and product
     * code catches errors by design — `applyInstallPlan` turns one into a `failure`
     * string. A gap swallowed there would look like an ordinary failed apply, so
     * `TestDiscord.destroy()` rethrows anything recorded here.
     */
    readonly faults: Error[];
}

/**
 * Holds back the gateway events a REST write causes until the test asks for them.
 *
 * Discord answers a REST call and announces the change over the gateway independently,
 * with no ordering between the two. Delivering the event *before* the response resolved
 * would promise the client something Discord never does — most visibly after a permission
 * PUT, which Discord answers with a bare 204 so that discord.js's cache changes only when
 * the event arrives.
 */
export interface EventDeferral {
    deferDuring<T>(work: () => T): T;
}

/**
 * The failures a test may inject, and what Discord answers with for each.
 *
 * A table rather than a free-form status so an injected failure is always one Discord
 * really sends, with the body `DiscordAPIError` really parses. Add a row when a test needs
 * a new one.
 */
const INJECTABLE_REJECTIONS = {
    [RESTJSONErrorCodes.MissingPermissions]: { status: 403, message: 'Missing Permissions' },
    // What Discord answers a read of a channel the bot can no longer see.
    [RESTJSONErrorCodes.MissingAccess]: { status: 403, message: 'Missing Access' },
} as const;

/** The routes that write to one channel, and so the ones a channel's rejection can scope to. */
export type ChannelWriteRoute = 'PATCH /channels/:channelId' | 'PUT /channels/:channelId/permissions/:overwriteId';

/** The one channel read a rejection can refuse, and only by naming it. */
export type ChannelReadRoute = 'GET /channels/:channelId/messages';

export interface InjectedRejection {
    readonly code: keyof typeof INJECTABLE_REJECTIONS;
    /**
     * Refuse only this route. Absent refuses every write to the channel, and no read.
     *
     * Scoping is what makes a *partial* failure expressible: a rename that lands followed
     * by a permission write that does not. A read is refused only when named here.
     */
    readonly route?: ChannelWriteRoute | ChannelReadRoute;
}

/** The guild-scoped creates a test may make Discord rate-limit once. */
export type GuildCreateRoute = 'POST /guilds/:guildId/channels' | 'POST /guilds/:guildId/roles';

/**
 * Answer the next matching request with one 429, as Discord does.
 *
 * **A test-injected fault, not a model of Discord's limits.** Discord's real buckets,
 * sublimits and reset windows are undocumented in the detail a model would need, and a
 * harness that decided for itself when to throttle would be guessing. What this proves
 * is narrower and certain: that the code under test survives the response Discord sends
 * when it does throttle — status, headers and body as `@discordjs/rest` reads them.
 */
export interface InjectedRateLimit {
    readonly route: GuildCreateRoute;
    /** Sent as `Retry-After`. Keep it short: discord.js really sleeps for it. */
    readonly retryAfterMs: number;
}

/**
 * The 429 Discord sends for an exhausted per-route bucket.
 *
 * The bucket headers matter as much as `Retry-After`. With `X-RateLimit-Remaining: 0`
 * and a reset, `@discordjs/rest` 2.6 marks the route's handler as locally limited and
 * waits out the reset before resending — the path a real per-route limit takes. Without
 * them it reads the response as a *sublimit* and takes a different branch, so a test
 * would prove the retry through code a real bucket never reaches. Seconds, and may be
 * fractional. `X-RateLimit-Scope: user` marks it as this bot's own limit.
 */
function rateLimitResponse(retryAfterMs: number): Response {
    const retryAfter = String(retryAfterMs / 1000);
    return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: retryAfterMs / 1000, global: false }), {
        status: 429,
        headers: {
            'content-type': 'application/json',
            'retry-after': retryAfter,
            'x-ratelimit-limit': '1',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset-after': retryAfter,
            'x-ratelimit-bucket': 'testdiscord-injected',
            'x-ratelimit-scope': 'user',
        },
    });
}

/** The body Discord answers a refusal with, which `DiscordAPIError` parses. */
interface DiscordErrorBody {
    readonly code: RESTJSONErrorCodes;
    readonly message: string;
}

type RouteResponse =
    | { readonly status: 200 | 201; readonly body: unknown }
    | { readonly status: 204 }
    /** Only for an object that does not exist — Discord's answer there is certain; anything else faults. */
    | { readonly status: 404; readonly body: DiscordErrorBody };

type RouteKey = `${'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'} /${string}`;
type RouteParams = Readonly<Record<string, string>>;

/** A checked request, ready to be applied to server state. */
type PreparedWrite = () => RouteResponse;

interface Route {
    /** Method and path template, e.g. `PATCH /channels/:channelId`. */
    readonly key: RouteKey;
    /**
     * Parse and check the request without changing anything, and return the write it
     * describes. Throws on anything the harness does not model.
     */
    prepare(state: ServerState, params: RouteParams, rawBody: unknown, rawQuery: URLSearchParams): PreparedWrite;
}

interface RouteDefinition<Body, Query> {
    readonly key: RouteKey;
    readonly schema: z.ZodType<Body>;
    /**
     * The query string the route models, parsed from its string values. Absent means
     * none: any query parameter at all faults, like an unmodelled body field.
     */
    readonly query?: z.ZodType<Query>;
    /** Every refusal beyond the schema. Reads state only; throws to refuse. */
    validate?(state: ServerState, params: RouteParams, body: Body, query: Query): void;
    apply(state: ServerState, params: RouteParams, body: Body, query: Query): RouteResponse;
}

/**
 * A route whose request is fully checked in a step of its own, so the checks run
 * **before** any injected rejection is consulted.
 *
 * The order matters. Checking the rejection first would answer a rejected channel with a
 * clean 403 whatever the request held, so something unmodelled sent to it would pass
 * silently — precisely in the test that injected the failure. That is why every refusal
 * lives in `validate` rather than inside `apply`.
 */
function defineRoute<Body, Query = undefined>(definition: RouteDefinition<Body, Query>): Route {
    return {
        key: definition.key,
        prepare(state, params, rawBody, rawQuery) {
            const parsed = definition.schema.safeParse(rawBody);
            if (!parsed.success) {
                throw new TestDiscordError(
                    `TestDiscord's handler for ${definition.key} does not model this request body: ${z.prettifyError(parsed.error)}`
                );
            }
            const body = parsed.data;
            const query = parseQuery(definition, rawQuery);
            definition.validate?.(state, params, body, query);
            return () => definition.apply(state, params, body, query);
        },
    };
}

/** The route's query, or a fault naming what it does not model. */
function parseQuery<Body, Query>(definition: RouteDefinition<Body, Query>, rawQuery: URLSearchParams): Query {
    const entries = Object.fromEntries(rawQuery);
    if (!definition.query) {
        if (Object.keys(entries).length > 0) {
            throw new TestDiscordError(
                `TestDiscord's handler for ${definition.key} does not model a query string, and received ?${rawQuery.toString()}.`
            );
        }
        // No schema means the definition's `Query` is its `undefined` default.
        return undefined as Query;
    }
    const parsed = definition.query.safeParse(entries);
    if (!parsed.success) {
        throw new TestDiscordError(
            `TestDiscord's handler for ${definition.key} does not model this query: ${z.prettifyError(parsed.error)}`
        );
    }
    return parsed.data;
}

const snowflake = z.string().regex(/^\d{17,20}$/);

const overwriteSchema = z.strictObject({
    id: snowflake,
    type: z.union([z.literal(OverwriteType.Role), z.literal(OverwriteType.Member)]),
    allow: z.string().regex(/^\d+$/),
    deny: z.string().regex(/^\d+$/),
});

const createChannelSchema = z.strictObject({
    name: z.string().min(1),
    type: z.union([z.literal(ChannelType.GuildText), z.literal(ChannelType.GuildCategory)]),
    parent_id: snowflake.nullable().optional(),
    permission_overwrites: z.array(overwriteSchema).optional(),
});

const editChannelSchema = z.strictObject({
    name: z.string().min(1).optional(),
    parent_id: snowflake.nullable().optional(),
    lock_permissions: z.boolean().optional(),
    permission_overwrites: z.array(overwriteSchema).optional(),
});

const createRoleSchema = z.strictObject({
    name: z.string().min(1),
});

/**
 * `GET /channels/:id/messages?after=&limit=` as discord.js 14 sends it. Query values are
 * strings on the wire. `limit` is Discord's 1–100, defaulting to 50.
 *
 * `cache` is not a Discord parameter: discord.js serialises its own `fetch({ cache })`
 * option onto the query along with the real ones, and Discord ignores it. Mirrored
 * because it is on the wire, not because it means anything here.
 */
const messageHistoryQuerySchema = z
    .strictObject({
        after: snowflake.optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cache: z.enum(['true', 'false']).optional(),
    })
    .transform(({ after, limit }) => ({ ...(after === undefined ? {} : { after }), limit: limit ?? 50 }));

const ROUTES: readonly Route[] = [
    defineRoute({
        /*
         * A read, and the one way to learn what Discord holds without waiting for the
         * gateway: discord.js replaces each cached channel, overwrites included, with what
         * comes back. `previewDrift` calls it for exactly that reason.
         */
        key: 'GET /guilds/:guildId/channels',
        schema: z.undefined(),
        apply(state, params) {
            return { status: 200, body: state.guildChannels(params.guildId) };
        },
    }),
    defineRoute({
        key: 'POST /guilds/:guildId/channels',
        schema: createChannelSchema,
        validate(state, params, body) {
            state.checkNewChannel(params.guildId, { type: body.type, name: body.name, parentId: body.parent_id ?? null });
            /*
             * Omitted and empty mean different things here, and the product relies on the
             * difference: `applyInstallPlan` leaves overwrites undefined so a channel
             * inherits its category's. Whether Discord copies the category's overwrites
             * onto a channel created that way is not modelled, so it is refused rather
             * than quietly turned into "no overwrites".
             */
            if (body.parent_id && !body.permission_overwrites) {
                throw new TestDiscordError(
                    'TestDiscord received a channel create under a category with no permission_overwrites. Whether Discord syncs the category\'s overwrites onto it is not modelled.'
                );
            }
        },
        apply(state, params, body) {
            const channel = state.addChannel(params.guildId, {
                type: body.type,
                name: body.name,
                parentId: body.parent_id ?? null,
                overwrites: body.permission_overwrites ?? [],
            });
            return { status: 201, body: channel };
        },
    }),
    defineRoute({
        key: 'POST /guilds/:guildId/roles',
        schema: createRoleSchema,
        apply(state, params, body) {
            // With no `permissions` field Discord gives the new role @everyone's
            // permissions — its documented default — rather than none.
            const role = state.addRole(params.guildId, {
                name: body.name,
                permissions: state.everyonePermissions(params.guildId),
            });
            return { status: 200, body: role };
        },
    }),
    defineRoute({
        /*
         * Discord answers with the channel as it was, and announces CHANNEL_DELETE. The
         * audit-log reason travels as a header, which the harness does not record.
         *
         * A category that still holds channels is refused: Discord would orphan them with
         * a CHANNEL_UPDATE each, and the harness does not model that cascade.
         */
        key: 'DELETE /channels/:channelId',
        schema: z.undefined(),
        validate(state, params) {
            state.checkDeleteChannel(params.channelId);
        },
        apply(state, params) {
            return { status: 200, body: state.deleteChannel(params.channelId) };
        },
    }),
    defineRoute({
        key: 'PATCH /channels/:channelId',
        schema: editChannelSchema,
        validate(state, params, body) {
            state.checkEdit(params.channelId, { name: body.name, parentId: body.parent_id });
            /*
             * `lock_permissions: true` asks Discord to sync the channel to its category.
             * discord.js computes that sync itself and sends it as `permission_overwrites`
             * whenever it has the category cached, so the harness applies what was sent and
             * nothing more. A lock arriving *without* overwrites would need the harness to
             * decide what Discord syncs to — which the PATCH documentation does not say — so
             * it is refused rather than invented.
             */
            if (body.lock_permissions && !body.permission_overwrites) {
                throw new TestDiscordError(
                    'TestDiscord received lock_permissions: true with no permission_overwrites. What Discord syncs to in that case is not modelled.'
                );
            }
        },
        apply(state, params, body) {
            const channel = state.editChannel(params.channelId, {
                name: body.name,
                parentId: body.parent_id,
                overwrites: body.permission_overwrites,
            });
            return { status: 200, body: channel };
        },
    }),
    defineRoute({
        key: 'PUT /channels/:channelId/permissions/:overwriteId',
        schema: overwriteSchema,
        validate(_state, params, body) {
            if (body.id !== params.overwriteId) {
                throw new TestDiscordError(
                    `PUT /channels/${params.channelId}/permissions/${params.overwriteId} carried a body for ${body.id}.`
                );
            }
        },
        apply(state, params, body) {
            // Discord answers 204 and announces the change over the gateway only — which
            // is why discord.js does not update its cache from this response.
            state.putOverwrite(params.channelId, body);
            return { status: 204 };
        },
    }),
    defineRoute({
        /*
         * A read discord.js makes only when the channel is not in its cache —
         * `guild.channels.fetch(id)` answers from the cache otherwise. So in practice it is
         * how product code finds out a channel is gone: a deleted channel has already left
         * the cache with its CHANNEL_DELETE, and Discord answers the fetch with 10003.
         */
        key: 'GET /channels/:channelId',
        schema: z.undefined(),
        apply(state, params) {
            if (!state.hasChannel(params.channelId)) return unknownChannel();
            return { status: 200, body: structuredClone(state.channel(params.channelId)) };
        },
    }),
    defineRoute({
        /*
         * Discord answers 200 with the message, and announces MESSAGE_CREATE only to a
         * client holding the GuildMessages intent — which the harness client does not,
         * and `DISCORD_CLIENT` does. `ServerMessages` decides which it is owed.
         */
        key: 'POST /channels/:channelId/messages',
        schema: createMessageSchema,
        validate(state, params, body) {
            if (state.hasChannel(params.channelId)) state.messages.checkSend(params.channelId, body);
        },
        apply(state, params, body) {
            if (!state.hasChannel(params.channelId)) return unknownChannel();
            return { status: 200, body: state.messages.send(params.channelId, body) };
        },
    }),
    defineRoute({
        /*
         * A page of history, newest first — see `ServerMessages.history`. Answers for a
         * thread as well as a text channel. `before` and `around` are not modelled, so
         * the strict query refuses them.
         */
        key: 'GET /channels/:channelId/messages',
        schema: z.undefined(),
        query: messageHistoryQuerySchema,
        apply(state, params, _body, query) {
            const channelId = params.channelId ?? '';
            if (!state.hasMessageChannel(channelId)) return unknownChannel();
            return { status: 200, body: state.messages.history(channelId, query) };
        },
    }),
    defineRoute({
        /* Like the channel read: discord.js asks only when the message is not cached. */
        key: 'GET /channels/:channelId/messages/:messageId',
        schema: z.undefined(),
        validate(_state, params) {
            requireMessageId(params);
        },
        apply(state, params) {
            return missingMessage(state, params) ?? {
                status: 200,
                body: state.messages.find(params.channelId, params.messageId),
            };
        },
    }),
    defineRoute({
        key: 'PATCH /channels/:channelId/messages/:messageId',
        schema: editMessageSchema,
        validate(state, params, body) {
            requireMessageId(params);
            if (!missingMessage(state, params)) state.messages.checkEdit(params.channelId, params.messageId, body);
        },
        apply(state, params, body) {
            return missingMessage(state, params) ?? {
                status: 200,
                body: state.messages.edit(params.channelId, params.messageId, body),
            };
        },
    }),
    defineRoute({
        /*
         * The pin route discord.js 14.23 calls; the older `/channels/:id/pins/:id` is
         * deprecated and deliberately not answered, so a client that fell back to it would
         * fault rather than pass. Discord answers 204, posts its pin notice, and announces
         * CHANNEL_PINS_UPDATE, which the Guilds intent delivers.
         */
        key: 'PUT /channels/:channelId/messages/pins/:messageId',
        schema: z.undefined(),
        validate(state, params) {
            if (!missingMessage(state, params)) state.messages.checkPin(params.channelId, params.messageId);
        },
        apply(state, params) {
            const missing = missingMessage(state, params);
            if (missing) return missing;
            state.messages.pin(params.channelId, params.messageId);
            return { status: 204 };
        },
    }),
];

/** Discord's answer for a channel it does not hold: a 404 carrying 10003. */
function unknownChannel(): RouteResponse {
    return { status: 404, body: { code: RESTJSONErrorCodes.UnknownChannel, message: 'Unknown Channel' } };
}

/**
 * Refuse a path whose message segment is not a message id.
 *
 * `/channels/:id/messages/pins` — listing a channel's pins — has the same shape as a
 * single-message path, and answering it as "Unknown Message" would be a plausible default
 * for a call the harness does not model.
 */
function requireMessageId(params: RouteParams): void {
    if (!/^\d{17,20}$/.test(params.messageId ?? '')) {
        throw new TestDiscordError(
            `TestDiscord received /channels/${params.channelId}/messages/${params.messageId}, which does not name a message. That route is not modelled.`
        );
    }
}

/** The 404 for whichever of a message's channel or the message itself Discord does not hold. */
function missingMessage(state: ServerState, params: RouteParams): RouteResponse | undefined {
    const channelId = params.channelId ?? '';
    if (!state.hasChannel(channelId)) return unknownChannel();
    if (!state.messages.find(channelId, params.messageId ?? '')) {
        return { status: 404, body: { code: RESTJSONErrorCodes.UnknownMessage, message: 'Unknown Message' } };
    }
    return undefined;
}

/** Path params when `path` fits the route's template, otherwise undefined. */
function matchRoute(route: Route, method: string, path: string): RouteParams | undefined {
    const [routeMethod, template = ''] = route.key.split(' ');
    if (routeMethod !== method) return undefined;

    const templateParts = template.split('/');
    const pathParts = path.split('/');
    if (templateParts.length !== pathParts.length) return undefined;

    const params: Record<string, string> = {};
    for (const [index, part] of templateParts.entries()) {
        const actual = pathParts[index] ?? '';
        if (part.startsWith(':')) {
            params[part.slice(1)] = actual;
        } else if (part !== actual) {
            return undefined;
        }
    }
    return params;
}

function apiPath(url: string): string {
    return new URL(url).pathname.replace(/^\/api\/v\d+/, '');
}

function parseBody(body: unknown, method: string, path: string): unknown {
    if (body === undefined || body === null) return undefined;
    if (typeof body !== 'string') {
        throw new TestDiscordError(
            `TestDiscord received a non-JSON body for ${method} ${path}. Multipart uploads are not modelled.`
        );
    }
    return JSON.parse(body);
}

function jsonResponse(status: number, payload: unknown): Response {
    // Without `application/json`, @discordjs/rest's parseResponse silently returns an
    // empty buffer instead of the payload.
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/** The injected rejection that applies to this request, if any. */
function rejectionFor(state: ServerState, route: Route, params: RouteParams): InjectedRejection | undefined {
    const rejection = params.channelId ? state.rejectionFor(params.channelId) : undefined;
    if (!rejection) return undefined;
    // A rejection refuses writes. A read of a refused channel still answers, as it would
    // for a bot that may view a channel but not manage it — unless the rejection names
    // that read, as for a bot that lost access to the channel altogether.
    if (route.key.startsWith('GET ')) return rejection.route === route.key ? rejection : undefined;
    return !rejection.route || rejection.route === route.key ? rejection : undefined;
}

function answer(
    state: ServerState,
    method: string,
    path: string,
    rawBody: unknown,
    rawQuery: URLSearchParams
): { status: number; response: Response } {
    for (const route of ROUTES) {
        const params = matchRoute(route, method, path);
        if (!params) continue;

        // Checked first, so an unmodelled request is loud even on a channel told to refuse.
        const write = route.prepare(state, params, rawBody, rawQuery);

        const rateLimit = params.guildId ? state.takeRateLimit(params.guildId, route.key) : undefined;
        if (rateLimit) {
            return { status: 429, response: rateLimitResponse(rateLimit.retryAfterMs) };
        }

        const rejection = rejectionFor(state, route, params);
        if (rejection) {
            const { status, message } = INJECTABLE_REJECTIONS[rejection.code];
            return { status, response: jsonResponse(status, { code: rejection.code, message }) };
        }

        const result = write();
        return result.status === 204
            ? { status: 204, response: new Response(null, { status: 204 }) }
            : { status: result.status, response: jsonResponse(result.status, result.body) };
    }

    throw new TestDiscordError(`TestDiscord has no handler for ${method} ${path}.`);
}

/** A response as `@discordjs/rest` types what `makeRequest` resolves with. */
type RestResponse = Awaited<ReturnType<RESTOptions['makeRequest']>>;

/**
 * Hand a fetch `Response` to discord.js as the type it declares.
 *
 * An identity at runtime, and under the root tsconfig (Node types only) the compiler
 * accepts the value unaided. `web/e2e` compiles this file with the DOM lib loaded as well,
 * and there `Response.body` is the DOM's `ReadableStream` while `@discordjs/rest` types it
 * as `node:stream/web`'s. The two differ only in their declarations: both are Node's fetch
 * `Response` when the tests run. The cast sits here, once, so no other line needs one.
 */
function asRestResponse(response: Response): RestResponse {
    return response as unknown as RestResponse;
}

/**
 * A `makeRequest` that answers from server state and records every request it sees.
 *
 * Gateway events a write causes are held back by `deferral` rather than delivered before
 * the response resolves — see {@link EventDeferral}.
 */
export function createRestTransport(
    state: ServerState,
    log: TransportLog,
    deferral: EventDeferral
): RESTOptions['makeRequest'] {
    return async (url, init) => {
        const method = (init.method ?? 'GET').toUpperCase();
        const path = apiPath(url);
        const searchParams = new URL(url).searchParams;
        const query = searchParams.size > 0 ? { query: Object.fromEntries(searchParams) } : {};
        let body: unknown;

        try {
            body = parseBody(init.body, method, path);
            const { status, response } = deferral.deferDuring(() => answer(state, method, path, body, searchParams));
            log.requests.push({ method, path, ...query, body, status });
            return asRestResponse(response);
        } catch (error) {
            // Every throw here is the harness's own — a gap in what it models, or a request
            // it refuses to guess at — never a Discord answer, which is always a response.
            log.requests.push({ method, path, ...query, body });
            log.faults.push(error instanceof Error ? error : new TestDiscordError(String(error)));
            throw error;
        }
    };
}
