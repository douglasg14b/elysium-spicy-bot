# One record of what the bot owns, for journeys and tickets

> **Status**: Built 2026-10-10; live run pending
> **Owner**: Douglas
> **Predecessor**: [22-ticket-categories-bound-by-id.md](22-ticket-categories-bound-by-id.md). Its section "Why the shared table is next, not never" is the reason for this step
> **Next**: PRD §5.7 *Subsystem configuration is a declarable resource*. Out of scope here: a journey still cannot *declare* a ticket category

## The defect

The bot keeps two separate records of the Discord objects it owns:

- journeys use `resource_bindings`, one row per guild, journey and resource key;
- tickets keep three category slots (`open`, `claimed`, `closed`) inside the `ticketing_config.config` JSON blob.

Neither record can see the other, which causes three problems:

1. **Install recovery can take a ticket category.** `boundInGuild` reads only `resource_bindings`. A journey with a stale intent for a same-named category, created within the ten-minute window, can recover the ticket category as `created`. That journey's uninstall later deletes it.
2. **Adopting is unfenced both ways.** A journey can adopt a ticket category, and the ticket settings can adopt a journey's category. The same gap exists between journeys: sharing was cut on 2026-09-24, but `installPlan.ts`'s adopt path still accepts any id that passes `existsInGuildAs`.
3. **Uninstall deletes what another owner uses.** If tickets were later pointed at a category a journey `created`, that journey's uninstall deletes it. The next ticket then recreates it.

## Operator decisions (2026-10-10)

- **A category or channel belongs to one owner.** Once one owner holds it, nobody else can pick or adopt it, and the refusal names the owner. This applies between a journey and tickets, and also between two journeys, which closes the gap the 2026-09-24 cut left open.
- **No crash recovery for ticket creates.** Tickets get no intent-then-recover. Douglas's call: the worst case is one empty duplicate category, and he would delete it by hand. Two cases stay accepted:
  - a recreate that never gets an answer can leave a stray;
  - a category that has been created but not yet recorded belongs to no one, so a journey's same-named stale intent could still recover it. The uninstall refusal below is the backstop.

  The #22 plan said the shared table "brings an intent row". That promise is withdrawn, not delivered.
- **Only ticket categories join the record.** The panel message, each ticket's channel, flow button messages and wait messages are things the bot posts. They are not setup it owns.

## The model

`resource_bindings` becomes owner-keyed:

| Column | Change |
|---|---|
| `owner_kind` | **New.** `'journey' \| 'tickets'`, not null. Existing rows get `'journey'` |
| `owner_key` | **Renamed** from `journey_key`. Holds a journey's key, or `'tickets'` for the ticket feature |
| `resource_key` | Unchanged. For tickets it is the slot: `open`, `claimed` or `closed` |
| unique index | `(guild_id, owner_kind, owner_key, resource_key)` replaces the triple. `(guild_id, journey_key)` becomes `(guild_id, owner_kind, owner_key)` |

**Why rename instead of adding a column beside `journey_key`:** a ticket row with `journey_key = 'tickets'` would mislead every reader. The rename is mechanical, and the compiler lists every reference.

**Why a separate `owner_kind`:** journey keys are chosen by the operator (`resourceKeySchema`), so a journey called `tickets` must not collide with the ticket feature. `owner_kind` is a literal union, not a registry. §5.7 can widen it.

**How a slot maps to a row:**

| Slot in today's blob | Row (`kind: 'category'`) |
|---|---|
| `null` | no row |
| `{ name, discordId: null }` | `state: 'intended'`, `discord_id: null`, `name` |
| `{ name, discordId, provenance }` | `state: provenance`, `discord_id`, `name` |
| anything else | the migration **throws**, naming the guild and slot |

An unbound slot becomes an `intended` row, which already means "a name is expected, nothing is bound yet". Journey recovery runs only over the journey's own `existingBindings`, and the ticket owner is never installed, so recovery never touches these rows.

When two slots point at one category, they become two rows with the same `discord_id` and the same owner. There is still no unique index on `discord_id`: "one owner per object" can't be an index when one owner's two slots legitimately share an id. It is enforced when an object is claimed (see below).

**`name` is the expected name, not "diagnostics only".** Drift compares adopted bindings against it, and ticket recreate uses it. Fix the comments in `resourceBindingsSchema.ts` and in `renameBinding`, and drop the stale claim that sharing "is a case the schema anticipates".

## Ticket config: stored row and read model

Two named types in `ticketingSchema.ts`:

- **`StoredTicketingConfig = Omit<TicketingConfig, 'categories'>`.** This is the blob as written. The table's raw row type uses it, and only `ticketingRepo` sees that raw type.
- **`TicketingConfigEntity`** stays the **assembled** read model, `config: TicketingConfig` with `categories` included. `ConfiguredTicketingConfigEntity`, `isTicketingConfigConfigured` and about ten synchronous readers (blocks, `resolveTicketAction`, embeds, modals, the GET view) don't change.

`ticketingRepo` owns both directions:

- **Reading.** `get` reads the config row and that guild's `tickets` binding rows, then assembles them. A slot with no row is `null`.
- **Writing.** `upsert`, `update` and `mutateConfig` all go through **one private serializer**. It takes a `StoredTicketingConfig`, removes any `categories` member a spread carried in, and stringifies. The callers' literals (deploy's first row, the modal's `withRoles`) are retyped to `StoredTicketingConfig`, and the modal stops making up a `categories` default. `JSONColumnType`'s insert type is `string`, so the table type alone guards nothing on write. The serializer is the guard, and it has a test that reads the **raw** column.
- **`mutateConfig`** hands `mutate` the assembled config, read on **the transaction it was given**. Querying the `database` singleton inside `mutate` deadlocks SQLite, as the method's own comment explains. After `mutate` and any binding writes, it **re-assembles from the rows on the same transaction and returns that**. The PUT `/config/tickets` and ticket-types PUT responses render `result.config.categories`, and must show the slots as saved.
- The bindings repo methods tickets call take an optional executor, defaulting to `database`. `ticketsRepo.ts:22` is the precedent. `resourceBindingsRepo` joins the provisioning barrel.

GET `/config/tickets` keeps its wire shape.

## Behaviour

### Claiming: one owner per object

`ownerOf(guildBindings, discordId, self)` is a pure function in provisioning. It returns another owner that holds a **settled** binding for that id, or nothing.

- `self` is `{ kind, key }`, and rows for `self` don't count.
- An `intended` row has no id, so it never matches.
- If two other owners hold the id (only possible with legacy data), the first in `(owner_kind, owner_key)` order is named.

An owner is named to the operator as "the ticket system", or "journey ‹display name›". Display names come from `journeysRepo.listByGuildId`. If the journey row is gone, the key is used.

**Journey adopt.**
- `buildInstallPlan` gets the guild's bindings, already read once by `previewInstall`'s `listByGuild`. They are passed down beside `boundInGuild`, not read again.
- In the `adoptDiscordId` branch, an id held by another owner becomes `blocked`, with the owner named.
- The name-collision `blocked` reason (`installPlan.ts:442-449`, currently "choose whether to adopt it") also names the owner when the single match is held, so it is not a dead end.

**Ticket adopt.**
- `setTicketSettings` reads `listByGuild` and journey names in step 1, refusing as `invalid-input` with the owner named.
- Re-sending a slot's bound id is still "keep".
- Two ticket slots sharing a category is the same owner, so it is allowed.

**The race is closed on write, not just checked.** A ticket save checks in step 1, then spends seconds creating before it writes. A journey install holds a different lock, so the two can interleave, and so can two journeys. So the write repeats the check:

- **Ticket slot writes** re-run `ownerOf` on the `mutateConfig` transaction before writing, and refuse the slot as `invalid-input`. On SQLite's single connection this is atomic.
- **Journey `settle`/`rebind` with `state: 'adopted'`** are conditional: `WHERE NOT EXISTS` a settled row with the same guild and `discord_id` under another owner. Zero rows back is reported like any lost settle.
- **Accepted:** the remaining READ COMMITTED window on Postgres between two concurrent conditional writes. Its backstop is the uninstall rule below.

**The pickers say so.**
- `GET /:guildId/channels` gains a per-channel `owner: { kind, key, label } | null`. It is currently synchronous and cache-only. It becomes async, with two DB reads: `listByGuild`, plus journeys for labels.
- `GUILD_CHANNEL_KEYS` in `src/web/api/guildBody.ts`, its mirror in `web/src/api/types.ts`, and `guildWireShapeDrift.test.ts` are updated.
- `ExistingChannelOption` gains `disabled` and the owner text.
- `adoptableChannelOptions` compares `owner` against the current journey key, so the journey's own channels stay enabled. It **disables** options held by another owner, and still hides ids claimed elsewhere in the same declaration list, as it does today.
- `categorySlotOptions` disables categories held by a journey.
- Check that `resourceChips` and `resourceNameSuggestions` never suggest a disabled option.

### The fences see every owner

- **`boundInGuild`** already reads every row through `listByGuild`, so ticket rows are included after the migration. No code change, but it gets proof: an integration test where a ticket-owned category inside the recovery window is not recovered by a journey. Sabotage: filter `listByGuild` to `owner_kind = 'journey'`.
- **Uninstall's recovery fence.** `buildUnpublishPlan` gains a `guildBoundIds` input, filled by `previewUnpublish` from `listByGuild`. `findInterruptedCreates` uses it instead of the journey's own ids at `unpublishPlan.ts:219-221` and `:251`. `bindings` stays journey-scoped.
- **Uninstall never deletes what another owner holds.** A `created` binding whose `discord_id` is also bound by another owner becomes a **`forget`** item. `forget` already means "remove only the row", and its explanation names the owner and says the object is left standing. No new refusal reason and no web change. This check comes **before** `category-has-survivors`, so it applies to an empty category as well. It also covers cross-claims that already exist today, because the migration copies slots as they are.

### Cross-claims that already exist

The migration logs every id held by more than one owner, per guild. It visits every slot anyway, so this costs nothing.

**Drift** marks an item whose object another owner also holds as **not repairable**, using `ownerOf`. Otherwise a journey's repair of a shared `created` category would strip the ticket moderation overwrites.

**Accepted:** when tickets recreate a deleted category, only `tickets` rows are repointed. A journey row on the same dead id stays dead, and its next install offers to recreate it as usual.

### Journey readers filter on owner

There is one helper, `isJourneyBinding(binding, journeyKey)`, or a `listJourneyBindingsByGuild`; the builder picks one and says which. Its users:

- `listByJourney`, `get`, and `recordIntent`'s conflict target, which now includes `owner_kind`;
- **`previewInstall`'s in-memory filter** (`provisioningService.ts:51-53`, `binding.journeyKey === …`). After a mechanical rename this still compiles. A journey keyed `tickets` would then take the ticket rows as its own;
- `groupBindingsByJourney` / `journeyInstallState` and `flowJourneyIndex`.

`journeyRoutes.ts:953`, `orphanedBindings` and `journeyMergePlan` receive rows already scoped by `listByJourney`, so they need only comment fixes. `listByGuild` stays unfiltered, because the fences need every owner. Grep `.journeyKey ===` and `.ownerKey ===` after the rename.

### Ticket writes

- **`setTicketSettings`**: adopt and create set the slot's row by upserting on the owner key, with `state`, `discord_id` and `name`. The order is unchanged: check, create, then write once inside `mutateConfig`'s transaction, roles included. A failed create still saves the rest.
- **`resolveTicketCategory`** re-reads the stored slot from the rows.
- **`recreateDeletedCategory`** is one standalone compare-and-set statement:
  - it is scoped `guild_id + owner_kind = 'tickets' + discord_id = deleted`, which repoints every slot sharing it;
  - it sets `state: 'created'`;
  - it no longer goes through `mutateConfig`, because no config changes;
  - zero rows back means the operator re-linked in the meantime, so the new category is deleted as today.

  `renameBinding`'s comment explains why an id-only update is too broad.
- The busy guard, the coalescing map and the 10003-only rule are unchanged.

## Migration: `2026-10-10-Owner_Keyed_Resource_Bindings.ts`

**It runs through the production migrator stack.** The migrator uses the `database` singleton, with `CamelCasePlugin` and, on SQLite, `SqliteJsonPlugin`, which parses any column named `config`. So:

- `config` arrives as an object, on Postgres (jsonb) and SQLite alike, but a bare Kysely gives a string. Normalise with `typeof config === 'string' ? JSON.parse(config) : config`;
- read result keys whether or not they are camelCased;
- always write with `JSON.stringify`.

The test runs a real `Migrator` on the production `database`, following the precedent in `__tests__/activityBackfillMigration.test.ts`. No earlier migration has done a select, then a TypeScript loop, then a write.

**Up:**

1. Add `owner_kind` with default `'journey'`, rename `journey_key` to `owner_key`, and rebuild both indexes. The SQLite in use is 3.50.2 (better-sqlite3 12.2.0), so `RENAME COLUMN` and `DROP COLUMN` both work.
2. For every `ticketing_config` row, insert one row per non-null slot, following the mapping table. `created_at` and `updated_at` are now. Use `onConflict` do nothing.
3. Remove `categories` from each blob: parse, delete the member, write it back.
4. Log the cross-claimed ids.

**SQLite migrations aren't transactional here** (Kysely wraps only Postgres). So the SQLite arm runs inside `db.transaction()`, and uses only `trx` inside it, per the earlier migrations' deadlock note. A crash then leaves nothing half-done for a re-run to trip over. A re-run of the whole migration is a no-op.

**Down:**

1. Write `categories` back into **every** `ticketing_config` row, with `null` for any slot that has no row. The pre-change code requires the member on read.
2. Delete rows **where `owner_kind = 'tickets'`**, never by `owner_key`, which would wipe a journey keyed `tickets`.
3. Drop the new indexes, drop `owner_kind`, rename back, and recreate the old indexes. SQLite won't drop an indexed column, so the order matters.

**Postgres.** Production runs Postgres; CI runs only SQLite. The implementer attempts a Docker Postgres run of the untested chain, in order: `2026-09-23-Add_Ticket_Identity_And_Types`, `2026-10-01-Bind_Ticket_Categories_By_Id` (whose `jsonb_set` arm this migration reads), `2026-10-04`, `2026-10-05`, and this one. Each runs seed, up, down, up. If Docker isn't available, say so; the run stays owed before release.

## Slices

| # | Change | Proof |
|---|---|---|
| **A** | Migration, the schema and repo rename, `isJourneyBinding` on every journey reader (including `previewInstall`), comment fixes | Real-`Migrator` test covering bound, unbound, null and shared-id slots; a guild with no config row; a guild with all-null slots; a journey keyed `tickets` that declares `open`. Re-run is a no-op. `down` round-trips every blob deep-equal. Flows-list install state with a journey keyed `tickets` shows no ticket rows (sabotage the filter). Existing provisioning suites pass, with `ownerKind` added to `ResourceBindingEntity` fixtures. Docker Postgres run, or a statement that it couldn't happen |
| **B** | Read model and stored type split, the serializer, `mutateConfig` re-assembly, `setTicketSettings` and recreate writing rows on the transaction. **Fixture rebuild**: the `mutateConfig`, `setTicketSettings`, `ticketCategories` and `deleteTicketType` integration suites run the binding migrations and seed rows. A shared seed helper writes slot rows, used by `flows/__tests__/ticketEvent.test.ts`, `web/e2e/ticketActions.test.tsx` and `web/e2e/preview/scenario/seedTickets.ts` | The existing suites pass, with asserts moved to rows. The serializer test reads the raw column after a spread write through `mutateConfig` and through `upsert` (sabotage the strip). A PUT response carries the new slot id. A recreate repoints both rows when two slots shared the deleted id. The preview scenario still shows a configured guild |
| **C** | `ownerOf`; journey adopt `blocked`, plus the name-collision copy; ticket adopt refused; conditional adopted `settle`/`rebind`; the ticket write re-check; uninstall `forget`-with-owner before survivors; `guildBoundIds`; drift not repairable when shared; `owner` on `GET /channels` with the drift keys; both pickers disable owned options | A ticket-owned category is not recovered by a journey (sabotage: filter `listByGuild`). A journey can't adopt a ticket category, tickets can't adopt a journey's, and journey A can't adopt journey B's. Uninstalling a journey whose **empty** `created` category tickets use leaves it standing and forgets the row (sabotage the check). A shared `created` category is not repairable in drift. Picker unit tests, including that a journey's own channel stays enabled |
| **D** | Docs: PRD §5.6 row (line 274) and the stale `(guildId, resourceKey)` key (line 337, §6.4); the build-order 5B row; the #22 plan status and its two "the shared table brings an intent row" sentences (withdrawn); the `provisioning/index.ts` barrel comment. Code comments: `ticketCategories.ts:106-109`, `ticketingSchema.ts:147-150` and `170-177`, `resourceBindingsSchema.ts:22-32`, `resourceBindingsRepo`'s "key triple" in `recordIntent` and `renameBinding`, `journeysSchema.ts:22`, `applyResourcesToFlows.ts:40-41`, `journeyMergePlan.ts:11,25` | Full suite at baseline, root tsc at baseline, web tsc 0 |

One reviewer pass after A–C, because this is a migration, a contract change and a fence.

**Carry into `feat/web-sdk`** when it rebases: `owner` on the channels directory and on the roles directory (`GuildObjectOwnerBody`, `GUILD_CHANNEL_KEYS`, `GUILD_ROLE_KEYS`, `GUILD_OBJECT_OWNER_KEYS`), `withheldReason` on the drift body (`DRIFT_RESOURCE_KEYS`), the `taken-meanwhile` ticket settings refusal, and the picker changes (channel, role and ticket category slot).

## As built (2026-10-10)

All four slices are in the working tree, uncommitted. Nothing has been run against a live guild yet.

### Decisions the plan left open

- **Journey filter: `isJourneyBinding(binding, journeyKey)`**, a pure predicate in `provisioning/logic/bindingOwner.ts`. It is used by `previewInstall`, `previewUnpublish`, `previewDrift` and `repairUnderLock`. `groupBindingsByJourney` checks `ownerKind === 'journey'` directly. `listByJourney`, `get` and `recordIntent` (including its conflict target) name `owner_kind = 'journey'` in SQL. `listByGuild` stays unfiltered, now ordered by `(owner_kind, owner_key, id)` so "the first other owner" is stable.
- **One read for every "who holds this?" question: `loadGuildOwnership(guildId)`**, which returns `GuildOwnership { bindings, journeyNames }`. `ownerOf` is the pure check, `describeOwner` names an owner ("the ticket system", `journey "Name"`, or the key when the journey row is gone), and `describeOtherHolder` combines the two. Journey names come from a new `journeysRepo.listNamesByGuildId`, which is deliberately unvalidated so that one malformed journey cannot break the channel directory or ticket saves.
- **`TICKETS_OWNER = { kind: 'tickets', key: 'tickets' }`** lives in `resourceBindingsSchema.ts`, beside `journeyOwner(key)`.
- **`upsert` and `update` take the stored object, not a string.** `NewTicketingConfigEntity.config` is `StoredTicketingConfig`, so `serializeStoredConfig` really is the only way a blob reaches the column. Every caller and fixture was changed to match.
- **`mutateConfig`** assembles on its transaction both before `mutate` and when it builds its return value. The mutator returns `StoredTicketingConfig`, and a spread of the assembled config is fine because the serializer strips it. Slot writes go through `ticketingRepo.writeCategorySlots(…, transaction)`. The recreate uses `ticketingRepo.repointCategory` → `resourceBindingsRepo.repointOwned`.
- **Test fixtures.** A shared helper, `tickets/__tests__/support/ticketTestTables.ts`, provides `createTicketTestTables` (the real migrations: ticketing config, bindings, journeys, this one) and `seedTicketCategorySlots`. `provisioningTestDb` also runs journeys, ticketing config and this migration. The preview seed and the e2e `ticketActions` already create their categories through the real PUT, so they needed only the `upsert` shape change, not the slot seed.

### Deviations, and why

- **`buildUnpublishPlan` takes `ownership`, not `guildBoundIds`.** A `forget` caused by another owner has to name that owner, which a set of ids cannot do. The id set is derived from `ownership.bindings` inside.
- **The write-time re-check refuses only the contested slot, and saves the rest.** The first cut refused the whole save. Two reviewers pointed out that this left a category the save had just made unrecorded, contrary to step 3's own promise. The fix adds a `taken-meanwhile` arm that carries `config`, like `create-failed`: HTTP 409, and the panel is refreshed.
- **Drift copy moved server-side: `withheldReason` on the drift wire.** This was not in the plan. `whyNotRepairable` in the browser fell through to "adopted" for anything other than `wrongType`, so a shared category the journey created would have been called adopted. Its own comment said to move the sentence server-side once a third reason appeared, and sharing is that reason. `describeWithheldRepair` in `resourceDrift.ts` now supplies both the dialog sentence and the repair refusal.
- **Sharing is re-derived at repair time** (`withSharingReasserted`), like adoption, rather than trusted from the plan.
- **A lost adopt settle discards its intent row.** Nothing was made, and a fresh intent left behind could later recover a same-named object as `created`.
- **The `GET /channels` directory reports one owner**, the first in `(kind, key)` order. For legacy cross-claims the picker can judge by the wrong owner; the server, which excludes the asker, still decides. This is documented on `GuildChannelBody.owner`.
- **A refusal raised by the re-check names a journey by its key**, not its display name, when that journey appeared after step 1. Names are read once, before the transaction.

### Sabotage-verified

Each guard was reverted, the named test was watched fail, and the guard was restored. After the last restore, a grep of the touched files found no injected conditions.

- `listByGuild` filtered to `owner_kind = 'journey'` → **12e** failed: the interrupted install planned `recover` on a ticket category.
- Owner-kind filter removed from `groupBindingsByJourney` → the flows-list "journey keyed `tickets`" test and the `groupBindingsByJourney` unit test failed.
- Serializer strip removed → the `mutateConfig.integration` raw-column test failed.
- Forget-when-shared branch removed from `buildUnpublishPlan` → three `unpublishPlan` unit tests and **12i** failed.
- Journey adopt fence removed from `installPlan` → **12f** (ticket category) and **12g** (journey A → journey B) failed.
- Ticket step-1 fence removed from `setTicketSettings` → "refuses to adopt a category a journey holds" failed.
- Ticket write-time re-check removed → the race test failed. This was checked against both the first cut and the per-slot version.

### Postgres

The plan's chain ran against a throwaway `postgres:16` in Docker, through the production migrator stack (`database` with `CamelCasePlugin`), using the script's own seeds. **Every check passed.**

- **`2026-09-23-Add_Ticket_Identity_And_Types`**: seed, up, down, up. Its down deliberately keeps `ticketTypes` and drops the identity columns; a seeded ticket survives.
- **`2026-10-01-Bind_Ticket_Categories_By_Id`**: names become unbound slots, down restores the names.
- **Both `2026-10-04` migrations and `2026-10-05`**: up, down, up.
- **This migration**, run after bound, shared and cross-claimed slots were written into a blob:
  - up produced exactly the expected owner-keyed rows, including a journey keyed `tickets` beside the ticket feature's `open`;
  - every blob was stripped;
  - the new indexes were in place;
  - the cross-claim was logged;
  - down round-tripped every blob deep-equal and left only the journey rows;
  - a second call to `up` on the migrated database changed nothing.

The script was deleted afterwards. SQLite is covered by `ownerKeyedResourceBindingsMigration.test.ts` through a real `Migrator`.

### Verification

- Root `tsc`: 17 errors, the pre-existing baseline, none in a touched file.
- Web `tsc`: 0.
- `web/e2e` `tsc`: 5, its pre-existing baseline.
- Full suite: 3490 passed and 3 failed. The failures:
  - the known `ciBranchProductDiff` failure;
  - `birthdayAnnouncementService` "skips overlapping runs", which depends on the time of day: it fails outside 07:00–22:00 and the run was at about 01:30;
  - `web/e2e/flowIncomplete`, which flakes under parallel load and passes alone.

### Review

A reviewer pass ran. The orchestrating `reviewer` handed back without results, so the domain-runtime, maintainability and conventions specialists were run directly. They found no Critical issues.

- **The only High:** the Postgres run had not been recorded. It is recorded above.
- **Mediums, all fixed:**
  - the whole-save refusal;
  - two server sources for the withheld-repair reason;
  - `loadGuildOwnership` breaking on a malformed journey;
  - no real-SQL test of the conditional adopted `rebind` (added as **12k**).
- **Lows fixed:**
  - discarding the intent row on a lost adopt;
  - `withSharingReasserted`;
  - the `heldByNoOtherOwner` return type;
  - one `heldByLabel` formatter;
  - the narrowing in `categorySlotOptions`;
  - the legacy-owner note on `owner`.

### Second round (after the review, 2026-10-10)

The general review found three things still open. All three are fixed, and each guard was sabotage-verified independently of the builder:

- **Crash recovery skipped the write-time ownership guard.** A `recover` binds an object that already exists, but it settled as `created`, which bypassed the adopted-only guard.
  - `settle` and `rebind` now apply `heldByNoOtherOwner` unconditionally. A freshly created snowflake can't be held by anyone, so the guard costs nothing.
  - A lost `recover` or adopt discards its intent and says it let go. It no longer warns that a duplicate may have been made.
  - New test: **12e2**. Sabotage: restoring the adopted-only `$if` makes 12e2 fail.
- **The role picker offered roles the server refuses.** `GuildRoleBody` gains `owner`, shared with channels as `GuildObjectOwnerBody`, with `GUILD_ROLE_KEYS` and `GUILD_OBJECT_OWNER_KEYS` in both drift gates.
  - `adoptableRoleOptions` disables another owner's role and keeps the journey's own role enabled.
  - The `nameTaken` chip copy no longer promises an adopt.
  - Sabotage: passing `null` for the role owner makes the role-picker test fail.
- **There was no real-SQL test of journey-against-journey on write.**
  - New test: **12h2**. Two journeys race to adopt one category; the second write is refused and holds nothing.
  - Sabotage: removing the `ownerKey !=` half of `heldByNoOtherOwner` makes 12h2 fail.
  - **12j** now also applies the repair and checks that the refusal names the ticket system.

Also in this round:
- The ticket-slot picker disables anything not owned by tickets, not only journey-owned items.
- `ticketingRepo.delete` was removed. It had no callers, and it would have left the slot rows behind.

Verification after the second round:
- Root `tsc` 17 errors (baseline). Web `tsc` 0.
- Full suite with `--maxWorkers=4`: 3,495 passed and 2 failed. One is the known `ciBranchProductDiff` failure. The other is `web/e2e/flowIncomplete`, which passed when run alone.
- At the default worker count, the machine was loaded by other projects' processes, and 22 files failed on hook timeouts alone. None of those failures were assertions.

### Known gaps and Lows left

- **`boundInGuild` and `ownership`** both reach `buildInstallPlan` from one read. They agree by construction, but the id set is built in two places.
- **`ticketingRepo.upsert`** checks existence with `get`, which is now two queries.
- **`mutateConfig` commits when a mutator returns null.** No mutator writes before refusing today, but nothing enforces that.
- **The strip guarantee is by convention.** A future write to `ticketing_config` outside the repo would compile.
- **`withheldReason` and `repairable`** are separate fields, not a discriminated union.
- **The cross-claim warning is logged on every run of `up`**, including a no-op re-run.
- **Deploy window:** an old process still serving while this migration runs would query the renamed `journey_key`. The container entrypoint migrates before `pnpm start`, so this only matters if old and new containers overlap.
- **The Docker run covered the migration chain only.** The repo's new SQL has run only on SQLite: the correlated `NOT EXISTS` in adopted `settle`/`rebind` (12h, 12k), `repointOwned`, and the in-transaction slot writes. It is standard SQL, and Postgres allows an UPDATE's subquery to reference the target table, but nothing here has proved it on Postgres. The Docker run also predates the review fixes; the migration file has not changed since, so the recorded result still describes it.
- **Owed before release:** a live-guild run of the ticket settings page, a journey install over a ticket category, and an uninstall of a shared category.
