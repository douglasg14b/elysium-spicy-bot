# A journey can bring its own ticket type

> **Status**: Built 2026-10-10; live run pending. (Planned and plan-reviewed the same day.)
> **Owner**: Douglas
> **PRD**: `docs/prds/flow-engine-v2-journeys-and-provisioning.md` §5.7, *Subsystem configuration is a declarable resource* (line ~280). This step meets it **in part**; see "What this does not do"
> **Predecessor**: [shared-binding-table.md](shared-binding-table.md), built and not yet committed. This step builds on its owner-keyed `resource_bindings`

## The gap

A journey declares the categories, channels and roles it needs, and install creates or reuses them. A verification journey also needs a **ticket type**, because its Open Ticket step opens one. Ticket types live in the ticket settings, and nothing installs one. Today the journey can't say which type it needs, and its flows name a type by hand.

## What this does not do

**This step does not set up the ticket system.** Open Ticket needs a deployed panel, three linked categories and a moderation role (`isTicketingConfigConfigured`), and those still need hand setup. Every path that creates a ticket config also seeds `support` and `verification`. So in practice:

- on a server with no ticket config, the item is blocked;
- on a configured server, it is usually a reuse;
- a create only happens for a custom key, or after the dashboard deleted the type.

What it does deliver:

- the journey *records* which type it needs;
- install guarantees that type exists;
- its flows are wired to it with no hand-picking;
- uninstall never touches it.

**Step 6 still needs the ticket system deployed by hand.** §5.7 stays partly open, with a named follow-up: *a journey can set up the ticket system* (deploy panel, categories, moderation roles).

## Decisions

From Douglas (2026-10-10):

- **Uninstalling a journey never removes a setting it installed.** The ticket type stays exactly as it is, and uninstall only forgets that the journey installed it. Removing a type can break other parts of the server: other flows, open tickets, the dashboard.

My picks, where Douglas left the details to me ("otherwise, go ahead"):

- **Ticket types only.** One more resource kind, through a small provider hook. The next setting gets its own provider when it exists.
- **A type that already exists is used as it is, and install never changes it.** That includes one created between preview and apply, by another journey, the dashboard or the Discord modal. So install creates **only if absent** (below), never upserts. There's no drift reporting for types.
- **A ticket type can be used by several journeys, and by the dashboard.** "One owner per object" exists because uninstall deletes what a journey created. A type is never deleted or rewritten by a journey, so sharing it is harmless.
  - Two journeys declaring the same key with different settings: the first install creates it and the second reuses it as it is. That's stated here; there's no code for it.
- **The type's key is the resource key.** Resource keys (`^[a-z0-9]+(-[a-z0-9]+)*$`) are a subset of type keys (`^[a-z0-9_-]+$`), and both are limited to 64 characters. Identity is by key, never by label (issue #22's lesson).
- **Blocked only when the server has no ticket config at all**, which is the one case where the write fails. If config exists but the system isn't fully set up, that's a non-blocking note on the item: "the ticket system isn't fully set up yet, so this journey's tickets can't open until it is". Open Ticket already refuses loudly when it runs. The provider supplies both sentences, so provisioning never names `/deploy-ticket-system`.
  - One blocked item blocks the whole install, channels and roles included, as any blocked item does today (`isPlanApplicable`).
- **The dashboard can't delete a type a journey holds.** `deleteTicketType` also refuses, naming the journey, when a journey binding holds the type: "uninstall that journey, or take the type out of it, first". It reads the bindings on its own `mutateConfig` transaction. Flows that name a type with no journey behind them stay as they are today, with no check. That gap was already there and is out of scope.

## The model

### A new resource kind, and a split that every stage makes once

`RESOURCE_KINDS` gains `ticketType`. Changes:

- **`DISCORD_RESOURCE_KINDS`, `type DiscordResourceKind` and `isDiscordResourceKind`** in `resourceDeclaration.ts`, **mirrored in `web/src/api/types.ts`**. A new drift test compares both kind arrays across the wire. The browser `ResourceKind` has no gate today.
- **Every Discord-only helper takes `DiscordResourceKind`**, so passing a ticket type fails to compile. That covers `existsInGuildAs`, `findByName`, `liveNameOf`, `readLiveResource`, `deleteFromGuild`, `roleHierarchyRefusal` and `prepareCreate`. `BoundChannelKind` becomes `Exclude<DiscordResourceKind, 'role'>`.
- **Each stage branches on `isDiscordResourceKind` once, at the top of its per-resource loop**, before any state-based branch. In `buildUnpublishPlan`, for example, the branch comes before the `intended` branch and the `adopted` refusal, or an adopted type would be refused and never forgotten.
- **tsc won't find negative checks, so slice A also includes a grep inventory.** In `src` and `web/src`, find `!== 'role'`, `!== 'category'`, `=== 'role' ?`, `Exclude<ResourceKind`, and `kind: string` on wire bodies. Every hit is fixed or noted as safe in the "As built" section. Known hits:
  - server: `provisioningService.ts:410`, `installPlan.ts:384-386, 420`, `unpublishPlan.ts:382, 400`, `resourceDrift.ts:344, 392`, `applyUnpublishPlan.ts:204, 243`;
  - web: `resourceRows.ts:89`, `resourceAdoption.ts:96, 131, 188, 280, 479`, `resourceNameSuggestions.ts:264-266`, `ResourcesPanel.tsx:246-247, 421, 763-765, 1201`, `detectResourceProblems.ts:137`, `publishedSummary.isKnownKind`.
- Every `Record<ResourceKind, …>` table gains an entry (`KIND_LABEL` ×4, `KIND_ORDER`, `KIND_NOUNS`, `RESOURCE_KIND_STYLES`/`ORDER`), and every `never` switch gains a case (`normaliseResourceName` on both sides).

### The declaration

`ResourceDeclaration` gains `ticketType?: TicketTypeSettings`, where `TicketTypeSettings = { nameTemplate, permissions: TicketPermissionModel, autoClaimOnOpen }`. **It is an `import type` from `tickets/data`**: there's no runtime edge, and no duplicate to drift. For a `ticketType` resource:

- `defaultName` is the **label**, capped at 45 characters;
- `ticketType` is required, and forbidden on every other kind;
- `parentKey`, `permissions` (channel intent) and `adoptDiscordId` are forbidden.

**`validateJourneyDeclaration` stays structural and provider-free.** It runs on every journey read. **Content rules** (template tokens, rendered length) come from a pure `ticketTypeDefinitionProblem` exported by tickets, which wraps today's private `templateProblem`. `journeyRoutes` (web layer) imports it directly, along with the ticket route's existing zod pieces for permissions, so `resourceSchema` doesn't become a third copy. The 100-character cap and `normaliseResourceName` branch on kind.

**`dependencyDirection.test.ts`** gains a check: provisioning has no *runtime* import from `features/tickets` (type-only is allowed).

### The provider hook

Provisioning defines it. Tickets implement it.

```ts
interface TicketTypeProvider {
  read(guildId: string): Promise<
    | { status: 'no-config'; blockedReason: string }
    | { status: 'ok'; ready: boolean; notReadyNote: string | null; types: ReadonlyMap<string, { label: string }> }
  >;
  createIfAbsent(guildId: string, key: string, label: string, settings: TicketTypeSettings):
    Promise<{ outcome: 'created' } | { outcome: 'exists'; label: string } | { outcome: 'refused'; message: string }>;
}
registerTicketTypeProvider(provider): void
clearTicketTypeProviderForTests(): void
```

- `createIfAbsent` is built on a new tickets function, `createTicketTypeIfAbsent`. It runs inside `mutateConfig`, validates like `upsertTicketType`, and returns `exists` without writing if the key is already there. **Never on `upsertTicketType`**, which replaces the record.
- Registration is a standalone `registerTicketTypeProvisioning()` exported by tickets. It is called from `initTicketsFeature`, from `web/e2e/support/bootBot.ts` (e2e and dashboard boot, which copies init by hand), and from the preview server.
- A journey that declares a ticket type with no provider registered is a programming error, and it throws, naming the hook. A wiring test, like `writeBackIsWired.test.ts`, covers each boot root.

### Binding rows

A ticket type binding is an ordinary journey-owned row:

- `kind: 'ticketType'`;
- `discord_id` = **the type key**;
- `state` is `created` (install made it) or `adopted` (it was already there);
- `name` = the label.

The column comment says so ("a snowflake, or a ticket type's key for `ticketType`"). There's no second rename; both reviewers accepted this, provided every reader branches on kind first.

**Ownership is filtered once.** `loadGuildOwnership` returns `bindings` of Discord kinds only, so `ownerOf`, `describeOtherHolder`, `boundInGuild`, `guildBoundIds` and `guildObjectOwner` never see a type row. `previewInstall` takes the journey's own rows, all kinds, separately, for `existingBindings`. A type key can be all digits, so the filter matters in both directions:

- a ticket type row never fences a Discord settle (`heldByNoOtherOwner` ignores `other.kind = 'ticketType'`);
- a ticket type write never goes through that guard: it uses `upsertBinding`, whose doc changes from "tickets only" to "rows that bypass the intent lifecycle".

## Behaviour

### Install plan

`previewInstall` reads the provider once, only if the journey declares a ticket type, and passes the result to `buildInstallPlan`, which stays pure. Per `ticketType` resource:

| Situation | Item |
|---|---|
| `no-config` | `blocked`, with the provider's sentence |
| The key exists, and this journey has a settled row | `reuse`, "already here, used as it is" |
| The key exists, and there's no row | `adopt`, with `discordId` = the key and the same sentence. It's an action so that apply writes the row |
| Missing, and this journey's row says it was there | `create`, "was removed; it will be made again" |
| Missing | `create` |

Plus the provider's `notReadyNote`, when present, on every ticket type item; it doesn't block. No channel or role permission blocker, no name match, no interrupted-create recovery.

### Apply

`applyInstallPlan` branches on `isDiscordResourceKind` at the **top of the loop, before `recordIntent`**. For a ticket type:

- `create`: call `provider.createIfAbsent`.
  - `created` → `upsertBinding` as `created`.
  - `exists` (someone made it since preview) → `upsertBinding` as `adopted`, reported as "already here; used as it is".
  - `refused` → this item fails with the provider's message, and items before it stay applied.
- `adopt`: `upsertBinding` as `adopted`. Write failure copy: "could not record that this journey uses the ticket type ‹label›".
- No intent row. Nothing here can be half-made, and the Discord error branches (`DiscordAPIError`, "Discord never confirmed") don't apply.

`resolveJourneyResources` maps a ticket type binding to its key while the provider lists it, and to `stale` otherwise.

### Wiring the flow

The three `ticketTypePicker` fields (Open Ticket, Ticket Event trigger, Has Open Ticket) join the declared-resource mechanism:

- **Fix the `*Key` scan first.** A real bug, reproduced: Pick Random's `outputKey` is read as a sidecar for a non-existent field `output`, so `flowReadinessIssues` refuses to switch on every Pick Random flow. `collectResourceTargets` should treat `<k>Key` as a sidecar only when the block has a field `<k>` whose control is a picker (`rolePicker`, `channelPicker`, `categoryPicker`, `ticketTypePicker`). An unknown block stays lenient. Add a Pick Random regression test.
- `TicketTypePickerControl` lists the journey's declared ticket types as their own group, with the `resource:` value prefix (`declaredOptionValue`). Without the prefix, the seeded `verification` would appear twice with one value, which Mantine rejects.
  - Picking a declared type writes `ticketTypeKey` and **removes** `ticketType` (`undefined`, not `''`, because the trigger's field is `.min(1).optional()`).
  - Picking a guild type writes `ticketType` and clears the sidecar.
  - If a key is both declared and already in the guild, both options show. Picking the declared one keeps the flow off until install, the same as channels.
- `pendingResourceFields` already allows the empty field. `flowReadiness` and the live-flow draft rule already keep the flow from going live until install. So a Ticket Event trigger never runs as "any type" while it waits.
- **`cardSummary`** shows a waiting declared type as "‹label› (after install)", not "any type".
- Write-back fills `ticketType` with the key. **The cycle exemption's reason changes.** Write-back can add a loop edge: an Open Ticket with an empty type emits nothing, and after write-back it emits. The exemption still holds because a flow with uninstalled keys is never live, and switching it on runs `findFlowCycleThrough`. Rewrite the comment at `applyResourcesToFlows.ts:92-97` to say that, with a test: install while the flow is off, then switching it on into a loop is refused.
- `manifest.ts:134-144` and `block-authoring.md:273` drop "no resource sidecar" for `ticketTypePicker`.

### Uninstall

A ticket type binding, in any state, is a **`forget`** item: "The ticket type ‹label› stays, and flows that use it keep working. Uninstalling a journey never removes settings." This differs from channels: uninstall deletes a channel, but leaves the type and its flows running. `applyUnpublishPlan` never calls the provider. A test checks that the type, its tickets and a flow using it are unchanged.

### Grouping, orphans, drift, install state

- **`planJourneyMerge`**: two ticket type declarations with the same key are the same object, not a collision. The moving copy is dropped, the destination's settings are kept, and the dialog says so. Ticket type bindings are never listed as `orphaned`.
- **Orphans**: a ticket type binding whose key is no longer declared is offered as `forget`, with `mayDelete: false` and its own "stays" sentence.
- **Drift** skips ticket type bindings.
- **Install state** counts a settled ticket type row as live.

### The editor

- **Extract `TicketTypeFields`** (label, name template, permission grid, auto-claim) from `TicketsConfigPage.tsx`, where it's inline today. Reuse it in both places.
- `ResourcesPanel` gets an "Add ticket type" button.
  - A ticket type resource shows the key, `TicketTypeFields`, and nothing for parent, channel permissions or adopt.
  - **The key doesn't follow the label** (`resourceKeyFollowsName` is off for this kind), because renaming would silently switch from reusing a type to creating a new one. The key field also offers the guild's existing type keys.
- Its chip says when the key already exists here: "already here: used as it is, not changed". `resourceChipAgreement.test.ts` keeps browser and server in step, with the content check going through the exported pure function, not the provider.
- Name-collision checks don't apply to a ticket type.

## Slices

| # | Change | Proof |
|---|---|---|
| **A** | `ticketType` kind; `DiscordResourceKind` on both sides plus the drift test; helpers narrowed; branch-at-top in every stage; the grep inventory; declaration shape and validation; `ticketTypeDefinitionProblem`; the provider hook, registration in all three boot roots, and its wiring test; ownership filtered in `loadGuildOwnership`; `heldByNoOtherOwner` ignoring ticket type rows; the dependency-direction check | tsc lists the narrowed call sites, and each is fixed, not cast. The inventory is recorded. Validation unit tests. **Sabotage:** journey A holds ticket type `123456789012345678` and journey B settles a channel with that snowflake; remove the ticket type filter, and B's settle is refused (the test fails) |
| **B** | `createTicketTypeIfAbsent`; plan items; apply through the provider; binding rows; `resolveJourneyResources`; uninstall `forget`; merge rule; orphan `forget`; drift skip; `deleteTicketType` refusing a type held by a journey | Integration (real SQLite + TestDiscord + real provider): create records `created`; an existing `verification` gets `adopt` and stays unchanged (label and template asserted); **a type created between preview and apply comes through untouched and is recorded `adopted`** (sabotage: build on `upsertTicketType`, and it fails); `no-config` blocks; not ready gives a note and no block; two journeys share one type; **uninstall leaves the type, its tickets and a flow using it unchanged, and forgets the row** (sabotage: send ticket types down the delete path); reinstall after a dashboard delete recreates it; the dashboard can't delete a type a journey holds; grouping two flows that both declare `verification` merges |
| **C** | Fix the `*Key` scan, with a Pick Random regression test; picker sidecar with the `resource:` prefix and `undefined` on optional fields; card summary; write-back; the cycle comment and its test | Pick Random flows can switch on again (sabotage: restore the lexical scan). Picking a declared type writes the sidecar and removes the field. After install, write-back fills Open Ticket and a Ticket Event trigger. A Ticket Event flow waiting on an uninstalled type can't switch on. Switching on after install into a loop is refused |
| **D** | `TicketTypeFields` extraction; editor add button and fields; key doesn't follow the label; chip; collisions skipped | Component tests. `resourceChipAgreement` with a ticket type. An e2e test: declare a ticket type in a journey, install, see it on the ticket settings page; uninstall, and it's still there |
| **E** | Docs: PRD §5.7 row (partly met, with the follow-up named); build-order rows; `block-authoring.md`; `AGENTS.md` if it lists resource kinds. Deploy note: rolling back to code without `ticketType` while such rows exist throws in `normaliseResourceName` | Full suite at baseline; root tsc at baseline; web tsc 0 |

One reviewer pass after A–D: a new resource kind across every stage, a cross-feature hook, and a teardown rule.

**Carry into `feat/web-sdk`** when it rebases: `ticketType` in `ResourceKind`, `DISCORD_RESOURCE_KINDS`, `ResourceDeclaration.ticketType`, the new plan item reasons and notes, the ticket-type-in-use-by-journey refusal, and the picker sidecar. Also, added while building: `note` on the install-plan item wire, `keptSettings` on the published body, `sharedTicketTypes` on the group preview, and the `held-by-journey` ticket type refusal.

## As built (2026-10-10)

All five slices are in the working tree, uncommitted, on top of the uncommitted shared-binding-table step. Nothing has run against a live guild.

### Decisions the plan left open

- **`TicketTypeSettings`** is `Omit<TicketTypeDefinition, 'type' | 'label'>`, named in `tickets/data/ticketingSchema.ts` and imported as a type by provisioning (`resourceDeclaration.ts`, `ticketTypeProvider.ts`). The browser mirrors it in `web/src/api/types.ts`.
- **Narrowing.** Besides the helpers the plan names, `recordIntent`, `settle`, `rebind`, `findInterruptedCreates`, `readLiveResource`, `permissionRefusal`, `deleteFromGuild`, `liveNameOf`, `requireAdoptable` and `prepareCreate` take a `DiscordResourceKind`. `upsertBinding` keeps `ResourceKind`: ticket slots and ticket type rows both use it. One generic guard, `isDiscordResource(value)`, narrows a declaration, binding or plan item at the top of each loop.
- **Ownership is filtered twice, on purpose.** `loadGuildOwnership` keeps Discord kinds only (one private `readGuildBindings` read also hands `previewInstall`/`previewUnpublish` the journey's rows of every kind), **and** `ownerOf` ignores non-Discord rows, because `setTicketSettings`' write-time re-check reads the rows itself. `heldByNoOtherOwner` filters `other.kind in DISCORD_RESOURCE_KINDS`.
- **Provider hook**: `provisioning/ticketTypeProvider.ts` (`registerTicketTypeProvider`, `clearTicketTypeProviderForTests`, `requireTicketTypeProvider`, which throws naming the hook). Tickets implement it in `tickets/logic/ticketTypeProvisioning.ts`. `read` is called only when the journey declares (install) or holds (`resolveJourneyResources`) a ticket type, so journeys without one need no ticket feature.
- **Content rules**: `ticketTypeDefinitionProblem` holds every rule `upsertTicketType` applied (key shape and cap, label presence and the 45-character cap, template). `upsertTicketType`, `createTicketTypeIfAbsent` and the journey save route all call it. The route reuses the ticket route's `ticketTypeSettingsBody`, which `ticketTypeBody` now extends.
- **`createTicketTypeIfAbsent`** carries `exists`/`no-config` out of `mutateConfig` the way `deleteTicketType` carries its refusal, and finds an existing type with `getTicketTypeDefinition` (own keys only — a type keyed `constructor`).
- **Apply sends `adopt` through `createIfAbsent` too**, not only `create` (review finding): a type deleted between preview and apply is made again and recorded `created`, instead of being reported "used as it is". `exists` records `adopted` under the type's own label.
- **Not-ready note**: `PlanItem.note` / `InstallPlanItem.note`, shown once per distinct note in the install dialog. Applied results carry no per-item copy, so "already here; used as it is" at apply time is the `adopted` action itself.
- **Orphans**: a ticket type orphan is `stillInGuild: true`, `mayDelete: false`, with its own "stays in your ticket settings" sentence. No provider read: forgetting is harmless either way.
- **Merge**: `planJourneyMerge` reports `sharedTicketTypes` (same key, both `ticketType`); a same key of different kinds is still a collision. `mergeDeclarations` drops the moving copy; the route uses it. The moving journey's type row stays under it, as Discord rows do (and no longer blocks a delete — below).
- **`deleteTicketType`** gets its own refusal reason, `held-by-journey` (409). It counts a holder only while that journey **still exists and still declares** the key as a ticket type (review finding): deleting a journey, emptying it by grouping, or dropping the type all leave the row behind, and counting it would lock the type behind advice nobody could follow. Journeys are read before the transaction (`journeysRepo.listTicketTypeDeclarations`, unvalidated like `listNamesByGuildId`), the rows on it.
- **Picker scan**: `RESOURCE_PICKER_CONTROLS` (`rolePicker`, `channelPicker`, `categoryPicker`, `ticketTypePicker`) decides whether `<k>Key` is a sidecar; an unknown block stays lenient. `collectResourceTargets` therefore needs the registry; `applyResourcesToFlows.test.ts` and `resourceTargets.test.ts` now await discovery. The browser's `fieldChecks.emptinessIsTheServers` asks the same set, and `resourceTargets.test.ts` holds the two copies equal.
- **Card summary**: `summarizeFromDescriptor` takes the declarations; `FlowNodeCardData.declaredResources` is carried by its own effect in `FlowBuilderPage`.
- **Editor**: `web/src/tickets/TicketTypeFields.tsx` (label, template, auto-claim, grid, with a `keyField` slot beside the label) is used by `TicketsConfigPage` and by a new `TicketTypeBody` in `ResourcesPanel`. The add button comes from `RESOURCE_KIND_ORDER`. A new type starts as `New ticket type` / `new-ticket-type` with the tickets page's starting settings. The key's Autocomplete offers the server's type keys that fit the resource-key shape. Chips: `ticketTypeHere` (info, quiet on an installed key or unknown types) and `invalidTicketType` (error, through `validateTicketTypeDraft`), with a new jump target `ticketTypeFields`. `ResourcesDialog` fetches the ticket types for it.
- **Boot roots are two, not three**: `startPreview` boots through `bootBotForDashboard`, so registering there covers the preview server. The wiring test asserts that hop.

### Deviations, and why

- **The teardown inventory lists kept settings** (`keptSettings` on the published state and body, a "Settings this flow installed" group, uninstall offered when it would only forget). Not in the slice table. Without it a journey holding only a ticket type read "Nothing live in the server yet" and offered no uninstall — the one step that lets the dashboard delete the type. The builder header counts them too (review finding).
- **`settle` and `rebind` write `kind`** (review finding, High). A ticket type row under a key later declared as a channel was rebound to the new channel but stayed labelled `ticketType`, so every fence skipped it and uninstall only forgot a channel the journey had created. The Discord branch of `buildInstallPlan` now plans such a key as new, and `applyInstallPlan` treats only a same-kind row as live. This also closes the older role↔channel relabel gap.
- **`applyInstallPlan` refuses an item whose kind differs from the declaration's** (stale plan), since `prepareCreate` now switches on the item's kind.
- **A forget's failure no longer says the object "was removed from the server"**; only a delete says that.
- **`resourceRows.orderResourceRows`** files ticket types as their own last group instead of "whatever is not a category or role".
- **`resourceSchema` trims a ticket type's label** (review finding), so the declaration, the row's `name` and the type agree.
- **AGENTS.md** lists no resource kinds, so it was not changed.

### Grep inventory (`!== 'role'`, `!== 'category'`, `=== 'role' ?`, `Exclude<ResourceKind`, `kind: string`)

- `provisioningService.ts` (`resolveJourneyResources`): fixed — branches on `isDiscordResource`, types resolve through the provider.
- `installPlan.ts` stillThere / `existsInGuildAs` / `findByName`: fixed by narrowing; reached only after the ticket type branch.
- `unpublishPlan.ts` permission and hierarchy checks: fixed (narrowed, behind the forget branch).
- `resourceDrift.ts` `detectReparent`/`detectPermissionDrift` (`kind === 'role'`): safe — drift never sees a ticket type (`buildJourneyDriftPlan` skips them first).
- `applyUnpublishPlan.ts:204, 243`: fixed (forget copy) / safe (`deleteFromGuild` narrowed).
- `lookupBoundChannel.BoundChannelKind`: now `Exclude<DiscordResourceKind, 'role'>`.
- `publishedFlowState`/`driftBody`/web wire `kind: string`: safe — strings rendered through `RESOURCE_KIND_STYLES`, which has a ticket type entry.
- Web: `resourceRows.ts:89` fixed; `resourceAdoption.ts:96, 131, 188, 280` safe (`canAdoptFromChannelList`/`adoptableTypesFor`/`canHaveParent` are positive checks, `adoptableRoleOptions` returns nothing for a type), `canAdopt` decided `false`; `resourceNameSuggestions.collidableNamesFor` fixed (returns nothing for a type); `ResourcesPanel.tsx:246-247` safe (positive filters), `:421` safe (no adoption for a type), `:763-765` safe/replaced by `TicketTypeBody`, `:1201` fixed (`hasChannelPermissions`); `detectResourceProblems.ts:137` safe (role keys only); `publishedSummary.isKnownKind` safe (table has the entry).
- Every `Record<ResourceKind, …>` and `never` switch: filled (four `KIND_LABEL`s, `KIND_ORDER`, `KIND_NOUNS`, `RESOURCE_KIND_STYLES`/`ORDER`, `normaliseResourceName` both sides, `generatedNameFor`).

### Sabotage-verified

Each guard was broken, the named test watched fail, and the guard restored. After the last restore, a grep of the touched files found no leftover sabotage and `git status` showed only intended files.

- `heldByNoOtherOwner` Discord-kinds filter removed (both the first `!= 'ticketType'` form and the final `in DISCORD_RESOURCE_KINDS` form) → **12l** failed: B's adopt settle refused.
- `loadGuildOwnership` filter **and** `ownerOf`'s kind check removed together → **12l** failed at the plan (blocked). Either alone is covered by the other, by design.
- Provider built on `upsertTicketType` → the integration test "records a type made between preview and apply as adopted" failed.
- Ticket type rows let past their branch in `buildUnpublishPlan` → three `unpublishPlan` unit tests and the integration uninstall test failed (the all-digits case planned a channel delete).
- `holders.length > 0` disabled in `deleteTicketType` → the unit refusal test and the integration dashboard test failed.
- Lexical `*Key` scan restored → two `resourceTargets` tests and the Pick Random `pendingResourceFields` test failed.
- `kind` removed from `rebind` → the integration "key that changes from ticket type to channel" test failed.
- `mergeDeclarations` replaced by a spread in the group route → the new `flowGroupRoutes` shared-ticket-type test failed.
- A runtime import from tickets added to `ticketTypeProvider.ts` → `dependencyDirection` "imports nothing from src/features/tickets at run time" failed.
- `registerTicketTypeProvisioning()` removed from `bootBot.ts` → the wiring test failed.

### Verification

- Root `tsc`: 17 errors, the baseline, none in a touched file. Web `tsc`: 0. `web/e2e` `tsc` (`tsc -p web/e2e/tsconfig.json`): 5, its baseline.
- Full suite with `--maxWorkers=4` (re-run by the coordinator 2026-10-10, because the builder's own output was lost): 3,587 passed and 3 failed, with one file failing as a whole. Each failure was classified:
  - `ciBranchProductDiff`: the known failure.
  - `birthdayAnnouncementService` "skips overlapping runs": depends on the time of day, and the run was near midnight.
  - `flowCycles.test.ts`: its `beforeAll` block discovery hit the 10s hook limit under load. It passes alone with `--hookTimeout=120000` (18/18).
  - `web/e2e/flowIncomplete`: fails alone as well. **It fails identically on a clean worktree at `e0dd013`**, which has neither this step nor the binding table, so it isn't a regression. It's the load-dependent 600ms re-check, and should be re-run on a quiet machine.
- Coordinator's own sabotage: disabling the ticket type `forget` branch in `buildUnpublishPlan` failed three `unpublishPlan` tests and the integration test "leaves the type, its tickets and a flow using it exactly as they were". Restored: 34/34.
- The machine was loaded by other projects throughout. e2e files run alone hit their 10s `beforeAll` (`bootBotForDashboard`) timeout — `flowTeardown` too, untouched by this step — and pass with `--hookTimeout=120000`; `journeyTicketType.test.tsx` passed that way.
- `web/e2e/flowIncomplete` fails alone as well as in the suite, at the assertion that no `POST /check` was sent after the first keystroke. The request it finds is the 600ms structural re-check scheduled by adding the node, which fires when the save takes longer than that. Disabling this step's only behavioural builder change (the declarations effect) did not change the result, so it is recorded as the known load-dependent flake, now reproducing alone under this load — not a regression shown to be this step's. Worth re-running on a quiet machine.

### Review

The orchestrating `reviewer` was not used; the domain-runtime, maintainability and general specialists ran directly, read-only. No Critical.

- **Fixed — High**: the ticket type → channel kind change leaking a created channel (both domain-runtime and general).
- **Fixed — Medium/High**: a leftover type row locking the type forever; the builder header and Resources panel ignoring kept settings (and so showing `ticketTypeHere` on an installed row); `adopt` not re-checked at apply and the delete comment overclaiming the lock; the editor implying edits to an installed type land; the five checks that named `ticketType` where they meant "not a Discord object"; `RESOURCE_PICKER_CONTROLS` mirrored with no gate; the half-duplicated settings schema; `alreadyBound` admitting type keys; the `constructor` key; the untrimmed label; the duplicated resource-key regex; the cycle-exemption comment; the `PlanItem.reason` doc; a route test for the merge rule.
- **Left**:
  - *Medium* — write-back does not check the resource kind against the picker's control (`bindResourcesToGraph`). Reaching it needs a node keeping a sidecar while its key is re-declared as another kind; readiness only checks emptiness.
  - *Medium* — the provider's create and the row write are two transactions; a delete landing between them leaves a row for a missing type, which the next install plans as "made again". Comment now says so.
  - *Low* — `KIND_LABEL` exists in four provisioning files (pre-existing shape; each gained one entry).
  - *Low* — `TicketTypeReading.ready` has no reader beside `notReadyNote` (the plan specified both).
  - *Low* — `SharedTicketType` has `KeyCollision`'s shape; the browser reuses `KeyCollision`.
  - *Low* — a live flow carrying a field and a sidecar for different types (API-only) bypasses the loop check on write-back; recorded in the comment.
  - *Low* — `collectBlockers` still refuses a ticket-type-only journey when the bot member is not cached; an `intended` row under a ticket type key blocks rather than being forgotten.
  - *Low* — `keptSettings`, like the rest of the published body, has no `*_KEYS` drift gate (pre-existing gap); `TicketTypePickerControl`'s change handler is a fourth copy of the declared-or-guild pattern, differing on purpose.
  - *Process* — the e2e declares and installs through the API rather than the "Add ticket type" button (the panel's component tests cover the button). Two self-contained pieces (the `*Key` scan fix, the `TicketTypeFields` extraction) could be committed ahead of the feature.

### Deploy note

Rolling back to code without `ticketType` while journey rows of that kind exist throws in `normaliseResourceName` (and any `Record<ResourceKind, …>` lookup). Uninstall such journeys, or delete the rows, before rolling back.

### Owed before release

A live-guild run: declare a ticket type in a journey on a configured server, install (create and reuse), open a ticket through the wired flow, uninstall and confirm the type and its tickets are unchanged, then delete the type from the dashboard.
