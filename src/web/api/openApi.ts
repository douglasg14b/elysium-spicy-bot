import { OpenAPIHono, z, type RouteConfig, type RouteHandler } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../types';
/**
 * The pieces every router described by the OpenAPI spec shares.
 *
 * A router built with {@link apiRouter} contributes its routes to the spec the dashboard
 * SDK is generated from (`generated/openapi.generated.json`), as long as it is mounted on
 * an `OpenAPIHono` parent: a plain `Hono` parent serves the routes but collects none of
 * their definitions. Unconverted routers are plain `Hono` and mount exactly as before;
 * they add nothing to the spec yet, and each of their routes is on the shrinking
 * `NOT_YET_IN_SPEC` list in `everyRouteInSpec.test.ts`.
 */

/**
 * The one error envelope every route answers with, whoever refuses the request — the
 * handler, the validator, or the auth middleware in front of both.
 */
export const ErrorBodySchema = z
    .object({
        error: z.string(),
    })
    .openapi('ErrorBody');

/**
 * `true` when a wire schema describes exactly a domain type the routes send as it is —
 * each assignable to the other — and `false` otherwise.
 *
 * For a domain type that stays where it lives rather than becoming `z.infer` of its
 * schema: `const matches: SchemaMatches<typeof XSchema, X> = true` fails to compile as
 * soon as either side gains, loses or retypes a member. Both directions, because one
 * alone lets the other side grow a member the spec never mentions — and the top-level
 * member names as well, because an *optional* member added on one side alone passes both.
 * Nested objects get only the assignability half, so a nested type sent as it is wants a
 * check of its own.
 */
export type SchemaMatches<Schema extends z.ZodType, Domain> = [z.infer<Schema>] extends [Domain]
    ? [Domain] extends [z.infer<Schema>]
        ? [Exclude<keyof z.infer<Schema>, keyof Domain> | Exclude<keyof Domain, keyof z.infer<Schema>>] extends [never]
            ? true
            : false
        : false
    : false;

/** A JSON response entry for `schema`. */
export function jsonResponse<Schema extends z.ZodType>(description: string, schema: Schema) {
    return { description, content: { 'application/json': { schema } } } as const;
}

/**
 * A JSON request body for `schema`, **required**. Without `required: true` the validator
 * skips a body whose content type isn't JSON and hands the handler `{}`.
 */
export function jsonBody<Schema extends z.ZodType>(schema: Schema) {
    return { required: true, content: { 'application/json': { schema } } } as const;
}

/** A response entry for one error status, carrying {@link ErrorBodySchema}. */
export function errorBodyResponse(description: string) {
    return jsonResponse(description, ErrorBodySchema);
}

/*
 * The status maps below are deliberately not `as const`. A readonly status key makes
 * `@hono/zod-openapi` drop that entry from the handler's typed responses, so a handler
 * returning `c.json({ error }, 400)` fails to compile against a route that declares it.
 */

/** What `requireAuth` answers before any authed route runs. */
export const AUTHED_ERRORS = {
    401: errorBodyResponse('No valid session.'),
};

/**
 * What `requireAuth` and `requireGuildAccess` answer before any
 * `/api/guilds/{guildId}/...` route runs. Declared on each such route because the
 * middleware sits on the parent, where no route definition can see it, and a client
 * generated from a spec that omits them believes those calls cannot fail.
 *
 * A route that refuses its own input uses {@link GUILD_SCOPED_BODY_ERRORS} instead.
 */
export const GUILD_SCOPED_ERRORS = {
    ...AUTHED_ERRORS,
    400: errorBodyResponse('The server id is missing.'),
    403: errorBodyResponse('The signed-in user may not manage this server.'),
    404: errorBodyResponse('The bot is not in this server.'),
};

/**
 * {@link GUILD_SCOPED_ERRORS} for a route that also refuses its own body. Both refusals
 * are 400s and the spec holds one entry per status, so the one entry names both causes.
 * The 415 is the validator's, for a body sent without a JSON content type; `apiRouter`'s
 * `onError` answers it in the same envelope.
 */
export const GUILD_SCOPED_BODY_ERRORS = {
    ...GUILD_SCOPED_ERRORS,
    400: errorBodyResponse('The body was refused, or the server id is missing.'),
    415: errorBodyResponse('The body was not sent as JSON.'),
};

/** The path parameter every guild-scoped route declares, so the spec names it. */
export const GuildPathSchema = z.object({
    guildId: z.string(),
});

/**
 * What a router's route definitions are handed by {@link apiRouter}: `openapi` and
 * nothing else.
 *
 * `OpenAPIHono` is a `Hono`, so the router itself also has `get`, `post`, `all`, `on` and
 * the rest — and a route declared through any of them is served but never reaches the
 * spec or the SDK. This surface makes that a compile error inside a converted router.
 * `openapi` returns nothing for the same reason: the real method returns the router, and
 * `router.openapi(...).get(...)` would be the same escape one call later.
 *
 * The handler is typed by the library's own `RouteHandler`, so a handler that answers
 * with a status or a body its route does not declare still fails to compile. `openapi` is
 * a property rather than a method on purpose: TypeScript compares method parameters
 * bivariantly, which would let a looser handler type here pass for the real one.
 *
 * Refused at compile time, beyond the plain route methods:
 *  - **`hide: true`**, which serves the route and leaves it out of the spec — the very
 *    escape this type exists to close.
 *  - **Route-level `middleware`**, whose variables `RouteHandler<Route, AppEnv>` would not
 *    put on the handler's context. No converted route needs any; the auth middleware sits
 *    on the parent (`registerApiRoutes`).
 * There is no per-route hook either: refusals are `apiRouter`'s `defaultHook`, one policy
 * for every route. And no `use`, because no converted router needs middleware of its own
 * yet. Add each when a route does.
 */
export interface ApiRouteRegistrar {
    openapi: <Route extends DeclaredRoute>(route: Route, handler: RouteHandler<Route, AppEnv>) => void;
}

/** A route definition the spec will describe: not hidden, and with no route-level middleware. */
type DeclaredRoute = RouteConfig & { hide?: false; middleware?: never };

/**
 * A router whose routes appear in the OpenAPI spec, answering refusals in the
 * `{ error }` envelope the dashboard has always read.
 *
 * `defineRoutes` declares the routes through {@link ApiRouteRegistrar}, which offers
 * `openapi` and nothing else, so no route on this router can bypass the spec. The router
 * comes back as a full `OpenAPIHono`, because that is what `app.route()` mounts — on the
 * production `OpenAPIHono` root, where the spec is collected, and on the plain `Hono` the
 * route tests and the e2e dashboard app use. (A route added to that returned router with
 * `get` and friends is out of this type's reach; `everyRouteInSpec.test.ts` catches it.)
 *
 * `defineRoutes` returns `undefined` rather than `void`, which makes an `async` one a
 * compile error. `app.route()` copies a router's routes at the moment it mounts it, so a
 * route declared after an `await` would be neither served nor in the spec — a loss the
 * gate cannot see, because it compares what is served with what is described.
 *
 * The refusal handling has two halves, both set on the router itself rather than
 * inherited from the root, because
 * the route tests and the e2e dashboard app mount routers on a plain `Hono` — where
 * nothing would be inherited, and a validation failure would reach the browser as the
 * validator's own `{ success, error: ZodError }` shape.
 *
 *  - **`defaultHook`**: a request that fails its schema — body, path or query — answers
 *    with the first issue's message, the same sentence the hand-rolled `safeParse` used
 *    to send, and no `issues`. A flow route's `issues` come from its own handler's 400s
 *    (`FlowRefusal` in `flowBody.ts`), about a graph the schema accepted.
 *  - **`onError`**: malformed JSON (400) and a body without a JSON content type (415)
 *    are thrown by the validator as `HTTPException`s *before* any hook runs, and Hono
 *    would answer them as plain text. Anything else is rethrown untouched, so a real
 *    crash still reaches the parent's error handler — the e2e app's `onFault` included.
 */
export function apiRouter(defineRoutes: (router: ApiRouteRegistrar) => undefined): OpenAPIHono<AppEnv> {
    const router = new OpenAPIHono<AppEnv>({
        defaultHook: (result, c) => {
            if (!result.success) {
                return c.json({ error: result.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
            }
        },
    });

    router.onError((error, c) => {
        if (error instanceof HTTPException) {
            return c.json({ error: error.message }, error.status);
        }
        throw error;
    });

    // A fresh object rather than the router itself, so the definitions cannot narrow their
    // argument back to the whole router (`instanceof OpenAPIHono`) and reach `get`.
    defineRoutes({
        openapi: (route, handler) => {
            router.openapi(route, handler);
        },
    });
    return router;
}
