import { ChannelType, OverwriteType, RESTJSONErrorCodes, type RESTOptions } from 'discord.js';
import { z } from 'zod';
import type { ServerState } from './serverState';
import { TestDiscordError } from './testDiscordError';

/**
 * The REST edge: an HTTP request in, Discord's JSON out.
 *
 * Plugged into discord.js through `RESTOptions.makeRequest`, which is per-client and
 * touches no global dispatcher — so suites run in parallel without sharing an intercept,
 * and nothing here can reach the network.
 *
 * **Only the routes provisioning actually calls are modelled**, and every request body is
 * parsed strictly. An unmatched route, or a body carrying a field no handler models,
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
} as const;

/** The routes that write to one channel, and so the ones a channel's rejection can scope to. */
export type ChannelWriteRoute = 'PATCH /channels/:channelId' | 'PUT /channels/:channelId/permissions/:overwriteId';

export interface InjectedRejection {
    readonly code: keyof typeof INJECTABLE_REJECTIONS;
    /**
     * Refuse only this route. Absent refuses every write to the channel.
     *
     * Scoping is what makes a *partial* failure expressible: a rename that lands followed
     * by a permission write that does not.
     */
    readonly route?: ChannelWriteRoute;
}

type RouteResponse = { readonly status: 200 | 201; readonly body: unknown } | { readonly status: 204 };

type RouteKey = `${'GET' | 'POST' | 'PATCH' | 'PUT'} /${string}`;
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
    prepare(state: ServerState, params: RouteParams, rawBody: unknown): PreparedWrite;
}

interface RouteDefinition<Body> {
    readonly key: RouteKey;
    readonly schema: z.ZodType<Body>;
    /** Every refusal beyond the schema. Reads state only; throws to refuse. */
    validate?(state: ServerState, params: RouteParams, body: Body): void;
    apply(state: ServerState, params: RouteParams, body: Body): RouteResponse;
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
function defineRoute<Body>(definition: RouteDefinition<Body>): Route {
    return {
        key: definition.key,
        prepare(state, params, rawBody) {
            const parsed = definition.schema.safeParse(rawBody);
            if (!parsed.success) {
                throw new TestDiscordError(
                    `TestDiscord's handler for ${definition.key} does not model this request body: ${z.prettifyError(parsed.error)}`
                );
            }
            const body = parsed.data;
            definition.validate?.(state, params, body);
            return () => definition.apply(state, params, body);
        },
    };
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
];

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
    return !rejection.route || rejection.route === route.key ? rejection : undefined;
}

function answer(state: ServerState, method: string, path: string, rawBody: unknown): { status: number; response: Response } {
    for (const route of ROUTES) {
        const params = matchRoute(route, method, path);
        if (!params) continue;

        // Checked first, so an unmodelled request is loud even on a channel told to refuse.
        const write = route.prepare(state, params, rawBody);

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
        let body: unknown;

        try {
            body = parseBody(init.body, method, path);
            const { status, response } = deferral.deferDuring(() => answer(state, method, path, body));
            log.requests.push({ method, path, body, status });
            return asRestResponse(response);
        } catch (error) {
            // Every throw here is the harness's own — a gap in what it models, or a request
            // it refuses to guess at — never a Discord answer, which is always a response.
            log.requests.push({ method, path, body });
            log.faults.push(error instanceof Error ? error : new TestDiscordError(String(error)));
            throw error;
        }
    };
}
