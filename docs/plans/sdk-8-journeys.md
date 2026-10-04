# SDK step 8: the journey routes and their screens on the SDK — the end of the migration

Follows steps 1–7 (`sdk-1-walking-skeleton.md` … `sdk-7-remaining-routes.md`; step 7 committed as `6335a6b`).

## Why this slice

After step 7 the bridge list (`NOT_YET_IN_SPEC`, ceiling 18) is the 18 journey routes in `src/web/api/journeyRoutes.ts`, and the hand-written client in `web/src/api/` (`client.ts`, `types.ts`, `journeys.ts`) serves only them. Its callers: the two journey dialogs (`JourneyDriftDialog`, `JourneyResourcesDialog`), the resource autosave (`resourceSaveTarget.ts`, `useResourceAutosave.ts`), the Flow Builder's five journey calls (the seam step 6 left), and the flows page's grouping, detach and journey rename. Two server-side gates exist only to hold those hand copies to the server (`driftWireShapeDrift`, `provisioningWireDrift`).

This step converts all 18 routes, moves every caller to `@brattybot/web-sdk`, and deletes the hand client, its types, its drift gates and the bridge itself. Afterwards every `/api` route is in the spec and nothing in `web/` mirrors a server shape by hand.

## Proven before planning (spike, reverted)

- **A transformed schema names cleanly.** `resourceSchema` ends in `.transform(normaliseResourceName)`, so it is a zod pipe. Named with `.openapi('ResourceDeclaration')` and used in both a request body and a response, zod-to-openapi emits one plain object component, `$ref`'d from both. The browser gets one `ResourceDeclaration` type and one `zResourceDeclaration`. The transform stays on the server: `resourceNameMirrorDrift.test.ts` pins that the save route normalises, and the browser already normalises as the operator types.

## Decisions taken

All conventional; none needed Douglas.

### 1. The three refines in the request schemas
`requestMessages.ts` refuses a `.refine()` in a request schema by design. The emit is not weakened; each refine is restructured:

- **`permissionRoleIdSchema`** — "a `resource:` reference must name a valid key". Expressible faithfully as one pattern: *doesn't start with the prefix, or is the prefix followed by a valid key*. Built from `DECLARED_ROLE_PREFIX` and the key pattern, so neither is written twice. It carries the refine's sentence unchanged. `min(1)` stays first with no custom message, so an empty id still gets zod's sentence first; the pattern accepts the empty string so it never adds a second issue there. **Pinned** by a parity table in the shape of `ticketTemplateRuleParity`: the former refine, the new server rule and the generated `zod.gen.ts` rule over the same ids, which must agree on success and on the first sentence.
- **`permissionIntentSchema`'s object refine** — "a `roles` permission must name at least one role". Cross-field, and a discriminated union would change both the sentence a missing `roleIds` gets and the generated `PermissionIntent` type. **Moved into the handler**: one function in `journeyBody.ts`, `rolesWithoutIdsRefusal(resources)`, called right after the validator in the three routes that take resources (`PUT /flows/{flowId}/resources`, `POST /journeys`, `PUT /journeys/{journeyKey}`). Same sentence, same 400, still ahead of every lookup. `resourceChipAgreement.test.ts`'s `serverVerdict` runs it between the schema and `validateJourneyDeclaration`, so its `ruleNamesNoRole (no ids)` row keeps holding the browser chip to it. A route test pins the sentence. The browser does not get this rule from the spec; the red chip already covers it.
- **`bindingIdSchema`** is already a handler check on the raw path parameter. The path declares `bindingId: z.string()`; the handler and its sentence are unchanged.

### 2. The 18 routes on `apiRouter`
- `operationId`s after today's client functions where one exists: `listJourneys`, `getJourney`, `getJourneyPublishedState`, `undeployJourney`, `unpublishJourney`, `getJourneyDrift`, `repairJourneyDrift`, `forgetJourneyOrphan`, `getFlowResources`, `saveFlowResources`, `getFlowAttachment`, `attachFlowToJourney`, `detachFlowFromJourney`, `previewFlowGrouping`, `groupFlowWith`, `createJourney`, `updateJourney`, `deleteJourney`. Tag `journeys`.
- **Wire schemas in a new `src/web/api/journeyBody.ts`**, named after the browser's types (step 3's convention, so the web side is an import swap): `ResourceKind`, `PermissionAudience`, `PermissionAccess`, `PermissionIntent`, `ResourceDeclaration`, `Journey`, `JourneySummary`, `AttachedFlow`, `FlowAttachment`, `AttachResult`, `GroupPreview`, `MovingResource`, `KeyCollision`, `GroupResolution`, `RepairedResource`, `ForgottenOrphan`, and the request bodies `JourneyCreate`, `JourneyUpdate`, `FlowResourcesSave`, `FlowAttach`, `FlowGroup`, `DriftRepair`.
- **`driftBody.ts`** becomes schemas (`JourneyDrift`, `DriftedResource`, `DriftDetail`, `OrphanedResource`, `UncheckedResource`) with `driftBody()` typed by `z.infer`. Its `*_KEYS` lists and their completeness gate go. `kind` stays `z.string()` where the interfaces said `string`.
- **Reused:** `PublishedFlowState`, `UndeployResult`, `UnpublishResult` from steps 3 (`publishedBody.ts`, `installBody.ts`).
- **`RepairedResource.repaired`** is `ResourceDriftKind['kind'][]` with no tuple behind it. `resourceDrift.ts` gains `RESOURCE_DRIFT_KINDS` (TypeScript only, step 3's `JOURNEY_INSTALL_STATES` precedent, held to the union both ways) so the schema can `z.enum` it and `SchemaMatches` holds `RepairedResource`.
- Vocabularies are imported from their defining modules, not the provisioning barrel (route tests mock it partially, and `z.enum` reads at load).
- Domain types sent as they are (`MovingResource`, `KeyCollision`, `RepairedResource`, `PermissionIntent`, `ResourceDeclaration`) are held to their schemas with `SchemaMatches`; builders (`journeyDetail`, `journeySummary`, `driftBody`) return `z.infer`.
- **Path keys stay `z.string()`** (`journeyKey`, `flowId`, `bindingId`): a key rule in the path would turn today's 404s into 400s.
- **`group-preview`'s `target`** is `z.string().optional()` in the query, and the handler keeps "Name the flow being grouped with." — a required string would swap that for zod's sentence.
- **`errorResponse`** becomes a lookup returning `{ status, error }` the handlers `c.json`, as `flowJourney` does in `flowRoutes.ts`: a typed handler cannot return a bare `Response`.
- **Errors declared exactly as sent**, one schema per status; every 404 description names its causes.
- **Test mocks:** `journeyDriftRoutes.test.ts` and `journeyTeardownRoutes.test.ts` mock `undeployFlowButtons` without `importOriginal`; `installBody.ts` reads `UNDEPLOY_OUTCOMES` at load, so both keep the real exports (step 3 follow-up).

### 3. The bridge is gone
`NOT_YET_IN_SPEC` is empty, so it goes, with its ceiling and the three bridge tests (never grows, still served, not yet in the spec). The gate keeps its core assertion — every served `/api` route is in the spec — its sanity check and `KNOWN_MIDDLEWARE`. Its header, `openApi.ts`' header and the `AGENTS.md` bullets stop describing a bridge and a hand client.

### 4. Web: every caller on the SDK
- **Direct SDK calls, not `useQuery`/`useMutation`**, at every existing call site, each keeping its structure: the autosave's request counter and identity checks, the builder's one-shot load and its attach/detach handlers, the dialogs' own load effects and busy flags, the flows page's drop → preview → confirm sequence and its rename. Each already owns its ordering; a query or mutation would add a second owner (step 6's reasoning). `resourceSaveTarget.ts` stays the seam: `loadResources`/`storeResources` keep their signatures and swap their insides.
- `ApiError` comes from `@brattybot/web-sdk` everywhere.
- Types come from the SDK. `PublishedFlowState`/`PublishedResource` (left hand-written by step 6) switch too.
- The SDK serialises path parameters itself; journey keys are `[a-z0-9-]`, so dropping the hand client's `encodeURIComponent` changes nothing.
- **A 401 from a journey call now signs out**, like every other call. A dom test pins it (step 7 follow-up).
- **`detectResourceProblems.ts`** hand-copies the key pattern, its 64 cap and the name's 100 cap. With `ResourceDeclaration` in the spec, the browser has the server's own rules in `zResourceDeclaration`, so the copy is dead: `isValidResourceKey`/`isValidResourceName` ask the generated zod. `resourceChipAgreement.test.ts` already holds the chips to the server.

### 5. Retire
- `web/src/api/journeys.ts`, `client.ts`, `types.ts`.
- `src/web/api/__tests__/driftWireShapeDrift.test.ts` and `provisioningWireDrift.test.ts` — they compare hand copies that no longer exist; the generated types are the server's schemas. `REFUSAL_REASONS` has no value use in the browser, so it needs no `contractValues` row.
- Kept, because they guard behaviour rather than a copy: `journeyDriftRoutes.test.ts` (a route test), `builtinTokenDrift.test.ts` (the engine's token vocabulary, which is not on the wire), `declaredRoleReference.test.ts` (the prefix constant, not in the spec), `resourceNameMirrorDrift.test.ts` (the browser's as-you-type normaliser).

## Behaviour changes (expected)
- **Routes taking a body** (`PUT resources`, `POST attach`, `POST group`, `POST repair`, `POST journeys`, `PUT journeys/{key}`): **415** for a body without a JSON content type; malformed JSON → **400 "Malformed JSON in request body"** where it was zod's "expected object, received null".
- **Body before lookup:** `PUT /journeys/{key}` and `POST repair` validated the body after the journey 404; now before. `attach` and `group` already validated first.
- **A roles-without-ids permission** is judged after the schema, so a request with a schema problem anywhere *and* a roles problem gets the schema's sentence even when the roles problem is on an earlier resource.
- **A repeated `target` query key** on `group-preview` is refused with zod's default sentence (steps 4 and 7 recorded the same).
- **A 401 from any journey call signs the dashboard out**, instead of the page or dialog showing its error.
- **No copy changes.**

## Checks (planned)
- Suite against the baseline (3,020 pass, 1 known failure). Expected delta: −7 drift rows (6 `driftWireShapeDrift`, 1 `provisioningWireDrift`) and the bridge tests, plus the tests below.
- Typechecks: root `tsc` the same 17, `typecheck:e2e` the same 4, web `tsc -b` and the SDK typecheck clean.
- `pnpm sdk:generate` twice, byte-identical.
- New tests: role-id parity table; the roles sentence through the route; 415 and malformed JSON on a journey body route; body before the 404 on `PUT /journeys/{key}`; dom: a journey route answering 401 → the login page.
- e2e: all of `web/e2e`, in particular `journeyDrift`, `journeyInstall`, `flowTeardown`, `resourceAdoption`, `flowBuilderToolbar`.
- Sabotage, each restored and regenerated byte-identical:
  1. the role-id `.refine()` put back → the emit fails naming route and field;
  2. the server role-id pattern loosened → the parity table fails;
  3. the handler's roles check dropped → the agreement row and the route test fail;
  4. a journey route declared with a plain `get` on the returned router → `everyRouteInSpec` fails;
  5. `setupDom`'s `onUnauthorized` a no-op → the journey 401 dom test fails;
  6. the browser key rule made stricter in `zod.gen.ts` → the agreement test fails.

## As built

As planned, with the changes below. Where they contradict the sections above, this section is the record.

### Server
- **All 18 routes are on `apiRouter`**, with the `operationId`s in §2. `NOT_YET_IN_SPEC`, its ceiling and the three bridge tests are gone; `everyRouteInSpec` keeps its core assertion, its sanity check and `KNOWN_MIDDLEWARE`.
- **`journeyBody.ts`** names `ResourceKind`, `PermissionAudience`, `PermissionAccess`, `PermissionIntent`, `ResourceDeclaration`, `Journey`, `JourneySummary`, `AttachedFlow`, `FlowAttachment`, `AttachResult`, `DetachResult`, `FlowGroupResult`, `GroupPreview`, `MovingResource`, `KeyCollision`, `GroupResolution`, `RepairedResource`, `RepairResult`, `ForgottenOrphan`, and the request bodies `JourneyCreate`, `JourneyUpdate`, `FlowResourcesSave`, `FlowAttach`, `FlowGroup`, `DriftRepair`. It also holds `JOURNEY_NOT_FOUND`, `JOURNEY_ERRORS` and `FlowResourcesSchema` (the `{ resources }` both resource routes answer). The flow-scoped journey routes reuse `FLOW_ERRORS`/`FLOW_NOT_FOUND`/`FlowPathSchema` from `flowBody.ts`.
- **`ResourceDeclaration` is defined once**, as the transformed (`normaliseResourceName`) schema, used by every request and response that carries a declaration. `SchemaMatches` holds it, `PermissionIntent`, `MovingResource`, `KeyCollision`, the merge plan and `RepairedResource` to their domain types.
- **The three refines, as decided in §1.** The role-id refine is the pattern `^(?:(?!resource:)[\s\S]*|resource:[a-z0-9]+(-[a-z0-9]+)*)$`, built from `DECLARED_ROLE_PREFIX` and the key pattern, carrying the refine's sentence. The roles-without-ids check is `rolesWithoutIdsRefusal`, asked straight after the validator in `saveFlowResources`, `createJourney` and `updateJourney` (when `resources` is sent). The binding id check is a plain function, `parseBindingId`, with the old schema's two rules and the same single sentence.
- **`driftBody.ts`** is schemas (`JourneyDrift`, `DriftedResource`, `DriftDetail`, `OrphanedResource`, `UncheckedResource`); its `*_KEYS` lists and their gate are gone. Deviation from §2 (review): `DriftDetail.kind` is `z.enum(RESOURCE_DRIFT_KINDS)`, not `z.string()`. The stated reason for a string — an unknown kind must still show — did not hold, since the SDK does no response validation, and the string cost the browser its compiler check on `detail.kind === 'wrongType'`. A resource's `kind` stays a string, as `PublishedResource.kind` does.
- **`resourceDrift.ts`** gains `RESOURCE_DRIFT_KINDS`, held to the union both ways (TypeScript only).
- **`errorResponse`** became `journeyWriteRefusal` (400 or 409) and `declarationRefusal` (400 only, for the update route, whose repo call never raises the duplicate-key error), `c.json`'d by each handler.
- **The group-preview body** copies the merge plan's four fields rather than spreading it.
- **Test mocks:** `journeyDriftRoutes` and `journeyTeardownRoutes` keep `undeployFlowButtons`' real exports (`importOriginal`).

### Web
- **Every journey call is a direct SDK call** at its existing call site, as planned; `resourceSaveTarget.ts` kept its two functions and signatures.
- **Retired:** `web/src/api/journeys.ts`, `client.ts`, `types.ts`. `web/src/api/` holds `queryClient.ts`, `fieldProblems.ts`, `loadErrorMessage.ts`. `ApiError` and every type come from `@brattybot/web-sdk`. The SDK no longer exports `apiErrorFromBody`, whose only outside caller was `client.ts`.
- **Rule copies replaced by the generated zod:** `detectResourceProblems`' key pattern, 64 cap and 100 cap (`zResourceDeclaration.shape.key/defaultName`), and `journeyAttachment`'s 100-character journey-name cap (`zFlowGroup.shape.newJourneyName`).
- **No `contractValues` rows were needed:** the browser uses none of the new vocabularies as values.

### Behaviour changes, final
As listed under *Behaviour changes* above, and nothing else:
- **415** for a body without a JSON content type, and **400 "Malformed JSON in request body"** for malformed JSON (it was zod's "Invalid input: expected object, received null"), on the six body routes.
- **The body is checked before the lookup** on `PUT /journeys/{journeyKey}` and `POST …/repair`. The roles-without-ids refusal now also comes before the journey 404 on the update route, where the old body parse ran after it.
- **A request with a schema problem anywhere and a roles problem** gets the schema's sentence.
- **A repeated `target`** on `group-preview` is refused with zod's default sentence.
- **A 401 from any journey call signs the dashboard out** instead of the dialog or page showing its error.
- **Request bodies:** undeploy, unpublish, detach and forget used to POST `{}`; they now send no body, which none of them reads.
- **No copy changes.** Every refusal sentence and status is unchanged; the new spec descriptions are not user-facing.

### Checks
- **Suite:** 3,060 pass, 2 fail — `ciBranchProductDiff` and the date-dependent birthday "skips overlapping runs", both known — in the last full run, after the review fixes. Baseline 3,020: −6 `driftWireShapeDrift`, −1 `provisioningWireDrift`, −3 bridge tests in `everyRouteInSpec`; +43 `journeyRoleIdRuleParity`, +6 `journeyRoutes` (roles sentence on the flow route and the update route, 415, malformed JSON, body before the 404, normalisation through the route), +1 `signOut`.
- **Typechecks:** root `tsc` the same 17; `typecheck:e2e` the same 4; web `tsc -b` and the SDK typecheck clean.
- **Generation:** `pnpm sdk:generate` twice gives hash-identical spec and 18 generated files, after the sabotage round and again after the review fixes.
- **e2e:** all 13 files, 43 tests, pass — `journeyDrift`, `journeyInstall`, `flowTeardown`, `resourceAdoption` and `flowBuilderToolbar` among them. The known "Failed to update deployed ticket message" log noise is unchanged.
- **Sabotage**, each restored (the generated output re-hashed identical):
  1. a `.refine()` put back on the role-id rule → `pnpm openapi:emit` failed: "PUT /api/guilds/{guildId}/flows/{flowId}/resources body.resources[](in).permissions[].roleIds[]: a `.refine()`/`.superRefine()` rule, which the browser cannot run from the spec";
  2. the server role-id pattern loosened to `resource:[a-z0-9_-]+` → 6 parity cases failed (leading, trailing and double hyphens, on both the server-vs-refine and browser-vs-server rows);
  3. `rolesWithoutIdsRefusal` made to answer nothing → the agreement row `ruleNamesNoRole (no ids)` and three route tests failed;
  4. a `get` added to the router `journeyRoutes()` returns → `everyRouteInSpec` failed naming `GET /api/guilds/{guildId}/journeys-sabotage`;
  5. `setupDom`'s `onUnauthorized` a no-op → the new journey 401 test and the existing page 401 test failed;
  6. `zResourceDeclaration`'s key cap edited to 63 in `zod.gen.ts` → the agreement case "the browser shows no red chip on a key at exactly the 64-character cap" failed;
  7. (after review) `detail.kind === 'wrongType'` misspelled in `driftSummary.ts` → web `tsc -b` failed (TS2367, no overlap);
  8. (after review) the transform made to pass the name through → the new "stores a text channel under the name Discord will hold, through the route" test failed.
- **Not verified by a test:**
  - the flows page's drag → preview → group sequence, its leave-group detach and its journey rename, and the builder's attach and detach, through the SDK. No dom or e2e test drives them; they rest on web `tsc -b` and the reviewers' read of each call's unwrap. The e2e do drive the resource autosave (`PUT …/resources`), drift and repair, and both teardowns;
  - that the SDK serialises a journey key in a path exactly as `encodeURIComponent` did (keys are `[a-z0-9-]`, so there is nothing to encode).
- **Review:** one pass, `generic-reviewer-domain-runtime` and `generic-reviewer-maintainability` run directly. No Critical or High.
  - **Fixed:** `FLOW_ERRORS` declared twice (Medium); `DriftDetail.kind` typed as a string on a false premise (Medium); the dead `apiErrorFromBody` export; `repairBody` renamed `DriftRepairSchema`; `DetachResult` and the `{ resources }` response moved into `journeyBody.ts`; the group route's 400 description now names the declaration refusal; stale text in `driftSummary.ts`, `resourceMeta.ts`, `installSummary.ts` (the fallback is now justified by a tab left open across a deploy), two test comments and the `resourceSchema` alias; normalisation pinned through the route.
  - **Recorded rather than fixed:** see Follow-ups.

### Follow-ups
- **The 64-character key cap is still written twice in `web/`**, as `.slice(0, 64)` in the slugifiers in `journeyAttachment.ts` and `resourceAdoption.ts`, and `resourceChips.ts`' `invalidKey` reason restates the pattern in prose (review, Medium). These shape a value rather than judge one, so they cannot refuse what the server accepts, but they can fall out of step. Reading `zResourceDeclaration.shape.key.maxLength` needs a decision on its `number | null` type. Both slugifiers also trim hyphens before slicing, so a 64th character that is a hyphen yields a key the server refuses (pre-existing).
- **Display-order lists are not checked for completeness:** `AUDIENCE_ORDER`/`ACCESS_ORDER` in `PermissionIntentEditor.tsx` and `RESOURCE_KIND_ORDER` in `resourceMeta.ts` are typed by the generated unions, but a member the server adds would simply not be offered (review, Low, pre-existing). A `contractValues`-style row would close it.
- **`SchemaMatches` checks in `journeyBody.ts` run in root `tsc` only**, as in steps 3, 4 and 7; only `nodeBody.ts` has a `.test-d.ts`. Nothing the suite ran before this step is lost: the deleted drift tests compared browser copies, which no longer exist.
- **An unexpected throw from a journey route** reaches the parent's error handler as a 500 that is not an `ErrorBody` and is not declared, as step 3 recorded for `GET /flows`.
