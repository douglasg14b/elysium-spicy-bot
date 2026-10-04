# SDK step 6: the Flow Builder on the generated SDK, and `/api/nodes` in the spec

Follows steps 1–5 (`sdk-1-walking-skeleton.md` … `sdk-5-block-field-rules.md`; step 5 committed as `590e005`).

> **Built, and in three places superseded by its own "As built"**, which is the record where they differ:
> - The load reads the block catalogue and the guild directory through `queryClient.fetchQuery` (§6).
> - The descriptor checks are asserted in `pnpm test`, not only root `tsc` (§3).
> - A failed published read keeps the last live keys while the count goes unknown (§6).

## Why this slice

The Flow Builder is the last big caller of the hand-written flow client. Step 3 put all 15 flow routes in the spec but left the builder on `web/src/api/flows.ts`, because its load also called `/api/nodes` and a journey route, neither in the spec, and its ordering hooks needed care of their own. Step 5 put the block field rules on the build-time path and left `/api/nodes` (the 11-arm `BlockConfigField` union, 12 controls today) for this step.

This step moves the builder, its hooks and the dialogs it owns onto `@brattybot/web-sdk`, puts `/api/nodes` in the spec, and deletes the hand client functions, hand types, `*_KEYS` lists and drift tests that this makes dead.

## Proven before planning (spikes, kept)

- **`NodeDescriptor` states as zod and generates cleanly.** `src/web/api/nodeBody.ts` holds every manifest type to its schema with `SchemaMatches`, per control arm through a mapped type. Root `tsc` is unchanged at 17 errors. The generated `BlockConfigField` is a plain union of object types discriminated on `control`, so `Extract<…, { control: 'text' }>` and the controls' exhaustive switches work unchanged. `BlockPaletteGroup` and `EligibilityPermission` generate as named `z.enum`s whose `.options` keep their order. `zEligibility` arms are `z.object({ principal: z.enum(['anyone']) })`, so the principals can be read off it.
- **The path is `GET /api/nodes`.** A route at `/` mounted at `/api/nodes` emits `/api/nodes`, the same as `listGuilds`. `everyRouteInSpec`, `openApiSpec`, the stale-SDK gate, `nodeRoutes.test` and `oneDirectoryBlock.test` pass.
- **Absence markers don't travel.** zod-to-openapi refuses `z.never()` (`UnknownZodTypeError`), even with an explicit `.openapi({ not: {} })`. `BlockCardSummaryPart`'s `text?: undefined` / `key?: undefined` therefore can't be stated. The arms are checked member by member without them, the union both ways by assignability. The browser tells the arms apart with `'key' in part`.
- **Root `tsc` can see the SDK's contract, and only that.** Mapping `@brattybot/web-sdk` to the SDK's `index.ts` costs exactly two root errors, both `BodyInit` in the fetch client (the root has no DOM library). `types.gen.ts` imports nothing and `zod.gen.ts` imports only `zod`.

## Decisions taken

### 1. Journey routes stay on the hand client until step 8
`PUT /flows/{flowId}/resources`, `PUT /journeys/{key}` and `POST /journeys` take `resourceSchema`, whose `permissionRoleIdSchema` is `z.string().min(1).refine(…)` (`journeyRoutes.ts:82`). A `.refine()` in a request schema fails the emit by design, so converting those means restructuring that rule: that is step 8's work. Converting only the GETs (resources, attachment, journey list) would leave `ResourceDeclaration` existing twice, generated for reads and hand-written for writes. That is worse than today.

**The seam:** `web/src/api/journeys.ts` stays whole, as do the journey block of `types.ts` and its gates (`provisioningWireDrift`, `driftWireShapeDrift`). The builder's load keeps `getFlowResources` beside its SDK calls. Its attach, detach, attachment and journey-list calls are unchanged. `PublishedFlowState`/`PublishedResource` stay hand-written for `JourneyResourcesDialog` and `publishedSummary`, which serve both flows and journeys.

### 2. Root `tsc` resolves the SDK to its contract
A new hand-written `packages/web-sdk/src/contract.ts` re-exports `gen/types.gen` and `gen/zod.gen`. The root `tsconfig.json` gets `paths: { "@brattybot/web-sdk": ["packages/web-sdk/src/contract.ts"] }`, with a comment saying why.

This is what lets dashboard modules that root tests import (`cardSummary`, `nodeMeta`, `variables`, `liveFieldIssues`, `controls/types`, `detectResourceProblems`, …) be typed by the generated contract. Without it, deleting the hand `NodeDescriptor` adds root errors.

The root's `lib` stays `ESNext`: widening a Node program to the DOM for two type names would hide real mistakes. A root-reached module that imports a query helper or `ApiError` fails the root type-check loudly, which is correct.

Runtime is unaffected. Vitest uses no tsconfig paths, and resolves the package from `web/node_modules`.

### 3. `/api/nodes` on `apiRouter`
- `operationId: 'getNodeTypes'`, after today's client function.
- `AUTHED_ERRORS` only, because the route is authed but not guild-scoped.
- The response is `{ nodes: NodeDescriptor[] }`.
- `NON_WIRE_MEMBERS`, `toDescriptor` and `NonWireMembersAreWithheld` stay: they decide what is withheld. `SchemaMatches` against `Omit<BlockManifest, NonWireMember>` now replaces the browser drift test's guarantee. A manifest member added without a schema line is a compile error in `nodeBody.ts` (root `tsc`; `pnpm test` does not see it, as with step 3's builders).
- Named components: `NodeDescriptor`, `BlockConfigField`, `BlockConfigOption`, `BlockConfigColumn`, `BlockCardSummaryPart`, `BlockOutputHandle`, `BlockHandleTone`, `BlockOutputDeclaration`, `BlockOutputValueKind`, `BlockPaletteGroup`, `Eligibility`, `EligibilityPermission`.
- `Eligibility` is rebuilt arm by arm from `eligibilitySchema.options`, with the permissions through the named enum.
- Bridge ceiling 28 → 27.

### 4. Browser vocabularies come off the generated zod
- `BLOCK_PALETTE_GROUPS` → `zBlockPaletteGroup.options`.
- `ELIGIBILITY_PERMISSIONS` → `zEligibilityPermission.options`.
- `ELIGIBILITY_PRINCIPALS` → read off `zEligibility.options`.
- `FLOW_GRAPH_VERSION` → `zFlowGraph.shape.version.value`.

Each lives in one small web module, so no caller re-derives it. The other hand vocabularies (`NODE_KINDS`, `BLOCK_CONTROL_TYPES`, `BLOCK_COLUMN_CONTROLS`, `BLOCK_HANDLE_TONES`, …) exist only for the drift test and go with it. Their types become indexed types of the generated ones, e.g. `NodeDescriptor['kind']`.

### 5. Hand-authored limits on `BlockConfigField` stay (step 5 follow-up, decided)
`maxLength`, `optional`, `minEntries` and `maxEntries` stay manifest members. Once `/api/nodes` is in the spec, they are server-declared and typed by the generated contract, so they are not a browser copy. Douglas's rule is against browser copies of server rules.

Two of them can't be derived anyway:
- `textList.maxLength` is per **entry**, and step 5 made arrays `z.array(z.unknown())`.
- `optional` means "clearing removes the key", and every `FlowBlockFieldRules` field is `.optional()` by design.

Deriving the other two (`text`/`longText` `maxLength`, and the entry bounds) would leave one concept with two sources. `conformance.ts` already holds all four to the block's schema.

### 6. The builder: queries for views, direct SDK calls for seeds and ordered writes
The load seeds editable canvas state once. A `useQuery` whose data fed that effect would re-seed the canvas on any refetch, taking the author's edits with it. So:

- **Load:** the one-shot `Promise.all` stays, with the cancellation flag. It calls the SDK functions `getFlow`, `getNodeTypes`, `getGuildRoles` and `getGuildChannels`, plus the hand `getFlowResources`. Drafts are read after the flow, as today.
- **Installed count:** `useQuery(getPublishedStateOptions)` keyed by guild and flow, the same key `InstalledResourcesDialog` uses. `refreshInstalledCount` becomes an invalidation. A failed read still shows the install face (`isError` → `null`), not the last count. This closes step 3's "separate caches" follow-up.
- **Save, toggle, deploy, install plan, install, draft list, draft discard:** direct SDK calls at the existing call sites. Each keeps its structure:
  - the `settle()`-then-PUT in `handleSave`;
  - the install-plan request counter (latest wins);
  - the 409 → `loadInstallPlan` reload;
  - the optimistic toggle with revert.

  They are not `useMutation`s: each handler already owns its pending state and ordering, and a mutation would add a second owner.
- **`useFlowIssues`:** calls the SDK's `checkFlow` directly, never as a query or mutation, because the hook's ordering rules are the contract. Its test mocks `@brattybot/web-sdk` with `importOriginal`, so `zFlowBlockFieldRules` stays real and the live checks can still fail. Only the fixture's shape changes (`{ data: { issues } }`); the 7 cases are unchanged.
- **`useFlowDraftAutosave`:** the queued write calls the SDK's `saveMyFlowDraft`. The queue is untouched.
- **`ResourcesDialog`'s guild directory:** `useQuery(getGuildRolesOptions)` and `useQuery(getGuildChannelsOptions)`, enabled while open. Query-core keeps the last data on a failed refetch, so `data ?? []` still means "a failed refresh leaves what we had".
- **Never disable an input being typed into.** No `disabled={saving}` is added anywhere. The builder's name box and inspector stay enabled during saves, as today.

### 7. Retire what this makes dead
- **`web/src/api/flows.ts`:** deleted. Every function in it is replaced.
- **`web/src/api/config.ts`:** deleted (`getGuildChannels`, whose last callers were the builder and the resources dialog).
- **`web/src/api/types.ts`** loses:
  - the guild directory (`GuildChannel`, `GuildRole`, `GUILD_CHANNEL_TYPES`, `GuildChannelType`, their keys and gate);
  - the whole node section (vocabularies, `NodeDescriptor`, `BlockConfigField` and its parts, every `*_KEYS` list);
  - the flow section (`FlowNode`, `FlowEdge`, `FlowGraph`, `FLOW_GRAPH_VERSION`, `Flow`, `FlowDraft*`, `FlowSaveResult`, `FLOW_*_KEYS`, `FlowValidationIssue`);
  - `DeployResult`/`DeployedButtonMessage`;
  - `InstallPlan`, `InstallPlanItem`, `InstallResult`, `InstalledResource` and `INSTALL_PLAN_ACTIONS`, if nothing on the journey side still uses them.

  Each one goes only when nothing outside migrated code uses it. Every consumer imports the generated type instead.
- **Tests:**
  - `nodeDescriptorDrift.test.ts`, deleted;
  - `flowWireShapeDrift.test.ts`, deleted, with the server's `FLOW_*_KEYS` in `flowBody.ts`;
  - `guildWireShapeDrift.test.ts`, deleted (it says it retires with this mirror);
  - the `INSTALL_PLAN_ACTIONS` row in `provisioningWireDrift`, if that type goes;
  - `flowRoutes.test.ts`'s browser-side issue check, which shrinks to the SDK side.
- Root tests that import a browser descriptor type (`oneDirectoryBlock`, `blockFieldRules`, `fieldVisibilityDrift`) import the generated one.
- `docs/contracts/block-authoring.md` and `manifest.ts`' JSDoc: the mirror-and-drift-test paragraph becomes "state it in `nodeBody.ts`".
- AGENTS.md: no change expected. Its dashboard bullets don't name the hand client.

## Behaviour changes

**`/api/nodes` on `apiRouter`:** none a caller can see. It is a GET with no body, query or path parameters, so no 415 or malformed-JSON case applies. A 401 is still `requireAuth`'s.

**Builder:**
- The installed count re-reads whenever the installed-resources dialog's own read or teardown changes the shared cache, not only on load and after an install. It is the same answer, so it is fresher, not different.
- No copy changes.

## Checks (planned)

- **Suite** against the baseline: 3,053 pass, 1 known failure (`ciBranchProductDiff`). The net change is the tests added minus the drift rows deleted.
- **Typechecks:**
  - root `tsc`: the same 17;
  - `typecheck:e2e`: the same 4;
  - web `tsc -b` and the SDK typecheck: clean.
- **`pnpm sdk:generate`** twice gives byte-identical output.
- **e2e:** `flowLeavePrompt`, `flowDrafts`, `flowIncomplete`, `flowInstall`, `resourceAdoption`, `exitWarnings`, `flowDelete`, `flowTeardown`. Add a builder deploy e2e if `web/e2e/support` can observe a posted button message; otherwise record deploy as unrun.
- **Sabotage**, each restored and regenerated byte-identical:
  1. a member dropped from `NodeDescriptorSchema` → root `tsc` names `nodeBody.ts`;
  2. a control arm's member dropped → root `tsc` names the arm;
  3. a generated arm made to disagree → web `tsc -b` fails in `controls/`;
  4. the root `paths` entry removed → root `tsc` gains errors in the root-reached web modules;
  5. `useFlowIssues`' `zFlowBlockFieldRules` mocked away → its live-check case fails, proving the `importOriginal` mock keeps the checks real;
  6. the installed count read from `data` regardless of `isError` → a test, if one can be written cheaply, otherwise reasoned.

## As built

As planned, with the changes below. Where they contradict the plan above, this section is the record.

### Server
- **`GET /api/nodes` is on `apiRouter`** (`operationId: getNodeTypes`, `AUTHED_ERRORS`, response `{ nodes: NodeDescriptor[] }`). `NON_WIRE_MEMBERS`, `toDescriptor` and `NonWireMembersAreWithheld` are unchanged. Bridge ceiling 28 → 27.
- **`src/web/api/nodeBody.ts`** states the descriptor. Named components: `NodeDescriptor`, `BlockConfigField`, `BlockConfigOption`, `BlockConfigColumn`, `BlockCardSummaryPart`, `BlockOutputHandle`, `BlockHandleTone`, `BlockOutputDeclaration`, `BlockOutputValueKind`, `BlockPaletteGroup`, `Eligibility`, `EligibilityPermission`.
- **The checks are one exported type, and `pnpm test` asserts it** (review finding, High). The plan put them in root `tsc` only, which is not in CI, and `pnpm test`'s typecheck ignores source errors — so the step had removed a gate the suite ran and replaced it with one it didn't. Now:
  - `NodeBodyChecks` maps every check to `SchemaMatches`/assignability;
  - `NodeBodyMismatch` names the failing ones;
  - `src/web/api/__tests__/nodeBody.test-d.ts` asserts it `never`, so a drift fails the suite naming the check (`"configField.textList"`, `"BlockOutputDeclaration.fixed"`, `"visibleWhen"`). One in-file anchor says the same to root `tsc`.
- **Checked member by member, not just as unions** (review finding, Medium). `SchemaMatches` compares names one level deep, and a union's `keyof` names only what the arms share, so an optional member added to one arm would have passed a check of the whole. Each of these is checked on its own: the 12 control arms, both output arms, both exit-warning forms, `visibleWhen`, `valueKindFrom`, the hand-stated `discordPermission` gate, and the two card-summary arms. The unions are also checked whole (assignability both ways), which catches an arm added or dropped.
- **`BlockCardSummaryPart`'s absence markers don't travel.** zod-to-openapi refuses `z.never()`. The arms are checked without `text?: undefined` / `key?: undefined`, and `cardSummary.ts` tells them apart with `'key' in part`.
- **`flowBody.ts`** loses `FLOW_*_KEYS`, `FLOW_SAVE_TARGETS` and their completeness check. The `*Body` aliases stay, because they type the builders.

### Root type-check
- `packages/web-sdk/src/contract.ts` re-exports `gen/types.gen` and `gen/zod.gen`, and the root `tsconfig.json` maps `@brattybot/web-sdk` to it.
- From `src/` this is **types only**: at run time nothing under `src/` can resolve the package. A root file needing a value imports it by relative path, as `blockFieldRules.test.ts` does (review finding; now said in the tsconfig comment and AGENTS.md).

### Web
- **Load:** the one-shot `Promise.all` calls `getFlow` directly and reads the node types, roles and channels through `queryClient.fetchQuery(…Options)`. The plan said direct calls for all four. `fetchQuery` always asks (the client sets no `staleTime`) and fills the cache `ResourcesDialog` reads, so its pickers open already populated. The flow itself stays out of the cache: it seeds the canvas.
- **Installed count and keys:** `useQuery(getPublishedStateOptions)`, sharing its key with `InstalledResourcesDialog`, and derived through `installedFromPublished` in `publishedSummary.ts`.
  - **A failed read makes the count unknown but keeps the last live keys** (review finding, High). The first cut gated both on `isError`, so any failed read — now including the dialog's own — released keys bound in the guild, letting a rename move them and orphan their bindings. The old code kept them, and so does this. Unit-tested.
  - The `onChanged` refresh is gone: the dialog re-reads the shared query before calling back. The new e2e proves the toolbar follows.
- **Direct SDK calls** for save, toggle, deploy, install plan, install, draft list and discard, with each structure as it was. `draftId` goes as a string path parameter, as the route declares it.
- **`useFlowIssues`** calls the SDK's `checkFlow`. Its test mocks `@brattybot/web-sdk` with `importOriginal` and adapts only the call shape; the 7 cases are unchanged.
- **`useFlowDraftAutosave`** queues the SDK's `saveMyFlowDraft`; the queue itself is untouched.
- **`ResourcesDialog`:** two queries, enabled while open. A side effect: the two lists now load independently, so a failed roles read no longer withholds a good channels read.
- **`web/src/flows/contractValues.ts`** holds the graph version, palette groups and gate vocabularies, read off the generated zod. `src/web/api/__tests__/contractValues.test.ts` holds each to the server's list, in order.
- **Generated types replace the hand ones** across 50-odd web files (node, flow, draft, install, guild-directory types). `GuildChannel`/`GuildRole` moved too, since their only fetchers are now SDK calls; `guildWireShapeDrift.test.ts` says it retires with that mirror.

### Retired
- `web/src/api/flows.ts` and `web/src/api/config.ts`.
- From `types.ts`: the guild-directory, node, flow, draft, deploy and install types, with every `*_KEYS` list.
- `nodeDescriptorDrift.test.ts`, `flowWireShapeDrift.test.ts`, `guildWireShapeDrift.test.ts`, the install-actions row of `provisioningWireDrift`, and the browser half of `flowRoutes.test.ts`' issue check.

### Behaviour changes
- **`/api/nodes`:** none a caller sees. It is a GET with no inputs.
- **Builder toolbar:**
  - The installed count follows any read of the shared published query, including the inventory dialog's.
  - A failed read in the dialog now also turns the toolbar to "Install N" until the next good read. That is the documented safe default (it proposes creating, not destroying), and the live keys are kept regardless.
- **No copy changed.**

### Checks
- **Suite:** 3,019 pass, 2 fail — `ciBranchProductDiff` and the date-dependent birthday "skips overlapping runs", both known. Baseline 3,053:
  - −33 `nodeDescriptorDrift`, −6 `flowWireShapeDrift`, −3 `guildWireShapeDrift`, −1 `provisioningWireDrift` row;
  - +4 `contractValues`, +3 `installedFromPublished`, +1 `nodeBody.test-d`, +1 e2e.
- **Typechecks:** root `tsc` 17 (the same list, diffed); `typecheck:e2e` 4; web `tsc -b` and the SDK typecheck clean.
- **Generation:** `pnpm sdk:generate` twice gives hash-identical spec and 18 generated files, and the review fixes changed neither.
- **e2e:** all 13 files pass, including the new `web/e2e/flowBuilderToolbar.test.tsx` ("goes back to offering an install once its inventory has uninstalled everything").
  - **Deploy has no e2e:** `deployFlowButtons` finds the guild through the `DISCORD_CLIENT` singleton, which the e2e app never logs in (`dashboardApp.ts` says so), so in this harness a deploy can only be refused.
- **Sabotage**, each restored (hashes compared after the generated ones):
  1. `createsChannel` dropped from `NodeDescriptorSchema` and `maxLength` from the `textList` arm → root `tsc` named both in `nodeBody.ts`. After the review rework: an optional member added to the manifest's `fixed` output arm alone → `nodeBody.test-d.ts` failed with `ExpectNever<"BlockOutputDeclaration.fixed">`; one added to `visibleWhen` → `ExpectNever<"visibleWhen">`.
  2. `options` removed from the `select` arm and the SDK regenerated → web `tsc -b` failed in `ChoiceControls.tsx` and `cardSummary.ts`.
  3. The root `paths` entry renamed → root `tsc` went from 17 to 37 errors, in the root tests and the web modules they reach.
  4. `zFlowBlockFieldRules` mocked to `{ shape: {} }` in `useFlowIssues.test.tsx` → 2 of its 7 cases failed.
  5. The builder's published query given its own key → the toolbar e2e failed ("Install 1" never appeared).
  6. `ELIGIBILITY_PRINCIPALS` derivation shortened by one → `contractValues.test.ts` failed.
  7. The installed keys gated on `failed` (the regression the review found) → the "keeps the keys when a refresh fails" case failed.
- **Review:** one pass, `generic-reviewer-domain-runtime` and `generic-reviewer-maintainability` run directly.
  - **Fixed:**
    - the released keys (High);
    - the gate outside `pnpm test` (High);
    - checks of the whole, not per arm (Medium);
    - the `src/` value-import trap of the `paths` mapping (Medium);
    - the key computed once with no lint disable, and `refreshInstalledCount` renamed `rereadPublished`;
    - the `types.ts` header;
    - the block-authoring reason clause;
    - the `staleTime` dependency named in the load comment;
    - the `liveFieldIssues` reason;
    - the eligibility arm-order comment.

### Follow-ups
- **Deploy e2e.** `deployFlowButtons` reads `DISCORD_CLIENT` where every other route uses the route's guild. Handing it the guild would let the harness drive a deploy end to end.
- **Journey routes (step 8)** carry `resourceSchema`'s `.refine()`, which must be restructured before they can enter the spec. `PublishedFlowState`/`PublishedResource` stay hand-written until then, for `JourneyResourcesDialog` and `publishedSummary`.
- **`staleTime` stays 0 everywhere.** The installed dialog's loader-on-reopen (step 3) and the load's `fetchQuery` both depend on it.
- **`docs/plans/sdk-coordinator-brief.md`** has an uncommitted edit that predates this step: the "Never use `git stash`" bullet, which sits inside the Baselines list. Review flagged its placement; it is the coordinator's file, so this step left it alone.
- **Could be committed in two parts** (review Low): the `/api/nodes` contract change first, then the builder migration and deletions.
