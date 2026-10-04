# SDK step 10: the server and tooling follow-ups left by steps 1–9

Follows steps 1–9 (`sdk-1-walking-skeleton.md` … `sdk-9-session-expiry.md`; step 9 committed as `752cd19`).

## Why this slice

Douglas asked for the follow-up lists to be cleared (2026-10-04). This step takes the server and tooling items; step 11 takes the web ones (guild-switch save overlap, `togglingId`, refresh toasts, `staleTime`, browser-side rule copies, stale page comments). Each item below names the Follow-ups entry it comes from. Each was checked against the tree before planning.

## Decisions taken

All conventional; none needed Douglas.

### 1. Line-ending noise (steps 4 and 6, and the brief's trap)

**Checked:** real, and the cause is narrower than "the generator writes LF". With `core.autocrlf=true` a *checkout* writes these files CRLF; the generator then rewrites them LF. The index's recorded size no longer matches, and git reports a size change as modified without comparing content, so `git status` (and `sdk:check`, which reads it) lists the file while `git diff` is empty. Reproduced: `rm` + `git checkout --` on `sdk.gen.ts` and `openapi.generated.json` (both now `w/crlf`), then `pnpm sdk:generate` → both listed as ` M` with an empty diff. Files the generator last wrote and git never re-checked-out are `w/lf` and stay clean, which is why the noise comes and goes.

**Fix at the owner:** a root `.gitattributes` with `eol=lf` for `generated/**` and `packages/web-sdk/src/gen/**`, so a checkout writes what the generator writes. The index already holds LF for every one of these files (`i/lf`), so there is nothing to renormalise in the index; the working copies are refreshed once so their recorded stat matches.

`scripts/checkSdk.ts` stays as it is: `git status --porcelain` is content-correct once a checkout and the generator agree, and it is what sees an untracked generated file.

### 2. Undeclared 500s (steps 3 and 8)

**Checked:** real. `buildApp` (`src/web/server.ts`) sets no `onError`. `apiRouter`'s `onError` rethrows anything that isn't an `HTTPException` (on purpose, so the e2e app's `onFault` sees crashes), and the root then answers with Hono's default: `Internal Server Error` as plain text. Not `ErrorBody`, and no route declares a 500.

- **The root owns it.** `buildApp` gets an `onError`: an `HTTPException` still answers with its own response (Hono's default for those, kept); anything else is logged server-side with method and path and answered `{ error }` 500 with one fixed sentence that leaks nothing. The root, not `apiRouter`, because a throw from the auth middleware (`requireAuth`, `requireGuildAccess`) never passes through a router's `onError`, and because the e2e app's `onFault` depends on routers rethrowing.
- **Declared once, in `apiRouter`.** Its registrar adds `500: errorBodyResponse(…)` to every route it registers, so no route can forget it and the 30-odd status maps stay as they are. `openApiSpec.test.ts` pins that every operation in the spec declares a 500 `ErrorBody`.
- `web/e2e/support/dashboardApp.ts` is unchanged: its own `onError` still reports to `onFault`.

### 3. Ticket-type key longer than 64 characters (step 4)

**Checked:** real. `TicketTypeKeySchema` has no maximum; `ticketRoutes.ts`' list filter caps `?type=` at 64, so a longer key saves but cannot be filtered on.

- `ticketTypeRules.ts` exports `TICKET_TYPE_KEY_MAX_LENGTH = 64` and the key rule gains `.max(64, '…')` after `.min(1)`, with a fixed sentence in the bot's voice so it travels to the browser through the spec.
- `ticketRoutes.ts`' filter reads the exported constant instead of its own copy, and its comment stops describing the gap.
- Only `setTicketTypes.ts` (on upsert) and the save route parse the key. Nothing validates stored types on load, so an existing longer key still loads and still works; it can no longer be *edited*, and can still be deleted (the delete path is `z.string()`).

### 4. Deploy has no e2e (step 6); ticket panel log noise (step 4)

**Checked:** both real, and the same cause. `deployFlowButtons`, `undeployFlowButtons` (which deploy calls to retire what is live) and `updateDeployedTicketMessage` each find the guild through the `DISCORD_CLIENT` singleton, which the e2e app never logs in. Every other route uses the guild the route already resolved (`c.get('guild')`). The ticket line, "Failed to update deployed ticket message: Expected token to be set for this request", is `updateDeployedTicketMessage`'s `DISCORD_CLIENT.channels.fetch` failing on the unlogged singleton.

- `deployFlowButtons(guild, flowId, deps)` and `undeployFlowButtons(guild, flowId, deps)` take the `Guild`. Their `getGuild` dependency and their "That server is unavailable right now" branches go: the caller holds the guild. Callers: the deploy and undeploy routes and the journey undeploy route pass `c.get('guild')`; `/flow-deploy` passes `interaction.guild`.
- `updateDeployedTicketMessage(guild)` fetches the channel through `guild.channels`. Callers: the ticket settings route and the ticket config modal.
- **New e2e:** a flow with a button trigger, deployed from the Flow Builder's Deploy dialog, lands its message with its button in the channel TestDiscord holds; deploying again replaces it (which runs the undeploy path through the route's guild too).
- `ticketActions.test.tsx` must run without the log line.

### 5. Wire-shape checks that only root `tsc` runs (steps 3, 4, 7, 8)

**Checked:** real. `pnpm test`'s typecheck mode sets `ignoreSourceErrors`, so a `const x: SchemaMatches<…> = true` that fails inside a body file is invisible to it. Only `nodeBody.ts` has a `.test-d.ts`.

- **`nodeBody`'s shape, copied:** each file gathers its checks into one `…Checks` type and exports `…Mismatch` (the names of the failing checks, `never` when all hold); a `.test-d.ts` beside the API tests asserts it `toBeNever()`. The file keeps one anchor so root `tsc` and the editor still flag a drift where it happens.
- **Covered:** `flowBody.ts` (3), `installBody.ts` (4), `journeyBody.ts` (6), `publishedBody.ts` (2), `ticketBody.ts` (2), and two guards of the same class: `nodeRoutes.ts`' `NonWireMembersAreWithheld` and `resourceDrift.ts`' `RESOURCE_DRIFT_KINDS` completeness.
- `levelingBody.ts`, `guildBody.ts` and `driftBody.ts` hold no such checks (their bodies are `z.infer` of their schemas), so there is nothing to move.

### 6. Extractor tidy-ups (step 5)

- **Walk labels.** A key that is not a plain identifier is written bracketed and quoted, so a block type's dots no longer blur into the field path: `components.schemas ["test.block"].name` where it read `components.schemas .test.block.name`. Route labels are unchanged (their keys are identifiers). **The component's name is not added:** the registry hands `attachRequestMessages` the schema without its name, and reading it back needs `@asteasolutions/zod-to-openapi`'s `getRefId`, which `@hono/zod-openapi` does not re-export. A direct dependency for one label, on a component that is the only one registered this way, is not worth it.
- **`isFormatSchema`.** A format schema's message (`z.int('…')`) is the schema's own `error`, and the non-format branch already reports a schema's own fixed sentence as having no keyword to travel beside. The special case goes: every schema's own `error` is judged once, the format schema is no longer pushed among its checks, and `inspectCheck` loses the flag. The `z.int('…')` emit failure stays (pinned by `requestMessages.test.ts`).
- **`blockWith`** moves to `src/features/flows/logic/__tests__/support/blockWith.ts`, used by both test files.

## Behaviour changes (expected)

- **An unhandled error under `/api`** answers 500 `{ "error": "…" }` (sentence in §As built) instead of plain-text `Internal Server Error`, and is logged with its method and path. Every operation in the spec declares the 500.
- **A ticket-type key over 64 characters is refused** on save, with a new sentence (§As built). Existing longer keys load and work, can't be edited, can be deleted.
- **Deploy and undeploy** no longer answer "That server is unavailable right now…": the guild comes from the route, which already answers 404 for a guild the bot is not in.
- **Deploy works in the e2e harness and the preview server**, and so does the ticket panel refresh.
- **Emit failure labels** for keys that are not identifiers are bracketed.

## Checks (planned)

- Suite against the baseline (3,077 pass, 1 known failure). Expected delta: the type-check files, the 500 pin and handler test, the key-cap case, the deploy e2e; minus the deploy/undeploy "no guild" unit cases.
- Typechecks: root `tsc` the same 17, `typecheck:e2e` the same 4, web `tsc -b` and the SDK typecheck clean.
- `pnpm sdk:generate` twice, byte-identical; then `git status` clean for the generated paths and `pnpm sdk:check` green; the CRLF repro re-run with the attribute in place.
- e2e: all of `web/e2e`, in particular the new deploy case and `ticketActions` (with the log line gone).
- Sabotage, each restored and regenerated byte-identical:
  1. `buildApp`'s `onError` removed → the 500 handler test fails;
  2. `apiRouter` no longer adding the 500 → the spec pin fails;
  3. the key cap removed → the rules test fails;
  4. a member added to one side of a `SchemaMatches` in two different body files → the matching `.test-d.ts` fails, naming the check;
  5. the deploy route handed a different guild lookup (the singleton) → the deploy e2e fails;
  6. the `z.int('…')` report dropped → `requestMessages.test.ts` fails.

## As built

As planned, with the changes below. Where they contradict the sections above, this section is the record.

### 1. Line endings
- **`.gitattributes`** (new, root): `generated/** eol=lf`, `packages/web-sdk/src/gen/** eol=lf`, cross-referenced with `GENERATED_PATHS` in `scripts/checkSdk.ts` (a comment each way). The index already held LF for all 19 files, so no renormalise commit is needed; the two working copies the repro had left CRLF were refreshed by re-checkout.
- `checkSdk.ts`'s logic is unchanged.
- **Other checkouts** (the main checkout, other worktrees) pick the attribute up on their next checkout of those paths; until then they can still show the old noise.
- **The coordinator brief's "Line endings" trap is now stale**: after this step, a generated file `git status` lists is a real change. The brief is the coordinator's file, so this step left it alone.

### 2. Undeclared 500s
- **`buildApp`'s `onError`** (`src/web/server.ts`): an `HTTPException` answers with its own response through `c.newResponse` (Hono's default, which keeps headers already set on the context); anything else is logged as `[web] <METHOD> <path> failed:` with the error, and answered `{ error: UNEXPECTED_ERROR_SENTENCE }` 500 under `/api/`, plain-text `Internal Server Error` elsewhere.
- **`apiRouter`** adds `500: ErrorBody` ("Something failed that the route did not expect. The server logged it.") to every route it registers, **underneath** the route's own responses. Deviation found in review: the first build spread it last, which overwrote the four designed 500s (`DECLARATIONS_UNREADABLE` on three routes and the PUT flow's "Saved." 500). Their descriptions now end "Or something else failed unexpectedly."
- **`web/e2e/support/dashboardApp.ts`** keeps its own `onError`, still reporting to `onFault`, and now answers with the same `UNEXPECTED_ERROR_SENTENCE`, so a page under e2e or preview shows production's words.
- **Pinned:** every operation in the spec declares a 500 `ErrorBody`; `GET /flows/{flowId}` keeps its own 500 description; a throwing route and a throwing middleware both answer the JSON 500 and are logged (`buildApp.test.ts`).

### 3. Ticket-type key cap
- `TICKET_TYPE_KEY_MAX_LENGTH = 64` and the rule `.max(64, 'Keep the key to 64 characters or fewer. It is an identifier, not a confession.')`, between the blank and pattern rules. `zod.gen.ts`' `zSaveTicketTypePath.type` gained the same `.max(64, …)`. The `?type=` filter reads the constant; its old gap comment is gone.

### 4. Deploy, undeploy and the ticket panel take the guild
- As planned. `deployFlowButtons(guild, …)`'s `undeploy` dependency now takes the guild too.
- **The plan's "every other route uses the route's guild" was not quite true** (review): `PUT /config/warnings` called `setWarningsModChannel(guild.id, …)`, whose default found the guild through `DISCORD_CLIENT`, so it answered "That server is unavailable right now" in the e2e harness and the preview server. **Done in this step at the coordinator's request:** `setWarningsModChannel(guild, channelId, deps)` takes the guild (its `getGuild` dependency and "unavailable" branch go); the route passes `c.get('guild')` and `warningsConfigModal` passes `interaction.guild`. New e2e `web/e2e/warningsSettings.test.tsx`: pick `#naughty-list` on the Warnings page, save, see "Warning notices now land in # naughty-list.", and read the channel back through the route. `dashboardApp.ts`' header now says every route works through the guild it resolved; no route-reachable code reads `DISCORD_CLIENT` for a guild any more.
- **e2e:** `flowBuilderToolbar.test.tsx` deploys a switched-on button flow from the builder's Deploy dialog and finds `**Safeword check-in**` with its `Still green?` button (`custom_id` `flow:<flowId>:check-in`) in `#signals`, the toast "1 button(s) live in that channel. Go press one.", and no faults.
- **Deviation:** the planned redeploy ("deploying again replaces it") is not driven end to end: TestDiscord models no message delete. A first deploy calls undeploy with nothing recorded, so the undeploy-through-the-route's-guild path rests on unit and route tests. `deployFlowButtons.test.ts` now pins that the retire receives the very guild deploy was handed.
- **Ticket panel:** the log line "Failed to update deployed ticket message: Expected token to be set for this request" was `updateDeployedTicketMessage`'s `DISCORD_CLIENT.channels.fetch` on the unlogged singleton, as suspected. It is gone from the e2e output (0 occurrences in the full run), and `ticketActions.test.tsx`'s setup asserts the panel message was edited by the settings save.

### 5. Wire-shape checks in the suite
- Each body file declares `type XBodyChecks = ChecksHold<{ … }>` and exports `XBodyMismatch = MismatchedChecks<XBodyChecks>`; a `.test-d.ts` asserts it `toBeNever()`. Both helpers are in `openApi.ts`.
  - `ChecksHold<Checks extends Record<string, true>>` replaces the per-file `const … = true` anchors (review): root `tsc` and the editor flag the failing member where it is declared.
  - `MismatchedChecks` distributes over the names through `infer`, so a failure prints them: `ExpectNever<"DeployedButtonMessage">`. With a plain mapped type, the form `nodeBody.ts` used, the failure printed only the alias (`ExpectNever<NodeBodyMismatch>`), so `nodeBody.test-d.ts`' claim that the failure names the check was false until now.
- **Covered:** `flowBody` (3), `installBody` (4), `journeyBody` (6), `publishedBody` (2), `ticketBody` (2), `nodeBody` (moved onto the helpers), `nodeRoutes`' `NonWireMembersAreWithheld` (exported, asserted `true`), and `resourceDrift`'s `ResourceDriftKindsMismatch` (both directions as one type; the `satisfies` alone only failed root `tsc`).
- **The six root-`tsc`-only guards in `features/`** (found in review, done at the coordinator's request), each now an exported type asserted in a `.test-d.ts`:
  - `flows/blocks/conformance.ts`: `ResumeKindsAllDriven`, asserted in `src/features/flows/__tests__/conformance.test-d.ts` — not beside the file, because block discovery reads every directory under `blocks/`.
  - `flows/data/flowRunsRepo.ts`: `SnapshotShapesAgree` and `QuietWindowShapesAgree`, asserted `true` in `data/__tests__/flowRunsRepo.test-d.ts`. Exported, they need no value anchors; `AssertTrue`'s constraint still flags a drift in place for root `tsc`.
  - `leveling/cards/statsCard/statsCardMetrics.ts`: `ActivityStatusesMismatch`; `leveling/logic/statsPeriod.ts`: `StatsPeriodsMismatch`. Both directions as one type, as `resourceDrift.ts`, since each list's `satisfies` half otherwise failed only root `tsc`. Asserted in `statsCard/__tests__/statsCardMetrics.test-d.ts` and `logic/__tests__/statsPeriod.test-d.ts`.
  - **`leveling/logic/levelingCohorts.ts` is not a real guard, and is left as it is.** `COHORT_LABELS` is annotated `Readonly<Record<CohortKey, string>>`, so `keyof typeof COHORT_LABELS` is always `CohortKey` and `MissingCohortLabel` is always `never`. Removing a label fails the annotation (`TS2741` at the object literal), never the anchor. What `pnpm test` sees is the existing runtime test `COHORT_LABELS > labels every cohort`, which failed when a label was removed.
  - `ChecksHold`/`MismatchedChecks` did not fit: each of these is one check, not a set, so an exported type with `toBeNever()` or `toEqualTypeOf<true>()` is the simpler equivalent.

### 6. Extractor
- As planned. Labels for a non-identifier key are bracketed: `components.schemas ["test.block"].name`. `isFormatSchema` is gone; a format schema's own message is judged with every schema's own `error`. The `x-messages` emitted are unchanged (the spec is otherwise byte-identical apart from items 2 and 3), and `z.int('…')` still fails the emit, now worded as "the schema's own error". `blockWith` lives in `src/features/flows/logic/__tests__/support/blockWith.ts`.

### Behaviour changes, final
- **Unhandled `/api` error:** 500 `{ "error": "Something broke on our side — not your fault, for once. Try again in a moment." }`, logged with method and path, instead of plain-text `Internal Server Error`. Every operation declares a 500; four keep their own descriptions, now ending "Or something else failed unexpectedly."
- **Ticket-type key over 64 characters:** refused on save with "Keep the key to 64 characters or fewer. It is an identifier, not a confession." Existing longer keys still load and work, can no longer be edited, and can still be deleted.
- **Deploy, undeploy and the warnings save** no longer have their own "That server is unavailable right now…" answers; a guild the bot is not in is already the route's 404 (`requireGuildAccess`) or the slash command's and modal's null-guild refusal.
- **Deploy, the ticket panel redraw and the warnings save work in the e2e harness and the preview server.**
- **The e2e app's 500 sentence** is production's instead of "Internal error."
- **Emit failure labels** bracket non-identifier keys.

### Checks
- **Suite:** 3,094 pass, 1 fail (`ciBranchProductDiff`, known), in the last full run, after the coordinator's two additions. Baseline 3,077: +1 key cap, +2 `buildApp` (route throw, middleware throw), +2 `openApiSpec` (every operation declares a 500; a route's own 500 is kept), +7 wire `.test-d.ts`, +1 deploy e2e, −1 undeploy "guild cannot be reached" (3,089 at the review); then +1 warnings e2e, +5 `features/` `.test-d.ts` cases, −1 `setWarningsModChannel` "guild is unavailable". The birthday flake did not show.
- **Typechecks:** root `tsc` the same 17; `typecheck:e2e` the same 4 (all in `features-system/data-persistence`); web `tsc -b` and the SDK typecheck clean.
- **Generation:** `pnpm sdk:generate` twice, hash-identical, after the sabotage rounds and again after the review fixes. Before any spec change, `pnpm sdk:check` passed on this machine after a CRLF re-checkout plus regenerate. It now lists the generated files as changed until the coordinator commits them; that is real content (items 2 and 3).
- **e2e:** `flowBuilderToolbar` and `ticketActions` run alone and in the full suite; all `web/e2e` files pass in the full run.
- **Sabotage**, each restored, then regenerated hash-identical:
  1. line endings: before the attribute, `rm` + `git checkout --` of `sdk.gen.ts` and `openapi.generated.json` (now `w/crlf`) followed by `pnpm sdk:generate` listed both as ` M` with an empty diff; with it, the same steps leave `git status` clean and `sdk:check` green;
  2. `buildApp`'s `onError` made to rethrow → "answers a route that throws with the 500 every route declares" failed;
  3. `apiRouter` not adding the 500 → "has every operation declare the 500" and the drift gate failed;
  4. the spread reversed (generic 500 last) → "keeps a 500 a route declares itself" failed;
  5. the key cap removed → "refuses a key longer than the ticket list can filter on" failed;
  6. `KeyCollisionSchema` given an extra optional member, `TicketRolePermissionsSchema.manageMessages` made a number, `'sabotageKind'` added to `RESOURCE_DRIFT_KINDS`, a `nodeBody` label made a number, `DeployedButtonMessageSchema.buttonCount` made a string → the matching `.test-d.ts` failed each time, naming the check (`"KeyCollision" | "RepairedResource"` (the repair result enumerates the drift kinds), `"BlockOutputHandle" | "NodeDescriptor"`, `"sabotageKind"`, `"DeployedButtonMessage"`);
  7. the deploy route resolving its guild through `DISCORD_CLIENT` → the deploy e2e failed (no toast);
  8. `updateDeployedTicketMessage` through `DISCORD_CLIENT` again → all 10 `ticketActions` tests failed on the `edited` assertion, and the log line came back 10 times;
  9. the schema's-own-error report skipped for non-strings → "on a fixed sentence with no keyword to travel beside" failed;
  10. (coordinator's additions) the warnings route resolving its guild through `DISCORD_CLIENT` again → the warnings e2e failed (no "Saved" toast);
  11. an optional key added to the quiet-window schema, `'year'` dropped from `STATS_PERIODS`, the `timeout` representative dropped from `RESUME_REPRESENTATIVES`, an extra `'sabotageZombie'` added to `ACTIVITY_STATUSES` → each `features/` `.test-d.ts` failed (`Expected literal boolean true, Actual literal boolean false`, `ExpectNever<"year">`, `ExpectNever<"timeout">`, `ExpectNever<"sabotageZombie">`); `topOnePercent` dropped from `COHORT_LABELS` → only the runtime "labels every cohort" test failed, and root `tsc` flagged the annotation, not the anchor.
- **After the additions:** typechecks unchanged (root `tsc` 17, `typecheck:e2e` 4, web and SDK clean); no spec change (the generated output hashes the same as after the review fixes); `pnpm sdk:check` fails only because this step's real generated changes are uncommitted.
- **Review:** one pass, `generic-reviewer-domain-runtime` and `generic-reviewer-maintainability` run directly. They agreed on one finding, rated High by one and Medium by the other: the overwritten designed 500s.
  - **Fixed:** the overwritten 500s; per-file anchors replaced by `ChecksHold`; root `onError` keeps context headers on an `HTTPException`; the middleware-throw case; the undeploy-receives-the-guild assertion; the e2e 500 sentence; the stale "a guild fetch" in `flowDeployCommand.ts`; the `SchemaMatches` JSDoc wording; the `dashboardApp.ts` header narrowed to name the warnings save; the `.gitattributes`/`checkSdk.ts` cross-reference.
  - **Recorded rather than fixed:** see Follow-ups.

### Follow-ups
- **`levelingCohorts.ts`' `cohortLabelsAreComplete` anchor is vacuous** (§5): the `Record<CohortKey, string>` annotation and the runtime test are the real guards, and its comment ("Fails to compile if a cohort is added … without a label below") credits the wrong line. Delete the anchor or correct the comment.
- **`RESUME_REPRESENTATIVES`' `satisfies`** (each entry is a real resume reason) still fails only root `tsc`; the completeness half is in the suite.
- **`updateDeployedTicketMessage` swallows its own errors** with a `console.warn`, so both callers' `.catch` (and the modal's "Non-fatally…" comment) never run (pre-existing). Letting it throw would put the handling where the callers already have it.
- **Redeploy has no e2e** until TestDiscord models deleting a message.
- **`ticketActions.test.tsx` asserts the panel redraw inside its fixture**, so every test in the file carries it; a dedicated case would say it more plainly (review, Low).
- **The coordinator brief's line-endings trap** wants rewriting: the attribute closes it.
