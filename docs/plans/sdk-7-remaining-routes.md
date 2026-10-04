# SDK step 7: everything outside journeys onto the SDK

Follows steps 1–6 (`sdk-1-walking-skeleton.md` … `sdk-6-flow-builder.md`; step 6 committed as `6240f1e`).

## Why this slice

After step 6 the bridge list (`NOT_YET_IN_SPEC`, ceiling 27) held three groups: the 18 journey routes, the 3 leveling routes, and the 6 public or session routes (`/api/health`, `/api/bot`, `/api/auth/*`). Two dashboard pages that read routes already in the spec, the ticket list and the ticket detail, still fetched through the hand client, as did the auth and guild contexts.

This step moves everything that does not depend on the journey routes. Afterwards the bridge list is the journey routes alone, and the hand client (`web/src/api/client.ts`, `types.ts`) serves only journeys. Step 8 is the journeys.

It also closes three follow-ups carried since steps 1–2: `onUnauthorized` is not wired, the query cache is not cleared on logout, and the SPA fallback answers unmounted `/api/*` GETs with `index.html`.

## Decisions taken

All conventional; none needed Douglas.

### 1. Leveling: three routes on `apiRouter`
- `operationId`s after today's client functions: `listLeveling`, `getLevelingUser`, `getLevelingInsights`. Tag `leveling`.
- **Wire schemas** in a new `src/web/api/levelingBody.ts`, named after the browser's types (`LevelingListResult`, `LevelingUserDetail`, `LevelingInsightsBody`, `LevelingRankingRow`, `LevelingMember`, …), as step 3 did. The vocabularies are named enums: `StatsPeriod`, `ActivityStatus`, `CohortKey`.
  - They are imported from their defining modules (`statsPeriod.ts`, `statsCardMetrics.ts`, `levelingCohorts.ts`), not the `features/leveling` barrel: `levelingRoutes.test.ts` mocks the barrel down to five names, and `z.enum` reads its tuple at load.
  - Arrays stay mutable (no `.readonly()`): `insightsBody` copies every array out of the loader's cached report, and its test proves the copy by mutating what it returns.
  - The builders in `levelingRoutes.ts` stay where they are and are typed by `z.infer` of the schemas, so a member the schema does not describe is a compile error where the body is built.
- **What stays a handler check:**
  - `userId` is `z.string()` in the path, checked by `resolveUserId`: its refusal names the value (`` `abc` is not a user id. ``), a sentence no schema can carry.
  - `period` is `z.string().optional()` in the query, parsed by `parseStatsPeriod`. `levelingRoutes.test.ts` pins "an unrecognised period falls back to the default" as deliberate: a view preference degrades, it does not refuse.
- **Errors declared:** `GUILD_SCOPED_ERRORS` on all three; the member route's 400 names both causes; insights declares its 503.
- **Retired:** the hand interfaces, 13 `*_KEYS` lists and `keyListsAreComplete` in `levelingRoutes.ts`; `levelingWireShapeDrift.test.ts` (16 cases).

### 2. Auth, bot and health on `apiRouter`
- `botRoutes`: `GET /api/bot`, `getBotIdentity`, response `BotIdentity` with `flavour: z.union([BotFlavour, z.null()])` (not `.nullable()`, which would make the `BotFlavour` component itself nullable). The `BotIdentityResponse` and `BotFlavour` type exports stay: `web/e2e/support/dashboardApp.ts` imports them.
- `authRoutes`:
  - `GET /auth/login` (`login`) and `GET /auth/callback` (`loginCallback`) declare **302** with a `Location` header — they are browser navigations, and the spec says so in their summaries. The callback's `code` and `state` are optional query strings, so the handler keeps its order and sentences (state first, then code).
  - `GET /auth/me` (`getCurrentUser`): 200 `AuthUser`, 401.
  - `POST /auth/logout` (`logout`): 200 `{ ok: true }`, 401. Its `requireAuth` moves from route-level middleware (which `ApiRouteRegistrar` refuses at compile time) to `app.use('/api/auth/logout', requireAuth)` in `registerApiRoutes`, before the mount, like the guild middleware. `KNOWN_MIDDLEWARE` already drops `requireAuth` by identity.
- `GET /api/health` (`getHealth`) becomes its own `healthRoutes.ts` router mounted at `/api/health`, path `/` (the `/api/nodes` precedent).
- **Bridge:** ceiling 27 → 18, and the list holds only the 18 journey routes.

### 3. Web: leveling pages on `useQuery`
- `LevelingPage`: `useQuery(listLevelingOptions)` keyed by guild. The generation counter goes.
- `LevelingUserPage`: `useQuery(getLevelingUserOptions)` keyed by guild, user and the *requested* period (absent on the first read, so the server's default decides). `placeholderData: keepPreviousData`, which is what kept the header and switcher mounted through a period change before; `isPlaceholderData` drives the small refetch spinner.
- `LevelingInsightsPage`: `useQuery(getLevelingInsightsOptions)` keyed by guild, **without** `keepPreviousData` — its comment explains why a different guild's report must not stay on screen. The 503 → refusal panel stays a status check on `ApiError`.
- Vocabularies: `web/src/leveling/contractValues.ts` reads `STATS_PERIODS`, `ACTIVITY_STATUSES`, `COHORT_KEYS` off the generated zod enums' `.options`. `src/web/api/__tests__/contractValues.test.ts` gains three rows holding them to the server's lists, in order.
- Every presentation module (`web/src/leveling/*`) changes only its type imports.
- **Retired:** `web/src/api/leveling.ts`; the leveling section of `types.ts` with its 13 `*_KEYS` and its completeness gate.

### 4. Web: ticket list and detail on `useQuery`/`useMutation`
- **List:** `useQuery(listTicketsOptions)` keyed by guild and filter, with `keepPreviousData`, which replaces the shared generation counter: a stale answer for an old filter can no longer land, and a re-filter keeps the rows on screen as before.
  - `toListFilter` returns the route's own query type (`unclaimed: 'true'` rather than `unclaimedOnly: true`), so the filter is the query key and the request at once. `undefined` members drop out of the key's hash.
  - The config read becomes `useQuery(getTicketsConfigOptions)`; a failure still just leaves the type dropdown at "All types".
  - The search debounce is unchanged. The search box's loader shows while the typed text has not reached the filter yet, or while the table is showing a previous filter's rows.
- **Detail:** `useQuery(getTicketOptions)`; a 404 is `missing`, any other error the red panel, as before (including a failed re-read after an action, which replaced the ticket with the error panel before and still does).
- **Actions:** one hook, `web/src/tickets/useTicketAction.ts`, used by both pages: a `useMutation` over a `Record<TicketAction, SDK call>`, with the "Done" notification, the `syncWarning` notification (`autoClose: false`, stays until dismissed), and the awaited re-read in `onSuccess`, so the acting button's spinner spans the re-read as before. `acting` is derived from the mutation's variables; a second action while one is pending is ignored, as before. `ticketId` goes as `String(id)`: the route declares a string.
- `TicketAction` moves to `ticketActions.ts`, beside `availableActions`.
- `web/e2e/ticketActions.test.tsx` compares the list request's parsed params instead of an exact query string.
- **Retired:** `web/src/api/tickets.ts`.

### 5. Auth and guild contexts on the SDK
- **`AuthContext`:** `getCurrentUser` and `logout` called directly, inside the existing effect and callback — not `useQuery`. Both providers sit outside the auth gate, and the boot-time `/me` is a one-shot seed, step 6's pattern. `AuthUser` comes from the SDK.
- **`BotIdentityContext`:** `getBotIdentity` called directly in the existing effect, for the same reason. Retires `web/src/api/bot.ts`; `BotFlavour` comes from the SDK (also in `brand.ts`).
- **`GuildContext`:** `useQuery(listGuildsOptions())`. The "Could not load servers" notification is shown from an effect when the query fails. `Guild` comes from the SDK.
- The login page still links to `/api/auth/login`; nothing fetches it.

### 6. A 401 signs the dashboard out; logout empties the cache
- A small module, `web/src/auth/sessionLoss.ts`: `reportSessionLost()` and `onSessionLost(listener)`.
- `main.tsx` passes `reportSessionLost` to `setupClient` as `onUnauthorized`; so does `setupDom.ts`, so tests run the app's wiring.
- `AuthProvider` subscribes before its `/me` call starts, and routes a lost session into the same `signedOut()` that `logout` uses: user → null (the `Gate` shows `LoginPage`), then `queryClient.clear()`.
- The boot-time `/me` 401 fires the handler too; it is idempotent (null user, empty cache).
- Only SDK calls report a 401. The hand client, which after this step serves only journeys, does not; step 8 deletes it.

### 7. Unknown `/api` paths answer 404 JSON
`buildApp` registers `app.all('/api/*', …)` after `registerApiRoutes` and before the static block, answering `404 { error }`. Outside `everyRouteInSpec`'s reach by design (the gate reads `registerApiRoutes`). Ordering: a route that matched earlier has already answered; the auth middleware still runs first on guild paths.

## Behaviour changes
- **Routes on `apiRouter`:** none a caller can reach. Every converted route is a GET or a bodiless POST, so no 415 or malformed-JSON case applies. A repeated query key (`?period=a&period=b`) is now refused with zod's default sentence, as step 4 recorded for tickets.
- **`GET /api/auth/logout`** (not a route) now gets requireAuth's 401 without a session rather than a 404, because the middleware is mounted on the path.
- **A 401 from any SDK call** signs the dashboard out to the login page, instead of that page showing its error.
- **An unknown `/api/*` path** answers `404 { "error": "Nothing lives at this API path." }` instead of `index.html` (production) or Hono's plain-text 404 (dev).
- **The ticket search box's loader** also shows while a status, type or unclaimed change is re-reading, not only a search.
- **Returning to a page already visited** shows its cached answer while it re-reads (insights, the leaderboard, a ticket filter), rather than a spinner. Step 3 accepted the same for the flows list.
- **No copy changes**, beyond the new 404 sentence.

## Checks (planned)
- Suite against the baseline (3,019 pass, 1 known failure). Expected delta: −16 `levelingWireShapeDrift`, plus the tests below.
- Typechecks: root `tsc` the same 17, `typecheck:e2e` the same 4, web `tsc -b` and the SDK typecheck clean.
- `pnpm sdk:generate` twice, byte-identical.
- New tests:
  - auth routes: `me` 401 and 200, `logout` 401 through the parent middleware, `login` 302 to Discord, `callback` 400 on a bad state;
  - `buildApp`: an unknown `/api` path is a JSON 404 (the dev branch — tests have no client build; the production ordering is registration order);
  - dom: `App` through the fake API with a guild route answering 401 → the login page;
  - dom: logout empties the query cache;
  - dom: the insights 503 shows the refusal panel; a period switch keeps the header and sends `?period=`;
  - three `contractValues` rows.
- e2e: `ticketActions` (list claim, detail release/close, deleted channel, config filter), plus the rest of `web/e2e`.
- Sabotage, each restored and regenerated byte-identical:
  1. a leveling route left on the bridge list → `everyRouteInSpec` fails;
  2. the catch-all removed → the 404 test fails;
  3. `onUnauthorized` dropped from `setupDom` → the sign-out dom test fails;
  4. `clear()` removed from `signedOut` → the cache test fails;
  5. one vocabulary derivation shortened → `contractValues` fails;
  6. the insights page's 503 check flipped to 500 → the refusal dom test fails;
  7. the logout `use` removed → the auth test fails.

## As built

As planned, with the changes below. Where they contradict the sections above, this section is the record.

### Server
- **All 9 routes are on `apiRouter`:** `listLeveling`, `getLevelingUser`, `getLevelingInsights`, `getBotIdentity`, `login`, `loginCallback`, `getCurrentUser`, `logout`, `getHealth`. The bridge list is the 18 journey routes and the ceiling is 18.
- **`levelingBody.ts`** names `StatsPeriod`, `ActivityStatus`, `CohortKey`, `LevelingMember`, `LevelingRankingRow`, `LevelingListResult`, `LevelingActivitySummary`, `LevelingActivityBucket`, `LevelingActivityChart`, `LevelingUserMetrics`, `LevelingUserDetail`, `LevelingLevelReachPoint`, `LevelingCohortProgressionPoint`, `LevelingCohortSummary`, `LevelingXpDistribution`, `LevelingInsightsBody`. The builders in `levelingRoutes.ts` are typed by their `z.infer`. `period`'s description names the `StatsPeriod` enum rather than listing the values a second time.
- **Bot, auth, health:** components `BotFlavour`, `BotIdentity`, `AuthUser`, `LogoutResult`, `Health`. The login and callback 302s declare a `Location` header. Deviation from §2: only `BotIdentityResponse` stays exported from `botRoutes.ts` — nothing imported `BotFlavour`, so that export went (review).
- **`src/web/server.ts`:** `app.all('/api/*')` answers `404 { "error": "Nothing lives at this API path." }`, registered after the API and before the static block.

### Web
- **Leveling pages** as planned. `web/src/leveling/contractValues.ts` holds the three vocabularies; the presentation modules changed only their type imports and the comments that called the vocabularies mirrors.
- **Ticket pages:** as planned, with one change to the action hook (review). `useTicketAction(guildId)` re-reads by itself rather than taking a page's `reread`:
  - after an action it **drops the cached answers no page is showing** for that guild's ticket list and for the acted-on ticket, then re-reads the ones on screen and waits. Without the drop, going from a ticket just closed back to the list showed the cached list — the ticket still Open, with a live Close button — until its re-read landed;
  - the re-read is keyed from the action's own variables, so a page that has since moved to another ticket re-reads the right one, and the detail page only spins its buttons for the ticket it shows;
  - **the re-entry guard is a ref set synchronously in the click**, cleared in `onSettled`. `mutation.isPending` reaches the page a macrotask later, through the query client's notify scheduler, so it alone would have let a fast second click start a second action — the double-click 409 the old state guard existed for.
- **`web/src/api/loadErrorMessage.ts`:** the server's sentence for an `ApiError`, a fallback for anything else, null for no error. Used by the five pages that had each grown a two-level ternary (review). `GuildContext` keeps its own `instanceof Error` reading, which is what it did before.
- **Contexts** as planned: `AuthContext` and `BotIdentityContext` call the SDK directly, `GuildContext` is a query.
- **Retired:** `web/src/api/bot.ts`, `leveling.ts`, `tickets.ts`; from `types.ts`, `AuthUser`, `BotFlavour`, `BotIdentity`, `Guild` and the leveling section with its 13 `*_KEYS` and its gate; `levelingWireShapeDrift.test.ts`.
- **Left for step 8:** `web/src/api/client.ts` (its `api.delete` and 204 branch have no caller left; the file goes whole with the journeys), `journeys.ts`, and `types.ts`, which is now the journey section and its drift-gate key lists only.

### Behaviour changes, final
Those listed above, corrected and completed:
- **Routes on `apiRouter`:** no 415 or malformed-JSON case, as every converted route is a GET or a bodiless POST. One change a caller can reach: **a repeated query key is refused** with zod's default sentence — `?period=a&period=b` on the member route, and a repeated `code` or `state` on the OAuth callback, which is now refused before the state check rather than reading the first value.
- **A 401 from any SDK call signs the dashboard out, and whatever the page held unsaved goes with it.** The `Gate` swaps the whole tree for the login page, which is neither a router navigation nor an unload, so the builder's leave guard does not see it. The Flow Builder loses the edits made since its last successful draft autosave (the autosave is itself the call that 401s); a settings form loses its whole draft when its Save 401s. Before, the page showed its error and kept the draft. Sessions are a 7-day JWT, so this needs a session to expire mid-edit. See *Question for Douglas*.
- **A mutation already running when the session is lost still reports its own failure** (for example "No dice — Not authenticated" over the login page). Queries do not: emptying the cache cancels them before their error lands.
- **A 401 on the guild list** can also show "Could not load servers" as it signs out.
- **The member page's refetch spinner** shows while a window is read for the first time; going back to a window already loaded shows it at once and re-reads quietly.
- The rest as listed under *Behaviour changes* above.

### Question for Douglas
When a session runs out while someone is mid-edit, which should happen?
- **As built:** the dashboard goes straight to the login page, and unsaved edits on that page are lost.
- **Alternative:** the page stays as it is, with a "your session ran out — sign in again" panel over it that opens the Discord sign-in in a new tab; once signed in, Save works again and nothing is lost.

Recommendation: the alternative, as its own small step. It is the only way the Flow Builder's unsaved edits survive an expired session.

### Checks
- **Suite:** 3,019 pass, 2 fail — `ciBranchProductDiff` and the date-dependent birthday "skips overlapping runs", both known — in the last full run, after the review fixes. In an earlier parallel run, `levelUpDispatch`, `memberJoinDispatch` and `reactionAddDispatch` timed out their hooks (the known block-discovery flake); re-run alone, all 41 pass. Baseline 3,019: −16 `levelingWireShapeDrift`; +6 `authRoutes`, +2 `buildApp`, +3 `contractValues`, +2 `signOut`, +2 `LevelingPages`, +1 `ticketFilters`. One e2e case was added after that run (`ticketActions` "going back to the list after acting on a ticket"; the file passes 10/10 alone), so the count is now **3,020**.
- **Typechecks:** root `tsc` the same 17 (list diffed); `typecheck:e2e` the same 4; web `tsc -b` and the SDK typecheck clean.
- **Generation:** `pnpm sdk:generate` twice gives hash-identical spec and generated files, both after the sabotage round and after the review fixes (which changed one spec description, `period`'s).
- **e2e:** all 13 files pass, `ticketActions` included: its filter assertion now compares parsed params, its claim-from-the-list case still sees the row update, and it gains "going back to the list after acting on a ticket".
- **Sabotage**, each restored and the generated output re-hashed identical:
  1. a leveling route put back on the bridge list → `everyRouteInSpec` failed twice ("never grows", "lists only routes not in the spec yet");
  2. the catch-all commented out → `buildApp` "answers an unknown /api path with a JSON 404" failed;
  3. `setupDom`'s `onUnauthorized` replaced by a handler that does nothing → the 401 sign-out test failed (no login page);
  4. `clear()` removed from `signedOut` → both sign-out tests failed on the cached guild list;
  5. `STATS_PERIODS` shortened by one → `contractValues` failed on the periods row;
  6. the insights refusal check moved from 503 to 500 → the refusal dom test failed;
  7. the logout `use` commented out → `authRoutes` "is refused without a session" failed;
  8. `keepPreviousData` removed from the member page → the period-switch test failed (the member's heading went while the month loaded);
  9. the ticket hook's `removeQueries` dropped → the new e2e failed (the closed ticket's row showed from the cached list while its re-read was held). Its first version, without holding the re-read, passed with the sabotage in place — the in-process API answered inside `act` — and was rewritten to hold it.
- **Not verified by a test:** the ticket hook's synchronous re-entry guard (reasoned from query-core's `setTimeout(0)` notify scheduler), and the "a 401 is asked once" assertion added after review, which no loop path exists today to sabotage.
- **Review:** one pass, `generic-reviewer-domain-runtime` and `generic-reviewer-maintainability` run directly; no Critical or High.
  - **Fixed:** the ticket hook's cross-page staleness, late re-entry guard and render-bound re-read; the six error ternaries; two test headers naming the deleted drift test; the dead `BotFlavour` export; `authRoutes`' orphaned JSDoc and its wrong "me requires a session"; leftover "mirror" wording; `listQuery`/`list` naming; `loading` → `reading` on the member page; a loop guard on the 401 test; this section's corrections.
  - **Recorded rather than fixed:** the unsaved-work loss (a product question, above); a 401'd mutation's own notification; the guild-list toast on a 401.

### Follow-ups
- **The question above.** If Douglas picks the overlay, it replaces the `Gate` swap for a session lost mid-session; the boot-time `/me` 401 keeps going to the login page.
- **Journey calls do not sign out on a 401**: they go through the hand client, which step 8 deletes.
- **A 401'd mutation's notification** could be skipped in one shared place once there is one; today each page's `onError` shows its own.
- **`docs/plans/sdk-coordinator-brief.md`** has an uncommitted edit that predates this step: the new "Git and imports" heading leaves three typecheck baselines (root `tsc` 17, `typecheck:e2e` 4, web and SDK clean) under "Root code can't import SDK values at runtime" instead of under Baselines. It is the coordinator's file, so this step left it alone.
- **Stale page comments, not this step's:** `LevelingPage`, `LevelingUserPage`, `LevelingInsightsPage` and `TicketsListPage` still say "there are no `.test.tsx` files in this repo".
