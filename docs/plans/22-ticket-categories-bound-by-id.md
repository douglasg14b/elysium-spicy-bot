# #22 — Ticket categories are bound by id, and provisioned like journey resources

> **Status**: Slices A–D built 2026-10-01; live run pending
> **Owner**: Douglas
> **Issue**: [#22](https://github.com/douglasg14b/discord-spicy-bot/issues/22)
> **Unblocks**: PRD §5.7 *Subsystem configuration is a declarable resource*
> **Predecessor**: [5B3-install-converges-after-interruption.md](5B3-install-converges-after-interruption.md), whose closing section held the first round of decisions. This plan supersedes two of them (see below)

## The defect

`ticketing_config.config` holds three category **names**. Every ticket operation finds
its category with `channel.name === categoryName` and creates one when nothing matches.
So renaming a category in Discord makes the bot quietly create a second one with the old
name; two categories with the same name are picked between arbitrarily; and a journey cannot bind a
ticket category, because provisioning binds by id.

## The model: three slots, each one a small binding

Each category slot (`open`, `claimed`, `closed`) is one of three things:

| Slot | Meaning |
|---|---|
| `null` | Nothing chosen yet |
| `{ name, discordId: null }` | An **expected name** with no category tied to it — what the migration leaves, and what a crash mid-save leaves |
| `{ name, discordId, provenance: 'created' \| 'adopted' }` | Bound. `name` is the expected name; the id is what every lookup uses |

That is the shape a `resource_bindings` row already has (expected name, id, provenance),
kept inside the ticket config for now. Provenance is recorded although nothing deletes a
ticket category yet, because it can only be known at bind time and the move to a shared
table (below) needs it.

**The ticket system works only when all three slots are bound.** `isTicketingConfigConfigured`
requires it, and `ConfiguredTicketingConfig` narrows the slots to the bound arm, so
everything downstream reads an id without re-checking. A slot that is only named is
**never** resolved by name at runtime — that would be #22 coming back by another route.

## Operator decisions

From 2026-09-27, still standing:

- Ids, not names, decide where a ticket goes. Nothing finds a category by name any more.
- The migration does not guess ids from names.
- A bound category that has been **deleted** is recreated and its new id saved.
- The Discord setup modal loses its category fields; the dashboard is the only place
  categories are chosen.

From 2026-10-01, **superseding** the earlier "clear the names" and "re-pick only":

- **The expected name is kept beside the id.** The migration carries each old name into its
  slot, unbound. Recreating a deleted category uses that name.
- **The dashboard can create, not just pick.** Each slot offers the guild's existing
  categories *and* "create one called …". Saving creates it with the ticket permissions
  and records it as `created`; picking one records it as `adopted`. A new server needs
  nothing done by hand in Discord.
- **Where the bindings live:** in the ticket config for this step. The shared parts of
  provisioning are extracted and reused (below). One owner-keyed table for every Discord
  object the bot owns, for journeys and tickets alike, is **the next step**, not this one.

## What is shared, and what is not

| Shared | From | Used by |
|---|---|---|
| Discord error classification: definitely gone (10003…), permission problem | Private copies in `applyUnpublishPlan.ts` | Unpublish, ticket category lookup |
| `lookupBoundChannel(guild, kind, id)` → found / gone; anything else throws | New, in provisioning | Ticket category resolution; the obvious seam for the next step |
| `existsInGuildAs` | `installPlan.ts`, now exported from the barrel | Ticket config save (an adopted id must be a category here) |
| Picker option building | `web/src/flows/resourceAdoption.ts` | The ticket settings slot control |

**Not shared, on purpose:** the permission vocabulary. Provisioning's `readWrite` grants
View/Send/Threads/React; ticket moderation roles get View/Send/ReadHistory/ManageMessages
on a category. Widening the vocabulary for this would change what every journey's
existing intents mean. Tickets keep their own overwrite list.

### Why the shared table is next, not never

`boundInGuild` — the fence that stops a journey's interrupted-create recovery from claiming
an object someone else owns — reads `resource_bindings` only. A ticket category bound in
the ticket config is invisible to it. So a journey holding a stale intent for a category
of the same name, created within the ten-minute window, could take a ticket category back
as `created`, and that journey's uninstall would later delete it. Narrow, but real, and
it is what one owner-keyed table closes.

## Behaviour

### Saving the slots from the dashboard (`PUT /config/tickets`)

The route now changes the guild, so it is ordered like an install:

1. Validate everything first: roles exist; every picked id is a category in this guild
   and the bot has Manage Channels + View Channel on it (checked for slots that change).
2. Create the categories typed as names, one at a time, with the ticket overwrites in the
   same `channels.create` call. Two slots given the same new name share one category,
   which is what name-matching did for an operator who typed the same name twice.
3. Write the config once, through `mutateConfig`, with every binding that now exists.
4. **A failed create keeps what was made.** The slots that succeeded are saved, the one
   that failed keeps its previous value, and the response names it (the same rule as a
   partial install).
5. Refresh the deployed panel, without failing the save if that refresh fails. The
   route never did this; once the dashboard is the only place categories are chosen,
   the panel's Create button would otherwise stay disabled after setup.

Saving the same slot again keeps its binding as it was: re-sending the bound id does not
turn `created` into `adopted`. A second save of one guild's ticket config while the first
is still creating is refused, not queued.

**Degraded path, stated rather than built around:** a crash between creating a category
and recording it leaves the slot as it was and a same-named category in the guild. The
slot control lists that category, so the next visit adopts it. No intent row for tickets
in this step; the shared table brings one.

### Resolving a slot when a ticket moves

`resolveTicketCategory(guild, config, slot)`:

- Cache hit, or a fetch that finds it → that category.
- A fetch that fails with **Discord's `Unknown Channel` (10003), and only that** → the
  category is gone: recreate it with the expected name and the ticket overwrites, save
  the new id as `created` (compare-and-set on the old id, so a dashboard re-pick in
  between is not overwritten), and log it.
- Any other failure (timeout, 5xx, missing access) → the ticket operation fails and says
  so. Recreating on a transient error would mint the duplicate #22 is about.
- **Concurrent recreates coalesce** on `(guildId, deleted id)`: two tickets opening right
  after a deletion make one category, and slots sharing one category are all repointed.
  This holds only within a single process, like the journey lock.
- **Before recreating, the stored slot is re-read** (added after review, 2026-10-01). A
  ticket open reads the config, then fetches members and writes rows before it reaches
  the category, so another ticket may already have replaced it; coalescing only covers
  recreates that overlap in time. If the stored slot now names another category, that one
  is used. If a re-pick still lands between the re-read and the save, the category just
  made is deleted again rather than left as an orphan.
- **Accepted:** a recreate whose answer never arrives (a timeout after Discord made it)
  leaves the slot unchanged, so the next ticket makes another. The stray carries the
  expected name; an intent row would close it, and the shared binding table brings one.

### Writers of the config blob

The Discord modal and `/deploy-ticket-system` used to read, spread and write back outside
a transaction, across Discord calls in deploy's case. Either could restore category
bindings that a dashboard save or a recreate wrote in between. Both now write through
`mutateConfig`, spreading the row as it is at write time. The settings page sends `null`
for every slot the operator did not change, so a stale tab editing only roles cannot
overwrite a newer pick.

### Discord surfaces

- The config modal keeps moderation roles only, and says categories are chosen in the
  dashboard.
- The panel embed shows each category as a mention, or "not linked yet — choose it in the
  dashboard".
- `/deploy-ticket-system`'s next steps, `resolveTicketAction`'s refusal and the
  dashboard's "not set up" alert stop saying the bot creates categories from names.

## Slices

| # | Change | Proof |
|---|---|---|
| **A** | Slot union in `ticketingSchema.ts`; migration carrying names into unbound slots (explicit JSON paths in both dialects, idempotent, `down` restores the names); provisioning's shared error classification + `lookupBoundChannel`; `resolveTicketCategory` with the 10003 rule and coalescing; `ticketChannelOps` routes by slot; `findCategory` and `findOrCreateModeratorCategory` deleted | Migration test on sqlite (named → unbound, empty → null, re-run is a no-op, down round-trips). TestDiscord: a renamed category still receives tickets; a deleted one is recreated once under two concurrent opens; a non-10003 failure creates nothing. Sabotage the 10003 gate and the coalescing |
| **B** | `PUT /config/tickets` takes `{ discordId } \| { name }` per slot, with create, adopt, keep, partial save, the busy refusal and the panel refresh; the view gives per slot `{ name, discordId, provenance, liveName }`; the browser types are mirrored and the drift keys updated; the settings page gets a slot control (existing categories plus "create …") | Route tests: adopt, create, keep-preserves-provenance, partial failure saves the rest, a non-category id refused. Sabotage the partial save |
| **C** | Modal loses the category fields; embed, deploy, refusal and alert copy | Modal test: a save writes roles and leaves `categories` alone |
| **D** | Fixtures (unit tests, e2e `ticketActions`, preview seed); PRD §5.7 and build-order rows; this plan's status; the 5B.3 plan's #22 section points here; `Fixes #22` | Full suite at baseline |

One reviewer pass after A–C: this is a migration, a contract change, and a race.
