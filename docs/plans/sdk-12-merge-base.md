# SDK step 12: bring `feat/web-sdk` up to date with its moved base

Follows step 11 (`sdk-11-web-follow-ups.md`; `e540e04` pushed). Draft PR #23 (`feat/web-sdk` → `feat/web-ui-flow-engine`) is conflicting.

> **Status:** built. Conflicts resolved, merge staged and **uncommitted** (MERGE_HEAD present) for the coordinator to commit. This file is the durable record of the run. "As built" and "Checks" below are the record where they differ from "Method".

## Why this slice

The base moved from the merge-base `67aef56` to `cb9119a` with eight commits:

| Commit | What |
| --- | --- |
| `8cf1d6b` | Message Sent trigger, wait for a reply |
| `4070bd8` | Compare / Add to number blocks |
| `94d9439` | Ticket Event trigger |
| `db7e480` | Moderators pick the ticket type |
| `ca254c8` | Runs about nobody, per-server time zone |
| `6f39d5d` | Schedule trigger |
| `e0dd013` | Cross-flow loop refusal |
| `cb9119a` | Shared owner-keyed binding table, journeys that bring a ticket type |

The base still speaks to the browser through the hand client (`web/src/api/client.ts`, `types.ts`, `flows.ts`, `config.ts`) and its drift tests, all of which this branch deleted. Every wire change the base made there has to reach the OpenAPI spec and the generated SDK instead.

## Method

1. `git merge --no-ff --no-commit origin/feat/web-ui-flow-engine` (merge, not rebase; `6234c12` is the precedent).
2. Modify/delete conflicts keep the deletion. Before deleting, the base's version is read, and what it added is carried into the spec (routes, bodies) or a guard (`*.test-d.ts`, spec test, `FlowBlockFieldRules` test).
3. Content conflicts: the SDK side's structure (`apiRouter` + `createRoute`, bodies in `src/web/api/*Body.ts`, SDK calls in the dashboard), carrying the base's behaviour.
4. `pnpm sdk:generate` as soon as the conflicts resolve, then the dashboard is moved off every base-added hand-client call onto the regenerated SDK.
5. Checks against baselines measured on the base (`origin/feat/web-ui-flow-engine`) through a throwaway detached worktree.

## Wire changes in the base (from `git diff 67aef56 origin/feat/web-ui-flow-engine -- src/web/api web/src`)

One row per route, status, body field or control. "Lands in" is where it reaches the spec and SDK.

| # | Commit | Change | Lands in | Done |
| --- | --- | --- | --- | --- |
| 1 | `8cf1d6b` | Trigger source `messageSent` | `BlockTriggerSourceSchema` (`nodeBody.ts`), from `BLOCK_TRIGGER_SOURCES` | ✓ by construction |
| 2 | `94d9439` | Trigger source `ticketChanged` | same | ✓ |
| 3 | `6f39d5d` | Trigger source `scheduleDue` | same | ✓ |
| 4 | `94d9439` | Control `categoryPicker` (`defaultValue`) | `CONFIG_FIELD_ARMS.categoryPicker` | ✓ |
| 5 | `db7e480`/`cb9119a` | Control `ticketTypePicker` (`optional`, `defaultValue`) | `CONFIG_FIELD_ARMS.ticketTypePicker` | ✓ |
| 6 | `4070bd8` | `variableSelect.valueKind` optional (absent = any variable) | `CONFIG_FIELD_ARMS.variableSelect` | ✓ |
| 7 | `6f39d5d` | Control `timeOfDay` (`defaultValue: string`) | `CONFIG_FIELD_ARMS.timeOfDay` | ✓ |
| 8 | `6f39d5d` | Control `daysOfWeek` (`defaultValue: BlockDayKey[]`) | `CONFIG_FIELD_ARMS.daysOfWeek` | ✓ |
| 9 | `6f39d5d` | `BLOCK_DAY_KEYS` vocabulary | named enum `BlockDayKey`; browser reads `zBlockDayKey.options` (`contractValues.ts`), row in `contractValues.test.ts` | ✓ |
| 10 | `ca254c8` | `BlockConfigOption.requires` (context requirements a choice adds) | `BlockConfigOptionSchema`, now held by `SchemaMatches`; `FlowContextRequirement` named | ✓ |
| 11 | `6f39d5d` | Card-summary field part `visibleWhen` | `FieldSummaryPartSchema`, plus its own `SchemaMatches` check | ✓ |
| 12 | `e0dd013` | Manifest member `emits` is server-only | `NON_WIRE_MEMBERS` + `toDescriptor`'s destructure; named guard in `nodeRoutes.test-d.ts` | ✓ |
| 13 | `e0dd013` | Flow PUT 400: a flow going live into a loop (`{ error, issues: [] }`) | flow PUT `createRoute` 400 description (and `FlowRefusal`'s doc) | ✓ |
| 14 | `e0dd013` | Flow PUT 400: "This flow was switched on or off while you were saving. Save again." | same | ✓ |
| 15 | `6f39d5d` | `GET /:guildId/flows/:flowId/next-runs` → `FlowNextRuns { timeZone, nextRuns }`, 404 | `getFlowNextRuns` route, `FlowNextRunsSchema` in `flowBody.ts`; `useFlowNextRuns` calls the SDK | ✓ |
| 16 | `ca254c8` | `GuildSettings.timeZone` (`string \| null`), `defaultTimeZone` | `GuildSettingsSchema` (both settings GET and PUT answer it) | ✓ |
| 17 | `ca254c8` | `PUT /:guildId/settings/time-zone` body `{ timeZone }` (min 1, max 64, fixed sentences) → `GuildSettings`; 400 for an unknown zone (handler) | `updateGuildTimeZone` route, `GuildTimeZoneUpdate` body (sentences travel); `TimeZoneCard` on `updateGuildTimeZoneMutation` | ✓ |
| 18 | `cb9119a` | `GET /:guildId/channels` items gain `owner` | `GuildChannel` schema | ✓ |
| 19 | `cb9119a` | `GET /:guildId/roles` items gain `owner` | `GuildRole` schema (`GuildRoleBody` = its `z.infer`) | ✓ |
| 20 | `cb9119a` | `GuildObjectOwner { kind, key, label }`, `BindingOwnerKind` (`journey`, `tickets`) | named schemas, `BindingOwnerKind` from `BINDING_OWNER_KINDS` | ✓ |
| 21 | `cb9119a` | `DriftedResource.withheldReason` (`string \| null`) | `DriftedResourceSchema` | ✓ |
| 22 | `cb9119a` | `PUT /config/tickets` 409 `taken-meanwhile` (the saved config is redrawn; the body is `{ error }`) | 409 description; the redraw condition (`'config' in result`) | ✓ |
| 23 | `cb9119a` | `ResourceKind` gains `ticketType`; `DISCORD_RESOURCE_KINDS` | `ResourceKind` by construction; `DiscordResourceKind` registered as a component; browser `isDiscordResourceKind` in `contractValues.ts` | ✓ |
| 24 | `cb9119a` | `ResourceDeclaration.ticketType` (settings: template, permissions, auto-claim) | `TicketTypeSettings` component (`ticketBody.ts`), used by `ResourceDeclaration` and `TicketTypeUpdate` | ✓ |
| 25 | `cb9119a` | Journey resource save validates a declared ticket type with the ticket feature's rules (`.superRefine`, dynamic sentence) | `ticketTypeDeclarationRefusal`, asked through `declarationsRefusal` by the three resource routes | ✓ |
| 26 | `cb9119a` | `InstallPlanItem.note` | `InstallPlanItemSchema` + `installPlanBody` | ✓ |
| 27 | `cb9119a` | Ticket types plan as `adopt` / `create` / `reuse` | `PLAN_ACTIONS` unchanged; `kind` widens by construction | ✓ nothing to do |
| 28 | `cb9119a` | `PublishedFlowState.keptSettings` | `PublishedFlowStateSchema`; browser counts it as installed (`installedFromPublished`) | ✓ |
| 29 | `cb9119a` | Ticket type `DELETE` 409 `held-by-journey` | 409 description | ✓ |
| 30 | `cb9119a` | `GroupPreview.sharedTicketTypes` | `SharedTicketType` component in the merge plan schema (`SchemaMatches`), copied by the route | ✓ |
| 31 | `db7e480` | Ticket type label `.max(45, …)` | `TicketTypeLabelSchema` in `ticketTypeRules.ts`; sentence via `x-messages` | ✓ |
| 32 | `cb9119a` | `ticketTypePicker` declared-resource sidecar (`ticketTypeKey`); `RESOURCE_PICKER_CONTROLS` mirrored in the browser, held by `resourceTargets.test.ts` | `ResourcePickerControl` registered component (from `RESOURCE_PICKER_CONTROL_TYPES`); browser `RESOURCE_PICKER_CONTROLS` in `contractValues.ts`, used by `liveFieldIssues.ts`; `contractValues.test.ts` row (no hand mirror) | ✓ |
| 33 | `ca254c8` | Built-in token requirements (`builtinTokens.ts`) | not on the wire; `builtinTokenDrift.test.ts` kept | ✓ |

## Deleted files the base edited (modify/delete), kept deleted

| File | What the base added | Where it went |
| --- | --- | --- |
| `web/src/api/types.ts` | rows 1–11, 16, 18–21, 23–24, 26, 28, 30 above; `isDiscordResourceKind`; key lists | the spec (rows above); `isDiscordResourceKind` and `BLOCK_DAY_KEYS` in `web/src/flows/contractValues.ts` off the generated enums |
| `web/src/api/flows.ts` | `getFlowNextRuns`; the loop refusal in `updateFlow`'s doc | `getFlowNextRuns` (SDK); the sentence in the flow PUT 400 description |
| `web/src/api/config.ts` | `updateGuildTimeZone` | `updateGuildTimeZone` / `updateGuildTimeZoneMutation` (SDK) |
| `web/src/flows/fieldChecks.ts` | `RESOURCE_PICKER_CONTROLS`, sidecar forgiveness only on pickers | the list from the spec (row 32); the picker-only forgiveness in `liveFieldIssues.ts` |
| `src/web/api/__tests__/nodeDescriptorDrift.test.ts` | `BlockDayKey` vocabulary, option shape (`requires`), card-summary part shape (`visibleWhen`), four new arms | `z.enum(BLOCK_DAY_KEYS)` + `contractValues` row; `SchemaMatches` for `BlockConfigOption` and the part's `visibleWhen`; arms forced by `CONFIG_FIELD_ARMS`' `satisfies` and `NodeBodyChecks` |
| `src/web/api/__tests__/guildWireShapeDrift.test.ts` | `GuildObjectOwner`, `GuildSettings` keys, `BINDING_OWNER_KINDS` | schemas built from the constants; bodies typed by `z.infer` |
| `src/web/api/__tests__/flowWireShapeDrift.test.ts` | `FlowNextRuns` keys | `FlowNextRunsSchema`, `flowNextRuns()` typed by its `z.infer` |
| `src/web/api/__tests__/ticketWireShapeDrift.test.ts` | the browser's key and label caps equal the server's | the browser has no copy: `validateTicketTypeDraft` runs the generated rules; `ticketTypeForm.test.ts` and `ticketTypeRules.test.ts` pin 64/65 and 45/46 |
| `src/features/flows/logic/__tests__/fieldChecks.test.ts` | categoryPicker/ticketTypePicker count as pickers; on a non-picker the browser says nothing the server does not | the sidecar case in `blockFieldRules.test.ts` (asks `RESOURCE_PICKER_CONTROLS`, adds the disagreement list) |
| `src/features/provisioning/logic/__tests__/resourceKindMirrorDrift.test.ts` (base-new, imports the deleted `types.ts`) | the browser's kind lists and `isDiscordResourceKind` equal the server's | deleted; the lists are read off the spec, and `contractValues.test.ts` holds `DISCORD_RESOURCE_KINDS` and `isDiscordResourceKind` per kind |

## Decisions taken

All conventional; none needed Douglas.

1. **The ticket type rules have one statement.** The base added `ticketTypeDefinitionProblem` with its own copies of the key and label rules (and new sentences for the key: a dynamic "`` `x` will not do as a key``" and "A key caps out at 64 characters. It's an identifier, not a manifesto."). This branch had already moved those rules into `ticketTypeRules.ts` (step 4), where they travel. `ticketTypeDefinitionProblem` now parses `TicketTypeRulesSchema` and then runs the renderer check, so `upsertTicketType`, `createTicketTypeIfAbsent` and the journey save share it. The 45-character label cap joins `TicketTypeLabelSchema` with the base's sentence (`TICKET_TYPE_LABEL_TOO_LONG_MESSAGE`, now in `ticketTypeRules.ts`), and `TICKET_TYPE_KEY_MAX_LENGTH` has one home (`ticketingSchema.ts`, the base's).
2. **The journey save's `.superRefine` became a handler check.** Its sentence is dynamic and it spans `kind` and `defaultName`, so it cannot travel. `ticketTypeDeclarationRefusal` (journeyBody) runs it; `declarationsRefusal` asks it after `rolesWithoutIdsRefusal`, in the three routes that take resources (step 8's precedent). The template's tokens travel through `TicketTypeSettings`, so the schema refuses those first with the same sentence the tickets page shows.
3. **The browser's ticket type check is the SDK's.** The base's `validateTicketTypeDraft` was a hand mirror (key pattern, caps, token scan, an approximate render). It now runs the generated path and body rules (`zSaveTicketTypePath.shape.type`, `zSaveTicketTypeBody`) and is the one browser path: the tickets page's editor and the journey `invalidTicketType` chip both ask it. The render-length approximation is gone: that rule needs the server's renderer and arrives as the save's refusal (an under-report).
4. **`DiscordResourceKind` and `ResourcePickerControl` are registered components**, like `FlowBlockFieldRules`: no route sends either, and the browser needs both lists to branch on. The base kept the picker list as a browser copy with an equality test; after review it travels instead (decision taken in review, not planned), so `block-authoring.md`'s mirrors table loses that row.
5. **Server Settings: each form writes back only its own fields, under its own save key.** The base's page merged only the owned fields of each answer, so a late staff answer could not bring back an old zone. Ported to the query cache: `writeSavedAnswer` takes an updater, the staff form writes `staffRoleIds`/`staffRoles` and `TimeZoneCard` writes `timeZone`, each with its own `mutationKey` under the settings entry (`[...settingsKey, 'staffRoles']`, `[...settingsKey, 'timeZone']`) so neither form's Save spins for the other's. `TimeZoneCard` reads the same cached entry rather than taking props, and (after review) holds a draft only once the operator picks, as the staff form does, so a save an earlier mount left in flight lands on screen instead of being shown as an unsaved revert.
6. **Builder reads stay one-shot.** The ticket types and the server zone are `queryClient.fetchQuery(…, staleTime: 0)` in the load, as the directory reads are (step 6); `useFlowNextRuns` keeps its request counter and calls the SDK directly.

## As built

As planned, with the decisions above. Where this section and the sections above disagree, this one is the record.

### Server (`src/web/api`, `src/features/tickets`)
- `nodeBody.ts`: four new arms (`categoryPicker`, `ticketTypePicker`, `timeOfDay`, `daysOfWeek`), `variableSelect.valueKind` optional, `BlockConfigOption.requires`, `BlockDayKey` and `FlowContextRequirement` named, the card-summary part's `visibleWhen`; `NodeBodyChecks` gains `BlockConfigOption` and `BlockCardSummaryPart.visibleWhen`.
- `nodeRoutes.ts`: `emits` withheld (the base's change, kept); `nodeRoutes.test-d.ts` names it.
- `flowBody.ts` / `flowRoutes.ts`: `FlowNextRunsSchema` + `getFlowNextRuns`; the loop and "save again" refusals in the PUT's 400 description; the base's `decidePut`/`goesLive` taken whole. The base's `installPlanBody` copy in `flowRoutes.ts` dropped for `installBody.ts`' (which gains `note`).
- `guildBody.ts` / `guildRoutes.ts`: `GuildObjectOwner`, `BindingOwnerKind`, `owner` on channels and roles, the two zone fields on `GuildSettings`, `GuildTimeZoneUpdate` + `updateGuildTimeZone`. The unknown-zone 400 (it names the value) stays the handler's.
- `driftBody.ts`: `withheldReason`. `publishedBody.ts`: `keptSettings`. `installBody.ts`: `note`.
- `journeyBody.ts`: `ticketType` on `ResourceDeclaration` (via `TicketTypeSettings`), the ticket-type label trim in the transform, `DiscordResourceKind`, `SharedTicketType`, `ticketTypeDeclarationRefusal` and `declarationsRefusal`. `journeyRoutes.ts` asks `declarationsRefusal` where it asked `rolesWithoutIdsRefusal`, copies `sharedTicketTypes`, and keeps the base's `mergeDeclarations`.
- `ticketBody.ts`: `TicketTypeSettings`; the type list ordered by `listTicketTypes` (the base's). `ticketRoutes.ts`: `TicketTypeUpdate` = label + `TicketTypeSettings`; `change` on the transitions; the redraw on `'config' in result`; the two new 409s described.
- `ticketTypeRules.ts`: the label cap and its sentence; `TICKET_TYPE_KEY_MAX_LENGTH` imported from `ticketingSchema.ts` (its one home). `setTicketTypes.ts`: `checkTicketTypeDefinition` (rules schema, then renderer) behind `ticketTypeDefinitionProblem`, `upsertTicketType` and `createTicketTypeIfAbsent`.
- `openApiDocument.ts` registers `DiscordResourceKind` and `ResourcePickerControl` (`nodeBody.ts`, from `RESOURCE_PICKER_CONTROL_TYPES` in `resourceTargets.ts`).
- `journeyRoutes.ts`' resources 400 description interpolates `TICKET_TYPE_LABEL_MAX_LENGTH` and names the empty render (review).

### Web
- Every base-added hand-client call moved to the SDK: `useFlowNextRuns` (`getFlowNextRuns`), `TimeZoneCard` (`getGuildSettingsOptions` + `updateGuildTimeZoneMutation`), `ResourcesDialog`'s ticket types (`getTicketsConfigOptions`), the builder's load (`getTicketsConfigOptions`, `getGuildSettingsOptions` through `fetchQuery`). Every `../api/types` import → `@brattybot/web-sdk`.
- `contractValues.ts`: `BLOCK_DAY_KEYS`, `DISCORD_RESOURCE_KINDS`, `isDiscordResourceKind`, `RESOURCE_PICKER_CONTROLS` off the generated enums.
- `liveFieldIssues.ts`: the picker-only sidecar forgiveness, asking `RESOURCE_PICKER_CONTROLS`.
- `TicketsConfigPage`: a 409 on the settings save re-reads the settings too (a slot taken meanwhile saved the rest), as 502/503 did (review).
- `ResourcesPanel`'s ticket type body checks `{ ...settings, type, label }` — the base spread the starting draft's empty key and label over the row's (review; base bug, an over-report).
- `ticketTypeForm.ts`: `validateTicketTypeDraft` on the generated rules (no hand rules, no hand caps); `TicketsConfigPage` uses it; the base's `TicketTypeFields` extraction kept, on SDK types, with this branch's "Anything else won't save." hint.
- `detectResourceProblems.ts`: the base's hand key/name rules dropped (this branch's generated-zod checks kept); `invalidTicketType` asks `validateTicketTypeDraft`. `ResourcesPanel` offers only server type keys that pass the generated key rule.
- `publishedSummary.installedFromPublished` counts `keptSettings` (the base had this in the builder's own fetch); `InstalledResourcesDialog`'s unknown state carries `keptSettings: []`.
- `writeSavedAnswer` takes an updater; Server Settings as in decision 5.

### Tests changed to fit the merge, and why
- `flowIncomplete` (e2e, two cases): wait out the re-check the base now asks `STRUCTURAL_RECHECK_DELAY_MS` after a palette add, then count `/check` requests before and after typing, instead of "none at all". On a loaded machine the typing outlasted the delay and the structural re-check read as the keystroke's.
- `sessionExpiry` (e2e): the card is added while the session is live, and the structural re-check and first autosave land, before the session runs out. Otherwise the re-check was the first held request and opened the panel mid-typing. While the panel is up the stored draft is still the pre-expiry one (`['Doorman']`), where it was `[]`.
- `flowNextRun` (e2e, base): its fault-injecting `fetch` read `input.toString()`, which for the SDK's `Request` is no URL; it reads `input.url` now.
- `guildSettingsRoutes`: the crash case mocks `getByGuildId`, which the settings GET now reads; two new cases pin the zone body's travelling sentences and the 415 / malformed-JSON answers.
- `setTicketTypes` (base case): "the same words upsert uses" asserts equality with `upsertTicketType`'s refusal and the template rule's sentence, not the base's `{{user}}`-naming one.
- `journeyTicketTypeSchema` (base): drives `ResourceDeclarationSchema` + `declarationsRefusal`; adds the render-length and non-ticket-kind cases.
- `resourceChipAgreement`: `serverVerdict` asks `declarationsRefusal`.
- `blockFieldRules`: the sidecar case asks `RESOURCE_PICKER_CONTROLS` and collects disagreements on non-pickers (the base's `fieldChecks.test` change).
- `resourceTargets` (base): its browser-equality case moved to a `contractValues.test.ts` row (the browser list is the spec's now).
- `ServerSettingsPage`: two new cases — a zone save left in flight lands on screen after leaving and coming back; a zone answer landing late keeps the saved staff roles.
- `ticketTypeForm` (both sides): the base's validator cases rewritten against the generated rules.
- `ticketTypeRules`: the label cap case. `contractValues`: day keys, Discord kinds, `isDiscordResourceKind` per kind. `publishedSummary`: kept settings count as installed.
- Fixtures: `FlowsListPage` (`keptSettings`), `subjectAvailability` (no `fieldChecks`), `ServerSettingsPage` (`owner: null`), `ticketRoutes` (mock keeps the real module).
- Deleted: the five drift tests above, `fieldChecks.test.ts`, `resourceKindMirrorDrift.test.ts`.

### Behaviour changes, against the base

- **Zone PUT on `apiRouter`:** a body sent without a JSON content type is 415; malformed JSON is 400 "Malformed JSON in request body" (it was zod's "Invalid input: expected object, received null"). Its empty/too-long sentences reach the browser's zod.
- **Ticket type sentences on journey install and journey save** are this branch's (step 4) rather than the base's new copies:

  | Rule | Base | Now |
  | --- | --- | --- |
  | key pattern | ``…`Bad Key` will not do as a key — lowercase letters, digits, `-` and `_` only. The label is where you get to be expressive.`` | "That will not do as a key — lowercase letters, digits, `-` and `_` only. The label is where you get to be expressive." |
  | key cap | "A key caps out at 64 characters. It's an identifier, not a manifesto." | "Keep the key to 64 characters or fewer. It is an identifier, not a confession." |
  | unknown token / stray brace | "`` `{{user}}` `` is not a token this bot knows how to render. Use …" / "That template still contains `` `{` `` after rendering. Check the spelling — a token needs exactly two braces each side." | "Only `{{####}}`, `{{subject}}` and `{{opener}}` render here, each with exactly two braces either side — nothing else, and no, wishing does not count." |

  The label ("Give the type a label — operators have to pick it out of a list.", "A label caps out at 45 characters — the mod ticket picker in Discord will not show more. Keep it snappy.") and render-length sentences are unchanged. On a journey save, an unknown token is now refused by the request schema (same 400, the sentence above) before the handler's checks.
- **The browser's ticket type check** (the journey panel's ticket type fields and the `invalidTicketType` chip) shows the server's sentences instead of the base's hand copies: key pattern and cap as above; "Give it a label — …" → "Give the type a label — operators have to pick it out of a list."; "Channels need names. Discord is firm on this." → "A channel-name template cannot be empty. Discord insists on calling channels something."; the token sentences → the template sentence above. The base's approximate render-length check is gone from the browser (an under-report: the save's refusal says it).
- **Template hint in the journey panel:** "Anything else arrives in Discord as literal braces." → "Anything else won't save." (the shared `TicketTypeFields`; the tickets page already said this).
- **A key breaking two rules** (over 64 and malformed) now gets the length sentence first, where the base's function gave the pattern one: the rules schema runs length before pattern (step 11's rule order, which the browser shares).
- **Ticket settings:** a 409 on save now re-reads the settings (see As built).
- Nothing else user-visible changed from the base.

## Checks

- **Suite** (`pnpm exec vitest run --maxWorkers=4`, final run after the review fixes): 3,809 pass, 2 fail, 11 skipped, plus one file lost to a hook timeout. The 2 failures are the known `ciBranchProductDiff` and the birthday "skips overlapping runs" (the run was at about 04:00, inside its 22:00–07:00 window; it fails alone too). The hook-timeout file, `resourceTargets.test.ts` (block discovery in `beforeAll` at 100% CPU), passes alone — 11 of 11 — with a throwaway per-project `hookTimeout` config, deleted after. Earlier runs also lost `flowCycles.test.ts` and `runStartTime.test.ts` the same way; both pass alone. Baseline 3,121 on `e540e04`; the base adds its own suites, so the count is not comparable; no other failure remains.
- **Root `tsc --noEmit`:** 17, the same 17 messages as before the merge (diffed); none in a file this merge touched.
- **Web `tsc -b` (`pnpm --filter brattybot-web typecheck`):** 0. **SDK typecheck:** clean.
- **`pnpm typecheck:e2e`:** 5 — the branch's known 4 plus `seedTickets.ts:102` (`actorId: null`), verbatim from the base (see Follow-ups). Measured by inspection of the base's file, not by a detached-worktree run.
- **Generation:** `pnpm sdk:generate` twice, hash-identical, and identical again after every sabotage round. **`pnpm sdk:check`** fails only because the regenerated files are staged and not yet committed (`M ` lines, index vs `HEAD`); the worktree equals the index for every generated file (`git diff -- generated packages/web-sdk/src/gen` empty), so it passes once the merge is committed.
- **e2e:** the full `web/e2e` set ran in each suite run; `flowIncomplete`, `sessionExpiry`, `flowNextRun` also alone, green.
- **Sabotage**, each restored, regeneration hash-identical after:
  1. `emits` taken off `NON_WIRE_MEMBERS` and out of the destructure → `nodeRoutes.test-d.ts` "never serves what a block causes" failed (the older "withholds exactly" check still passed, as expected);
  2. `requires` dropped from `BlockConfigOptionSchema` → `nodeBody.test-d.ts` failed naming `BlockConfigOption` (and `NodeDescriptor` from sabotage 1);
  3. `autoClaimOnOpen` dropped from `TicketTypeSettingsSchema` → `ticketBody.test-d.ts` failed naming `TicketTypeSettings`;
  4. `destinationName` dropped from `SharedTicketTypeSchema` → `journeyBody.test-d.ts` failed naming `SharedTicketType`, `JourneyMergePlan`, `ResourceDeclaration`;
  5. the card-summary part's `visibleWhen` dropped → `nodeBody.test-d.ts` failed naming `BlockCardSummaryPart.field`;
  6. `ticketTypeDeclarationRefusal` made to answer nothing → `journeyTicketTypeSchema` (label past 45, render length) and `resourceChipAgreement` (label past 45, label of spaces) failed;
  7. `ticketTypePicker` dropped from the browser's picker list (before it moved to the spec) → `blockFieldRules` sidecar case and `resourceTargets` "counts sidecars on the same controls" failed; after the move, the browser list cut by one → the new `contractValues` row failed;
  8. browser `BLOCK_DAY_KEYS` reversed → `contractValues` day-keys row failed;
  9. `isDiscordResourceKind` answering true for `ticketType` → `contractValues` per-kind row failed;
  10. `installedFromPublished` without `keptSettings` → `publishedSummary` "counts a ticket type uninstall would only forget" failed;
  11. `validateTicketTypeDraft` without the key check → four `ticketTypeForm` cases failed;
  12. `TicketTypeLabelSchema` without `.max(45)` → `ticketTypeRules` label-cap case failed;
  13. the staff form writing the whole answer → `ServerSettingsPage` "keeps a saved zone when a staff save's late answer…" failed; the zone card writing the whole answer → "keeps saved staff roles when a zone save's late answer…" failed;
  14. the zone card copying its draft at mount → "shows the zone a save left in flight once it lands, after the operator leaves and comes back" failed;
  15. `flowNextRun`'s stub before the fix (reading `input.toString()`) → "never stands in the way" failed in the first full run.
- **Review:** one pass, `generic-reviewer-domain-runtime` and `generic-reviewer-maintainability` spawned directly, read-only; `git status` and a marker grep after both showed nothing injected. No Critical or High.
  - **Fixed:** the zone card's stale draft after a remount (Medium); the picker list as a browser copy (Medium, now `ResourcePickerControl`); the settings save's 409 not re-reading (Medium); the empty Checks section (Medium); `ResourcesPanel`'s spread order (Low, base bug); the resources 400 description; stale comments in `writeSavedAnswer.ts`, `ticketBody.ts`, `ticketTypeRules.ts`, `journeyBody.ts`, `contractValues.test.ts`, `ticketTypeForm.test.ts`; a doubled blank line; the reverse-direction settings case (was a follow-up).
  - **Recorded:** see Follow-ups.

## Follow-ups

- **Builder one-shot reads can come back pre-save** (review, Low): the ticket types and the zone are `fetchQuery` reads on entries another page's save cancels (`writeSavedAnswer`'s `cancelQueries`, revert). Save on the tickets or settings page, open a flow before the save answers, and the builder may work from the old types or zone until reload. Direct SDK calls (then `setQueryData`) would close it.
- **The next-runs poll goes through the session gate** (review, Low): an idle builder with an overdue schedule and an expired session gets the sign-in panel from a countdown poll. The gate doing its job; a per-call opt-out would keep the poll silent.
- **`flowIncomplete`'s fixed wait** (review, Low): `letStructuralRecheckGo` sleeps `STRUCTURAL_RECHECK_DELAY_MS + 200`; waiting for the `/check` count to settle would be sturdier.
- **The template hint names the tokens by hand** (`TicketTypeFields.tsx`, pre-existing on this branch, review Low); a `TicketTemplateToken` component would let it read them off the spec.
- **`setTicketTypes`' `?? 'That ticket type does not hold together.'`** cannot fire (a failed parse has an issue); left as this branch's existing pattern (review Low).
- **`typecheck:e2e` reports 5**, one more than this branch's old 4: `web/e2e/preview/scenario/seedTickets.ts` passes `actorId: null` where `TicketChange.actorId` is `string`. That code is the base's, verbatim (`git diff origin/feat/web-ui-flow-engine -- web/e2e/preview/scenario/seedTickets.ts` shows only this branch's import line), so it is pre-existing on the base; not fixed here.
- **Hook timeouts under load:** `flowCycles`, `resourceTargets` and `runStartTime` (all `ensureBlocksDiscovered` in `beforeAll`) join the brief's known four. `--hookTimeout` on the CLI does not reach the `projects` config; a throwaway config setting it per project did.
- **`web/e2e/flowIncomplete` was the coordinator's "fails under load and on the clean base too"**: the cause is the base's structural re-check, and the test now waits it out. The same re-check can open the session panel 600 ms after a structural edit made after the session ran out; that is the gate doing its job, but worth knowing.
