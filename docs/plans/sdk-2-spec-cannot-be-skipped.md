# SDK step 2: a route that works is in the spec, or the build says why not

Builds on step 1 (`sdk-1-walking-skeleton.md`), which is uncommitted on the same branch.

## Why

Douglas's bar: "if I add a new endpoint and it works, it shows up in the OpenAPI spec. No work beyond a build."
`@hono/zod-openapi` meets that bar only when a route is written with `createRoute` + `app.openapi`, and nothing forces that today:

- A plain `app.get(...)` serves requests and is missing from the spec. Nothing reports it.
- Spec and SDK are regenerated only when someone runs `pnpm sdk:generate`.

He chose (2026-10-02) to keep zod-openapi and make the declarative way the only way, rather than port to tsoa.
The reason: tsoa would mean an Express rewrite, and zod field limits would never reach the spec.
The one cost that remains, compared with tsoa, is writing a zod schema for each response.

## What this step builds

### 1. Converted routers cannot declare a route the spec won't see (compile time)
- `apiRouter` hands the route definitions a surface with only `openapi(...)` (plus `use` if a router needs middleware) and no `get`/`post`/`put`/`delete`/`patch`/`all`/`on`.
- Suggested shape: `apiRouter((router) => { router.openapi(...); })`. The callback sees the restricted type; the function returns the full `OpenAPIHono` for mounting. An `Omit<>`'d return type is no longer assignable to the `Hono` that `app.route()` expects.
- `guildRoutes` moves to the new shape.

### 2. No served `/api` route is missing from the spec (test gate)
- `src/web/api/__tests__/everyRouteInSpec.test.ts` builds the real app through `registerApiRoutes` on an `OpenAPIHono`.
- It reads `app.routes`, keeps the real handlers under `/api` (dropping middleware entries), and normalises `:param` to `{param}`.
- It fails, naming every method + path that is served but absent from the spec.
- **Explicit bridge** (`.claude/rules/root-cause-over-workarounds.md`): a `NOT_YET_IN_SPEC` list holds the routes that haven't been converted yet.
  - The test also fails if a listed route is no longer served, or is now in the spec. Converting a route therefore forces its removal from the list, so the list can only shrink.
  - A brand-new route can never sit on the list.
  - The list's header says it is a migration bridge and must reach zero.
- Sabotage-verify it two ways: add a plain `app.get` to an unconverted router and watch the gate fail; drop one listed entry and watch it fail.

### 3. A stale SDK fails the suite, not just `sdk:check`
- A test regenerates the SDK from the committed spec into a temp dir with `@hey-api/openapi-ts`'s programmatic API and the same config.
- It diffs the result against `packages/web-sdk/src/gen` and fails with "run `pnpm sdk:generate`".
- `@hey-api/openapi-ts` is a dev dependency of the SDK package, so resolve it from there.
- Sabotage-verify it by hand-editing a generated file.

### 4. The build regenerates
- `pnpm dev` and `pnpm build` run `sdk:generate` first.
- **Docker uses the committed spec and SDK and does not regenerate.** The generator needs Node ≥22.18 and the image is Node 20, so check the Dockerfiles and keep generation out of anything they run. The committed output plus the gates above are what keep it current.

### 5. Docs
- In AGENTS.md "Conventions for edits", the route rule becomes: the only way to add an API route is `apiRouter`, the gate rejects anything else, and the build regenerates.
- The plan's follow-ups move here if still open.

## Not in this step
- Converting the remaining ~53 routes. That is the migration the `NOT_YET_IN_SPEC` list tracks: flow routes next, then `/api/nodes`.
- Regenerating while `tsx watch` is running. A route edited mid-session needs `pnpm sdk:generate`, a dev restart, or the next build. The gates catch a missed regeneration before commit.

## As built
- The surface is `ApiRouteRegistrar` in `openApi.ts`: `openapi(route, handler: RouteHandler<Route, AppEnv>): void`. It returns `void` so `router.openapi(...).get(...)` cannot chain out. No per-route hook (the `defaultHook` is the policy) and no `use`, because no converted router needs either yet. Add them when one does. `apiRouter.test.ts` pins the shape for `tsc`.
- The gate tells middleware apart from routes by identity. An `ALL` entry whose handler is `requireAuth` or `requireGuildAccess` is dropped. Any other `ALL` entry is reported, because Hono also records `all()` and `mount()` as `ALL`. `NOT_YET_IN_SPEC` starts at 53.
- The stale-SDK test lives in `packages/web-sdk/__tests__/generatedSdkIsCurrent.test.ts`. That way `@hey-api/openapi-ts` resolves from the SDK package. It sits outside `src`, so the browser sources keep `types: []`. It and the config are type-checked by `tsconfig.node.json`, and the package's `typecheck` script runs both configs. It uses `SDK_GENERATOR_CONFIG`, which `openapi-ts.config.ts` now exports, and takes about 0.2s.
- The surface also refuses `hide: true` and route-level `middleware` at compile time. The routes get a fresh `{ openapi }` object rather than the router, so `instanceof` cannot narrow back to it. `openapi` is a property, not a method, which keeps the handler's type compared strictly.
- **The compile-time guards run in `pnpm test`.** They live in `apiRouter.test-d.ts`, which the `node` project checks in Vitest typecheck mode (`ignoreSourceErrors`, so root's 17 pre-existing errors don't fail it; adds ~16s, in parallel). Sabotage: a `void` callback type left the async `@ts-expect-error` unused, and the run failed.
- **`defineRoutes` returns `undefined`, not `void`**, so an `async` callback is a compile error: `app.route()` copies routes at mount, so anything declared after an `await` would be neither served nor described, and the gate could not see it.
- **The bridge list cannot grow.** `NOT_YET_IN_SPEC_CEILING` (53) plus a uniqueness check. Growing the list now takes two deliberate edits. Sabotage: ceiling 52 failed with "NOT_YET_IN_SPEC grew".
- `pnpm sdk:check` stays. The tests read the working tree, so only it sees a generated file that was never committed.

## Follow-ups
Carried from step 1:
- **`onUnauthorized` is not wired.** `setupClient` reports a 401, but nothing passes it a handler. Wire it to the auth context, so a lost session signs the dashboard out instead of showing a page error.
- **The query cache is not cleared on logout.** Login is a full-page redirect today, so nothing leaks between users yet. `queryClient.clear()` belongs in `logout` once that changes.
- **Overlapping saves across guild switches.** Save on guild A, switch away and back, save again: the two saves can race. A `mutationKey` per guild plus `useIsMutating` would close it.
- **The SPA fallback in `src/web/server.ts` also matches unmounted `/api/*` GETs.** It answers them with `index.html`, despite its comment. The SDK parses responses as JSON, so this shows up as a load error rather than empty data. The route should 404.
- **Item 12 is pinned, not visible.** `WarningsPage`'s `canSave` asks the generated zod, and the spec gate pins `minLength: 1`. But the channel Select cannot be emptied, so no UI state depends on it yet.

Made sharper by this step:
- **`@hey-api/openapi-ts` declares Node ≥ 22.18.** `pnpm build`, `pnpm dev` and `pnpm test` all run the generator now. Its own runtime check only refuses Node < 20, so on Node 20–22.17 it may or may not work. This was only ever run on Node 24. Docker is unaffected: it runs neither `build` nor `dev`.
