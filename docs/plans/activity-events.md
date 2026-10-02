# Activity events — a shared record of who was active where

> **Status**: Built 2026-10-01; migration passed a live postgres run the same day; not yet run against a real guild
> **Owner**: Douglas
> **Drives**: an auto-kick for members who sit in verification with no updates. That use case
> motivated this but does not define it — the record is generic, and tickets and flows both read it.

## Why

A flow that says "if this member has not posted in their ticket for 7 days, close it and kick
them" needs to know **when a member last posted in a given channel**. Nothing answers that today.

`leveling_activity_events` comes closest — it gets a row for every eligible message, even ones
the XP cooldown blocks — but it is the wrong owner for three reasons:

1. **It records nothing when leveling is off.** A guild without leveling would see every member
   as silent, and a quiet-timeout would kick a talkative one.
2. **An XP rule would silently become a kick rule.** "No XP in ticket channels", implemented by
   skipping the row, would break inactivity detection with no failing test.
3. **It is an XP ledger shaped like an activity log.** Flow XP grants and voice-session grants
   land in it, and `messageLength`, `photoBonus` and the five voice columns are XP inputs.

So activity becomes a `features-system` capability with its **own listener**, and leveling's
table becomes what it really is: the XP ledger.

## This step, and the steps after it

1. **This step** — the `activity_events` table, its recorder, and leveling consuming it.
   Worth shipping on its own: history with channel ids starts accruing from the day it lands.
2. **Next** — `findLastActivityAt`, a "count from last activity" option on the timeouts of
   Prompt, Wait for Event and Delay, and a Kick Member block. The lookup lands with its first
   caller rather than here, so nothing ships with zero callers.
3. **Later, if needed** — a "last activity" column on the tickets dashboard; a "member went
   quiet" trigger for tickets no run is holding.

## The model

| Table | Owner | Holds |
|---|---|---|
| `activity_events` (new) | `features-system/activity` | `id`, `guildId`, `userId`, `channelId` (nullable), `kind` (`message` \| `reaction`), `occurredAt` |
| `leveling_xp_grants` (renamed from `leveling_activity_events`) | leveling | every existing column, plus a nullable `activityEventId` |

**Nothing is dropped from the ledger.** Voice and flow grants have no activity event, so for
them `guildId`, `userId`, `occurredAt` and `activityType` exist nowhere else. Leveling's
readers also stay on the one table on purpose — the insights scan reads three columns from one
table so SQLite's single synchronous connection is not held through a join.

**Leveling's readers do not change.** Daily buckets, totals, the stats card and guild insights
all keep reading the ledger, so they keep meaning "activity while leveling was on". That
removes any chart-parity risk from this step.

**`activityEventId` is a plain nullable column, not a foreign key** (decided 2026-10-01). No
table in this repository declares one, and nothing deletes activity events yet. A foreign key
only pays once something does — and that is also when its cost appears: `ON DELETE SET NULL`
needs an index on `activity_event_id`, or every pruning batch scans the whole ledger. So the
constraint and its index are decided **with retention**, where both costs are visible; on
postgres adding it then is one statement. Until then, any deleter nulls the link itself —
removing activity history must never cost anyone their XP.

**`activity_events.id` is `serial` on postgres, not `bigserial`.** `pg` returns `int8` as a
string, so a `bigserial` id typed `number` would be an assertion, not a type. Two billion
events is not a horizon this bot reaches.

## What is recorded

A message or reaction is recorded when it is in a guild, not a system message, and not
authored by a bot (webhooks included). **The `/`-prefix rule stays leveling's**: a member
typing `/something` was active in that channel, but earns no XP for it. That divergence is
the first proof the two filters are now independent.

For a reaction, `channelId` is the channel of the message reacted to, and the member is the
reactor.

## Wiring

- `features-system/activity/initActivityTracking.ts` attaches `MessageCreate` and
  `MessageReactionAdd` and does nothing else; the handlers are in `activityRecorder.ts`, split
  out so tests can call them without `DISCORD_CLIENT`. A handler records the event, then
  notifies the registered subscriber with a discriminated union: `{ kind: 'message', message, … }`
  or `{ kind: 'reaction', … }`, both carrying `activityEventId`, `guild`, `userId`, `channelId`.
- **Leveling's message filter is now only the `/` rule.** Guild, system, bot and webhook are
  the recorder's guarantees, documented on `ActivityEventBase`; leveling no longer re-checks them.
- **Reactions are no longer fetched.** `guildId` and `channelId` come from the gateway payload
  (`Action.getMessage` builds the partial with both) and the guild from the cache. So a reaction
  on a message the bot cannot fetch — deleted, or no Read Message History — is now recorded
  **and earns reaction XP**, where the old leveling listener dropped it. One REST call per
  partial reaction is gone.
- Leveling registers itself at init, the same single-registration shape as
  `levelUpSubscribers.ts` — activity never imports leveling. Leveling drops its own
  `MessageCreate`/`MessageReactionAdd` listeners; its voice listener is unchanged.
- **A failed activity write logs and does not notify.** It only happens when the database is
  failing, and then leveling's own write fails too; keeping a null arm in the subscriber
  contract for that case would cost a branch in every fixture and buy nothing.
- A subscriber failure is logged and never unwinds the recorded event.
- `occurredAt` is `message.createdAt` for messages, so processing delay does not shift it.
  A reaction carries no timestamp, so it is the time it was received.

## The migration

One migration, `2026-10-01-Create_Activity_Events.ts` (sorts after `2026-10-01-Bind_…`), per dialect:

1. `ALTER TABLE leveling_activity_events RENAME TO leveling_xp_grants` — instant, no copy.
2. Add `activity_event_id` (nullable integer) to `leveling_xp_grants`.
3. Create `activity_events`.
4. One set-based `INSERT INTO activity_events (id, guild_id, user_id, channel_id, kind,
   occurred_at) SELECT id, guild_id, user_id, NULL, activity_type, occurred_at FROM
   leveling_xp_grants WHERE activity_type IN ('message', 'reaction')`. Ids are kept, so…
5. …one `UPDATE leveling_xp_grants SET activity_event_id = id WHERE activity_type IN
   ('message', 'reaction')` links them.
6. Create the indexes **after** the insert: `(guild_id, user_id, occurred_at)` and
   `(guild_id, channel_id, occurred_at)`.
7. **Postgres only**: `setval` the `activity_events` id sequence past the copied maximum, or
   the first new insert collides. SQLite's `AUTOINCREMENT` advances `sqlite_sequence` on an
   explicit-id insert by itself.

**Atomicity.** Kysely wraps a migration in a transaction on postgres only
(`SqliteAdapter.supportsTransactionalDdl` is `false`). The SQLite arm therefore opens its own
transaction on the connection the migrator already holds, so a failure leaves the database as
it was rather than half-renamed. The migrator hands a migration a **connection-bound**
instance, not the plain client the existing migration test uses, so this is verified once
through a real `Migrator` against a scratch SQLite file — raw `BEGIN`/`COMMIT`/`ROLLBACK` if
`db.transaction()` misbehaves on the bound instance.

**Concurrency is not a concern.** `dockerEntrypoint.sh` and `pnpm dev` both migrate before the
bot logs in, so nothing writes during the migration. Messages sent while the bot is down are
never delivered to it — true of every restart today. (Since [activity-backfill.md](activity-backfill.md),
activity recovers them from Discord's history after startup; none of that runs during a migration.)

**Index names on the renamed table keep their `leveling_activity_events_*` names.** SQLite
cannot rename an index, and dropping and rebuilding them on the largest table in the database
to fix a name is not worth it. A comment in the migration says so.

`down` reverses it: drop `activity_events`, drop `activity_event_id`, rename back.

## Code changes

- `features-system/activity/`: `data/activityEventsSchema.ts`, `data/activityEventsRepo.ts`,
  `activitySubscribers.ts`, `activityRecorder.ts`, `initActivityTracking.ts`, `index.ts`.
- `database.ts`: register `activity_events`; rename `leveling_activity_events` →
  `leveling_xp_grants` in the interface and both date/binding plugins.
- Leveling: `levelingActivityEvent*` → `levelingXpGrant*` (schema, repo, types); `grantXp`
  accepts and writes `activityEventId`; `LevelingService` takes the subscriber events instead
  of raw Discord ones; the partial reaction and message fetches are dropped (see Wiring).
- `bot.ts`: call `initActivityTracking()`.
- `leveling/readme.md` and `AGENTS.md` layout: name the new capability.

## Tests (90%, not 100%)

- **Migration, both directions, on SQLite** — seed message, reaction, voice and flow rows;
  assert activity rows carry the same ids with null channels, only message/reaction grants
  are linked, the next insert's id does not collide, and `down` restores the original table.
- **The decoupling guarantee** — a message is recorded with its channel in a guild whose
  leveling is **disabled**. Sabotage-verify: route the write back through the leveling gate
  and watch it fail.
- **Divergent filters** — a `/`-prefixed message is recorded as activity and grants no XP.
- **The link** — a message grant carries the activity event's id.
- Existing leveling suites updated for the rename; no new assertions about types passing
  arguments.

## Not verified by this step

- **The postgres arm — a merge gate, because production runs postgres. Passed 2026-10-01.**
  CI runs SQLite only, so it was run live against a scratch `postgres:16`: seeded with mixed
  kinds and an id gap, then `up`, `down`, `up`. Ids were preserved (1, 5, 6), only message and
  reaction grants were linked, the sequence stood at max+1 uncalled, the next live insert got
  that id back as a `number`, the renamed ledger's own sequence kept allocating, and `down`
  restored a working table. Not repeated in CI — a later edit to the arm needs the run again.
- **Threads, for step 2.** A reply in a thread records the *thread's* id as `channelId`, not
  the parent's. "Last post in `{{var.ticketChannelId}}`" would miss thread replies; step 2
  decides whether that matters. *Resolved in [quiet-timeouts-and-kick-member.md](quiet-timeouts-and-kick-member.md):
  it does — `activity_events.parent_channel_id` now records the parent, and a channel lookup
  matches either column.*
- **Retention.** Every message in every guild is now recorded, forever (ids and timestamps,
  no content). Recorded as an open item beside the PRD's stale-run hygiene, not solved here.
