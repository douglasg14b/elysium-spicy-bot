# SDK step 1 — walking skeleton: spec → generated SDK → TanStack Query, on the guild routes

Branch `feat/web-sdk` (worktree `../discord-spicy-bot-web-sdk`), off `feat/web-ui-flow-engine` at
`83bf681`. Context: `docs/plans/sdk-generation-handoff.md` in the main tree (field-check work is
already committed in `83bf681`).

> **Built, and partly superseded by step 2** (`sdk-2-spec-cannot-be-skipped.md`). Step 2 changed several things this plan describes:
> - `apiRouter` now takes a callback.
> - The remedy everywhere is `pnpm sdk:generate`.
> - `sdk:check` uses `git status --porcelain`.
> - The SDK is gated in the suite.
>
> "What step 2 likely is" below was not what step 2 became.

## Why

Two problems, one mechanism:

1. **Duplication.** `web/src/api/types.ts` (≈2,050 lines) hand-mirrors every wire type, kept honest
   by 39 `*_KEYS` lists and 8 drift tests that compare *member names only*. `web/src/api/*.ts` is a
   hand-written client; every page hand-rolls `useEffect`/`useState` fetching with no cache.
2. **Field rules.** The server's zod schemas already state the constraints; the browser re-states
   them by hand or not at all.

Generating an OpenAPI spec from the server and an SDK from the spec answers both: types, the
fetch client, TanStack Query helpers, and zod request schemas (constraints included) all come
out of the server's own definitions.

## Reference and where we differ

`budget-tools/packages/web-sdk` (tsoa + Express → `openapi.generated.json` → `@hey-api/openapi-ts`
→ committed `src/gen`). We keep its **shape** and change its **source**:

| Reference | Here | Why |
|---|---|---|
| tsoa decorators on TS types | `@hono/zod-openapi` (`createRoute` + `app.openapi`) | We are Hono + zod; our request schemas already exist. `app.openapi` type-checks every `c.json(body, status)` against the declared response — the compile-time replacement for drift tests. Peer deps verified: zod `^4`, hono `>=4.10`. |
| Paths without `/api`, prefix in 3 places | Spec emitted from the real mount, paths include `/api` | One source for the prefix; SDK `baseUrl` is `''` (same origin, Vite proxies). |
| No error schema; client throws the bare body, status lost | Shared `ErrorBody` schema on every error status; error interceptor throws our `ApiError(status, message, issues)` | Pages branch on `.status` and read `.issues` today. |
| `methodNameBuilder`/`serviceNameBuilder` (no-ops in 0.99 → `request2`, `request5`) | Explicit `operationId` on every route; use the operationId-named TanStack helpers | Stable names; adding a route renumbers nothing. |
| No drift check — SDK goes stale silently | Vitest gate: built spec deep-equals the committed file; `sdk:check` script regenerates and `git diff --exit-code`s | No CI runs tests here, so the gate lives in the suite. |
| No zod plugin; field rules hand-copied (`MIN_PASSWORD_LENGTH`) | hey-api `zod` plugin | This is the field-rules objective. |

## Scope of this step (and only this)

Prove the pipeline end to end on **`guildRoutes.ts`** — all 7 routes (guild list, channels, roles,
warnings GET/PUT, settings GET/PUT) — and migrate **`WarningsPage`** and **`ServerSettingsPage`**
to the generated SDK. Everything else stays on the hand client and keeps working: an
`OpenAPIHono` is a `Hono`, so unconverted routers mount unchanged and simply add nothing to the
spec yet.

### Server
1. `pnpm add @hono/zod-openapi`.
2. `buildApp` / `registerApiRoutes` use an `OpenAPIHono<AppEnv>` root (a plain `Hono` parent
   collects no spec from its children). Converted routers are built with `apiRouter()`
   (`src/web/api/openApi.ts`), which sets two things **on each router**, not on the root:
   - a `defaultHook` that turns a validation failure into today's
     `400 { error: issues[0].message ?? 'Invalid request body.' }`, so existing route tests and
     copy are unchanged;
   - an `onError` that answers the validator's own `HTTPException`s (malformed JSON 400, non-JSON
     body 415) in the same `{ error }` envelope and rethrows everything else, so a real crash still
     reaches the parent's error handler.

   Per router because the route tests and the e2e dashboard app mount routers on a plain `Hono`,
   where nothing set on the production root would be inherited.
3. Convert `guildRoutes` to `createRoute` + `app.openapi`:
   - path params as `{guildId}`; explicit `operationId`, `tags: ['guilds']`;
   - request bodies `required: true` (otherwise the validator skips a body whose content-type
     isn't JSON);
   - **named** response schemas (component ids — otherwise hey-api inlines anonymous types):
     `Guild`, `GuildChannel`, `GuildRole`, `WarningsConfig`, `GuildSettings`, request bodies too;
   - error statuses declared with the shared `ErrorBody` — including the middleware's
     401/400/403/404 on guild-scoped routes (one helper, not repeated literals).
   - The response schema becomes the wire type: `guildBody.ts`'s hand `GuildChannelBody` /
     `GuildRoleBody` interfaces and their `*_KEYS` lists are replaced by `z.infer` of the schemas
     (the unused `GuildRoleBody` noted in the inventory goes away with it).
4. `buildOpenApiDocument()` (server-side, no listen, no Discord login) + `pnpm openapi:emit` →
   committed `generated/openapi.generated.json`. Stub env like `vitest.setup.ts` so the import
   tree loads without secrets.
5. Gate: `src/web/api/__tests__/openApiSpec.test.ts` — built document deep-equals the committed
   file, failing with "run `pnpm openapi:emit`". Sabotage-verify it.

### SDK package
6. `packages/web-sdk` (`@brattybot/web-sdk`), workspace gains `packages/*`; `exports: ./src/index.ts`
   (source, no build); generated `src/gen/**` **committed**. Root `tsconfig` excludes `packages`
   and `generated` (it includes `**/*.ts`).
7. `@hey-api/openapi-ts` (latest — 0.99.0 today) with plugins: client-fetch, sdk,
   `@tanstack/react-query` (queryOptions + mutationOptions), `zod`. Plugin names/options read from
   the *installed* version's docs, not copied from the reference.
8. Hand-written `setupClient` (as the reference): fails loudly if never called; `credentials:
   'same-origin'`; 401 → `onUnauthorized`; **error interceptor throwing `ApiError(status,
   message, issues)`** — `ApiError` moves into the SDK so both clients throw the same class
   during the migration (`web/src/api/client.ts` re-exports it).
9. Scripts: `sdk:generate` (emit + openapi-ts), `sdk:check` (generate + `git diff --exit-code`).

### Web
10. `pnpm add @tanstack/react-query` + `@brattybot/web-sdk` in `web`. `setupClient` before render;
    `QueryClientProvider` at the app root — and in the test renderers (`renderDashboard`, any
    `dom` helper) so pages under test get it.
11. `WarningsPage`, `ServerSettingsPage`: `useQuery(xxxOptions({ path: { guildId } }))` for config +
    channels/roles; `useMutation(xxxMutation())` with `setQueryData` on success. Remove the
    `cancelled` flags and the loading/error `useState`s they replace.
12. Field rules, proven once: `WarningsPage`'s `canSave` asks the generated zod body schema rather
    than re-stating "non-empty" by hand. (Only *validity* crosses — zod messages don't reach JSON
    Schema; the server's wording stays the server's.)
13. Delete what the slice retires: the four warnings/settings functions in `web/src/api/config.ts`,
    `WarningsConfig`/`GuildSettings` (+ keys) in `types.ts` if nothing else uses them, and the
    matching entries in `guildWireShapeDrift.test.ts`. `getGuildChannels`/`getGuildRoles` stay
    for their other callers until those pages migrate — say so in a comment at the hand client.

### Checks
- `pnpm test` (node, dom, e2e) — no new failures vs baseline (1 known: `ciBranchProductDiff`).
- web `tsc -b`, root `tsc --noEmit` clean of new errors.
- `web/e2e/support/dashboardApp.ts` still composes the routers.
- `pnpm sdk:check` clean after generation.

## Not in this step
- `/api/nodes`: the 11-arm `BlockConfigField` union as zod flips the manifest's source of truth
  (zod first, TS inferred). Its own step.
- The other 53 routes, `types.ts` / drift-test retirement beyond this slice, auth/guild contexts.
- Error *wording* through the spec.

## Follow-ups
Still open after step 2, so they moved to `sdk-2-spec-cannot-be-skipped.md` § Follow-ups.

## What step 2 likely is
Pick by value: either the flow routes (the biggest client, `FlowBuilderPage`'s fetching and
`useFlowIssues`' `/check` as a mutation — its ordering tests are the spec), or `/api/nodes` (types
for `fieldChecks` generated, not mirrored). Decide after this step lands.
