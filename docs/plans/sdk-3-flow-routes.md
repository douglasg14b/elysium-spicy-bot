# SDK step 3: flow routes in the spec, and the first flow screens on the SDK

Follows steps 1 and 2 (`sdk-1-walking-skeleton.md`, `sdk-2-spec-cannot-be-skipped.md`; committed in `55c8825` and `878d6e8`). Douglas picked the flow routes as next on 2026-10-03.

## Why this slice, and why the Flow Builder is step 4

The 15 flow routes are the largest hand-written client. Converting them on the server is all-or-nothing:
- `flowDraftRoutes` registers into `flowRoutes`, and their response shapes are shared.
- That leaves one router and one `onError`.

The Flow Builder cannot move to the SDK fully in this step:
- Its load is a `Promise.all` that also calls `/api/nodes` and a journey route (`getFlowResources`), neither converted yet.
- Its two ordering hooks need care of their own: `useFlowIssues`, with 7 tests, and `useFlowDraftAutosave`'s serial queue.

So this step converts the server side and moves the two consumers that can move cleanly. The builder is step 4.

## Scope

### 0. Bring the branch up to date
Merge `feat/web-ui-flow-engine` (`67aef56`) into `feat/web-sdk`. A trial merge was clean: `web/src/api/types.ts` changed on both sides, with no conflicts. Run the suite before building on it.

### 1. Server: the 15 routes on `apiRouter`
Routes:
- `flowRoutes.ts`: list, get, check, create, update, delete, deploy, install-plan, install, published, undeploy, unpublish.
- `flowDraftRoutes.ts`: list drafts, save mine, discard.

How they are registered:
- `flowDraftRoutes` becomes a `(router: ApiRouteRegistrar) => undefined` called inside `flowRoutes`' `apiRouter` callback, keeping one registration and one surface.
- Every `operationId` is named after today's client function (`listFlows`, `getFlow`, `checkFlow`, …), so pages read the same names.

Where the wire schemas live: in `src/web/api/*Body.ts` (`flowBody.ts`, `publishedBody.ts`, and a new install/teardown body file), named with `.openapi('X')`.
- `src/features/**` gains no hono or zod-openapi import.
- Domain interfaces stay where they are. Each builder is typed by `z.infer` of its schema, or held to it by a two-way assignability check, so the spec is the type the handler really returns.
- The schemas include:
  - `FlowGraph` (reuse `flowGraphSchema`, with node and edge schemas named);
  - `FlowValidationIssue`;
  - `FlowJourneyMembership`;
  - `FlowSaveBody` as `z.discriminatedUnion('savedAs', …)` over two named arms;
  - the install plan and result;
  - deploy, published, undeploy and unpublish.
- `src/features` changes are TypeScript only:
  - export `UNDEPLOY_OUTCOMES` and `UNPUBLISH_OUTCOMES`;
  - add a `JOURNEY_INSTALL_STATES` const so the union has a value to build the enum from.
- `readonly T[]` builders: use `.readonly()` (no effect on the spec) or spread copies, as `guildRoutes` does.

Error bodies are declared exactly as sent. One schema per status:
- **400 on check, create, update, drafts/mine:** `ErrorBody` plus an optional `issues: FlowValidationIssue[]`.
- **409 on install:** `ErrorBody` plus an optional `plan`.
- **423 on install.**
- **500 on get, check, update, list drafts.** This includes "Saved. …", the 500 after a write that did land.
- **The 404 description** covers each distinct reason.

The `ApiIssue` triple copy closes:
- The SDK's `ApiError.issues` is typed from the generated `FlowValidationIssue`.
- The hand `ApiIssue` goes.
- The three-way check in `flowRoutes.test.ts` shrinks to what remains.

The bridge list:
- `NOT_YET_IN_SPEC` loses its 15 entries.
- `NOT_YET_IN_SPEC_CEILING` drops from 53 to 38.

Behaviour that changes, each pinned by a small route test:
- **415** for a body without a JSON content type. There is precedent in `guildSettingsRoutes.test.ts`.
- Malformed JSON → **400 "Malformed JSON in request body"**.
- Body validation now runs **before** the flow-existence 404 on check, update and drafts/mine. No caller depends on the old order.

Behaviour that must not change:
- **`draftId` stays `z.string()` in params, coerced in the handler.** A non-numeric id is still 404 "Draft not found.", not a 400.
- Every validation message the routes send today (e.g. `flowNameSchema`'s): `defaultHook` already sends the first issue's message.

### 2. Web: `InstalledResourcesDialog` fully on the SDK
- `getPublishedState` becomes `useQuery` keyed by guild and flow. The current "failure shows the empty state" fallback stays.
- Undeploy and unpublish become `useMutation`s that invalidate that query, then call `onChanged`.
- e2e `flowDelete` and `flowTeardown` cover it. Teardown depends on the list refetching.

### 3. Web: `FlowsListPage`'s flow calls on the SDK
- **`listFlows`** becomes `useQuery` per guild, replacing the `loadGeneration` guard.
  - A quiet refresh becomes `invalidateQueries`.
  - A loud refresh (one that toasts on failure) awaits a refetch that throws.
  - A failed background refetch keeps showing the cached list, not the error panel.
- **`updateFlow`'s enable toggle** stays optimistic through `setQueryData`, and still reads `ApiError.issues` for the not-ready notice and issue count.
- **`createFlow`** (then navigate) and **`deleteFlow`** (then close and refresh) become mutations.
- Its journey calls stay on the hand client until the journey routes convert.

### 4. Retire what this step makes dead
- Hand functions in `web/src/api/flows.ts` with no callers left.
- Each type in `web/src/api/types.ts` used only by migrated code, with its `*_KEYS` and drift entries.
- Types still used by the builder or by journey code stay until step 4 or the journey step.
- Don't alias generated types into `types.ts`: the root type-check can't resolve the SDK.

## Checks
- Full suite against the baseline. Expected failures: `ciBranchProductDiff`, and the birthday-tick test that fails on the base branch too.
- Web `tsc -b` and the SDK typecheck must be clean. Root `tsc` must have no new errors.
- `pnpm sdk:generate` run twice gives identical output.
- Sabotage-verify any new guard: the issues-bearing 400 schema, and the `draftId` 404.

## As built

### Server
- **All 15 routes are on one `apiRouter`.** `flowRoutes()` is `apiRouter(defineFlowRoutes)`, and `defineFlowRoutes` calls `defineFlowDraftRoutes(router)` first, as the drafts were mounted first before. operationIds: `listFlows`, `getFlow`, `checkFlow`, `createFlow`, `updateFlow`, `deleteFlow`, `deployFlow`, `getInstallPlan`, `installFlow`, `getPublishedState`, `undeployFlow`, `unpublishFlow`, `listFlowDrafts`, `saveMyFlowDraft`, `discardFlowDraft`.
- **Schemas and where they live:**
  - `flowBody.ts`: `FlowNode`, `FlowEdge`, `FlowGraph`, `FlowValidationIssue`, `FlowRefusal` (the 400: `ErrorBody` + optional `issues`), `Flow`, `FlowJourneyMembership`, `FlowSummary`, `FlowDraftSummary`, `FlowDraft`, `FlowSaveResult` (discriminated on `savedAs` over `FlowSavedToFlow` / `FlowSavedAsDraft`). Also the shared `FlowPathSchema` and flow error maps (`FLOW_ERRORS`, `FLOW_GRAPH_BODY_ERRORS`, `GRAPH_REFUSED`, `DECLARATIONS_UNREADABLE`). They sit here rather than in `flowRoutes.ts` because `flowDraftRoutes.ts` needs them and is imported by it.
  - `flowRoutes.ts` / `flowDraftRoutes.ts`: the request bodies `FlowCreate`, `FlowUpdate`, `FlowCheck`, `FlowDraftSave`.
  - `publishedBody.ts`: `PublishedFlowState`, `PublishedButtonMessage`, `PublishedResource`.
  - `installBody.ts` (new): `DeployResult`, `DeployedButtonMessage`, `UndeployResult`, `UndeployedButtonMessage`, `UnpublishResult`, `UnpublishedResource`, `InstallPlan`, `InstallPlanItem`, `InstallRefusal` (the install 409: `ErrorBody` + optional `plan`), `InstallResult`, `InstalledResource`. `installPlanBody` moved here from `flowRoutes.ts`, and the install result became `installResultBody`.
- **Deviation: component names follow the browser's type names** (`Flow`, `FlowSummary`, `FlowSaveResult`, `PublishedFlowState`, …), not the server's `*Body` names, as step 1 did with `GuildSettings`. That makes step 4 an import swap. The server keeps its `*Body` aliases (`z.infer` of each schema) only while the `*_KEYS` drift lists exist.
- **The contract is typed, not hoped:** every builder (`flowDetail`, `flowSummary`, `flowDraft*`, `invalidGraphBody`, `installPlanBody`, `installResultBody`, `publishedBody`) returns `z.infer` of its schema. Domain types sent as they are (graph, issue, membership, published resource and button message, deployed/undeployed/unpublished/applied rows) are held to their schema by `SchemaMatches` (`openApi.ts`): assignable both ways, and the same top-level member names.
- **Declared errors:** 400 `FlowRefusal` on check, create, update, drafts/mine; 409 `InstallRefusal` + 423 on install; plain 409 on install-plan and unpublish; 500 on get, check, update (its description covers "Saved. …") and list drafts. Each 404 description names its causes. `openApiSpec.test.ts` still pins 401/403/404 to plain `ErrorBody`.
- `features` changes are TypeScript only: `UNDEPLOY_OUTCOMES` and `UNPUBLISH_OUTCOMES` exported, `JOURNEY_INSTALL_STATES` added. `installBody.ts` imports the vocabularies from their defining modules, not the provisioning barrel, because route tests mock the barrel partially and `z.enum` reads them at load. `flowDeleteTouchesNothing.test.ts` now keeps `undeployFlowButtons`' real exports (`importOriginal`) for the same reason.
- `NOT_YET_IN_SPEC` lost 15 entries; ceiling 38. `ApiError.issues` is typed by the generated `FlowValidationIssue`; the hand `ApiIssue` is gone. The check in `flowRoutes.test.ts` reads the SDK side off `ApiError` by path (`InstanceType<typeof ApiError>['issues'][number]`). Only root `tsc` sees it.

### Traps found on the way (now in AGENTS.md)
- **`.openapi()` is import-order dependent on schemas from `src/features`.** Zod copies prototype methods onto each schema as it is built; `@hono/zod-openapi` adds `openapi` to the prototype when it loads. A schema built earlier has no `openapi`. The bot loads `features/flows` long before the web layer, and so did `flowRoutes.test.ts` — `flowNodeSchema.openapi('FlowNode')` threw there while `pnpm openapi:emit` (which loads the library first) worked. The research note that this "works" was true only for the emit script. `FlowGraphSchema` is rebuilt from `flowGraphSchema.shape` with the library's `z` instead; the field schemas, and so the rules, are the feature's own.
- `.nullable()` on a named schema copies the name onto the nullable copy, so the component itself became `type: ['object', 'null']` and every generated `FlowJourneyMembership` read `| null`. `z.union([X, z.null()])` gives `anyOf: [$ref, null]`.
- An `.extend()`ed schema inherits its parent's description: `FlowDraft` was documented as "without its graph". Each extended component now has its own.

### Behaviour
- Changed, as planned and pinned: 415 for a non-JSON body; malformed JSON → 400 "Malformed JSON in request body"; body validation before the flow lookup on check, update and drafts/mine (the lookup is not even made). Unchanged and pinned: a non-numeric `draftId` is 404 "Draft not found."; the schema's own sentence (`Give the flow a name.`) still arrives.
- `InstalledResourcesDialog`: `useQuery(getPublishedStateOptions)` enabled while open; undeploy/unpublish are mutations whose `onSuccess` awaits the invalidation, so `busy` spans the re-read as before. The loader shows during any read except the one after this dialog's own teardown, so a cached answer from an earlier opening is never shown with live teardown buttons (review finding; the first cut showed it). Any failed read shows the unknown state.
- `FlowsListPage`: `useQuery(listFlowsOptions)` per guild, replacing the load generation. Quiet refresh = `invalidateQueries`; loud = `invalidateQueries(…, { throwOnError: true })` + toast. The error panel only shows when no list has loaded. The toggle cancels in-flight reads, patches the cache, calls the SDK's `updateFlow` directly, and — if it cancelled a read — re-reads quietly once the PUT settles (review finding: a cancelled read resolves silently with the old list, so a refresh carrying a delete would otherwise never land). Create/delete are `useMutation` + `mutateAsync` in the existing handlers. Enter in the new-flow name no longer starts a second create while one is in flight. Journey calls stay on the hand client.
- Accepted delta: the list shows the cached list while it re-reads on return to the page, rather than a spinner.
- Retired: hand `listFlows`, `createFlow`, `deleteFlow`, `undeployFlow`, `unpublishFlow`; hand `FlowSummary`, `FlowJourneyMembership`, `JourneyInstallState` and `FLOW_SUMMARY_KEYS` (both sides) with their drift row — the list page, `flowGrouping.ts` and `installStateChip.ts` read the SDK's types now. Everything else in `flows.ts`/`types.ts` still has builder or journey callers.

### Checks
- Full suite: 283 files, 2939 pass, 2 fail — the two expected (`ciBranchProductDiff`, birthday "skips overlapping runs"). Baseline was 2933 pass: +7 route tests, −1 `FlowSummary` drift row.
- Root `tsc --noEmit`: the same 17 errors (list diffed). Web `tsc -b`, SDK typecheck: clean. `typecheck:e2e`: the same 4.
- `pnpm sdk:generate` twice: identical.
- Sabotage, each restored and confirmed with `git diff`/grep:
  - `issues` removed from `FlowRefusal`: root `tsc` named `invalidGraphBody` (`flowBody.ts`), and `openApiSpec` failed on drift. In `pnpm test` the drift test is the guard; the builder check needs root `tsc`. A literal `{ error, issues }` passed straight to `c.json` is not caught by either — only builders are.
  - `draftId` validated in the params (`regex(/^\d+$/)`): the new 404 test failed with 400 for `abc`.
  - The SDK issue type drifted (an extra required member): root `tsc` named `flowRoutes.test.ts`.
  - An optional member added to `PublishedResourceSchema` only: `SchemaMatches` failed to compile (the member-name half; assignability alone passes it).
- Not test-covered: the toggle's re-read after a cancelled refresh, the dialog's loader on reopen, and "a failed background refetch keeps the list". All three are reasoned from query-core's behaviour; an e2e would need control over when a list read resolves.

### Follow-ups
- `journeyTeardownRoutes.test.ts` and `journeyDriftRoutes.test.ts` mock `undeployFlowButtons` wholesale. When the journey routes import `installBody.ts`, give both mocks `importOriginal`.
- `GET /flows` can 500 through the parent on a malformed journey row; the server has no JSON error handler, so that 500 is not an `ErrorBody` and is not declared.
- `togglingId` holds one id, so two rows toggled at once un-disable each other (pre-existing).
- The builder still reads `/published` through the hand `getPublishedState`, so its count and the dialog have separate caches until step 4.
- The dialog's loader-on-reopen relies on the query being stale when `enabled` turns true, i.e. on `queryClient.ts` keeping `staleTime` at 0. A global `staleTime` would quietly bring back a cached inventory with live teardown buttons.
- A loud refresh cancelled by a toggle resolves silently and is replaced by the toggle's quiet re-read, so a failure in that window is not toasted.

## Deferred
- **Step 4, the Flow Builder.**
  - Its 11 flow calls.
  - `useFlowIssues` keeps its ordering, with its 7 tests as the spec. It calls the SDK function directly, not a TanStack mutation.
  - The autosave queue.
  - The install-plan latest-wins guard and the 409 reload.
- **`/api/nodes`.**
- **The journey routes.** They reuse this step's published, undeploy and unpublish schemas.
- **Moving the `getGuildRoles` callers.**
