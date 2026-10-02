# Activity backfill — close the outage blind spot

> **PRD**: [flow-time-and-message-primitives.md](../prds/flow-time-and-message-primitives.md) §4 ("Outage blindness") and §8 sequencing step 1
> **Status**: Built 2026-10-02 (uncommitted); postgres migration gate passed
> **Builds on**: [activity-events.md](activity-events.md), [quiet-timeouts-and-kick-member.md](quiet-timeouts-and-kick-member.md) (both uncommitted)

## Problem

Discord replays nothing after a restart. A message sent while the bot was down never reaches
`activity_events`, so a member who kept posting through an outage looks silent. After the
restart, the scheduler's first sweep times out their quiet-window run. Time Since (step A) and
the message wait (step B) would inherit the same blind spot.

A grace period doesn't fix this; the messages are still missing. **We fix it at the source:
on startup, activity fetches the messages it missed from Discord's history and records them.**

## Decisions (Douglas, 2026-10-02)

- **Backfill from Discord history.** We are not assuming activity at restart, because every
  deploy would push every quiet clock back by a full window.
- **Record only.** Recovered messages go into `activity_events` and nowhere else. No
  subscriber is notified, so no XP, and in step B no Message Sent trigger fires on an old post.
- **Recovery must not become more downtime.** A day-long outage can mean thousands of messages
  in one channel, and pagination is 100 per request. So backfill runs **in the background**:
  - Live recording starts immediately, as it does today.
  - Requests go out one at a time and never compete with live interactions for the rate limit.
  - Only the runs that depend on the missing data wait for it.

## Design

### 1. Knowing where the gap is — `activity_recorder_sessions`

New table, owned by `features-system/activity`:

| column | type | meaning |
|---|---|---|
| `id` | serial / integer | |
| `started_at` | timestamp | when this process began recording (at `ClientReady`) |
| `last_seen_at` | timestamp | refreshed every 60s while the process is alive |
| `gap_filled_at` | timestamp, nullable | when the gap **before** this session was backfilled; null means not yet |

- The gap before session N runs from session N−1's `last_seen_at`, minus a 2-minute margin
  that covers the heartbeat interval, to session N's `started_at`.
- **Crash-safe:** a gap stays unfilled until its backfill finishes. If the process dies
  mid-backfill, the next start fills that gap and its own, oldest first.
- **First session ever:** there's no predecessor, so it is marked filled when inserted. There
  is no baseline to backfill from, and we won't guess one.
- **Lookback cap: 30 days** (`FLOW_MAX_DELAY_MS`, the longest any quiet window can be). Missed
  messages older than that can't move a deadline that is still in the future. The gap's start
  is clipped to `now − 30 days`.

### 2. Making a backfill safe to repeat — `activity_events.message_id`

- Add a nullable `message_id` column with a **unique index**. Postgres and SQLite both allow
  many NULLs, so reaction rows and migrated rows are unaffected.
- Both paths write it: the live recorder (messages) and the backfill.
- Backfill inserts use `ON CONFLICT (message_id) DO NOTHING`. Overlap at either end of a gap
  is harmless, and so is re-running a gap after a crash.
- The live recorder also inserts with `DO NOTHING`. If a backfill got there first (a race of
  seconds around startup), `record` returns null and no subscriber is notified, since the
  message is already recorded. That can cost one message's XP during the race, which is
  acceptable.

### 3. One eligibility rule

Extract the live recorder's filter and input mapping into one function, e.g.
`toMessageActivity(message): RecordActivityEventInput | null`, that both paths call:

- the message is in a guild;
- it isn't a system message;
- it wasn't sent by a bot or a webhook;
- for a thread reply, the parent is recorded;
- it uses the message's own timestamp.

That way a backfilled row is indistinguishable from a live one.

### 4. Which channels to fetch (no guild walk)

For each guild in the cache:

- **Candidates:** every cached text-based channel, including voice-channel text and announcement
  channels, and every **active** thread.
- **Skip** any whose `lastMessageId` snowflake is older than the gap's start, or that has no
  last message at all. GUILD_CREATE supplies `last_message_id`. The implementer must verify in
  discord.js v14 that it is populated on cached channels and threads without a fetch.
- **Skip silently** where the bot lacks View Channel; the live recorder can't hear those
  either. *Corrected after review:* a channel the bot can view but whose history it may not
  read is **not** symmetric. Live messages still arrive there, but the backfill can't fetch
  them. It is skipped and **named in a warning** once per gap, so an operator can grant Read
  Message History. This is a known limitation, not parity.
- **Archived threads are out of scope.** A thread archived during the outage isn't in the
  active list. Document this.

For each remaining channel:

- Page forward with `messages.fetch({ after, limit: 100 })`, starting from a snowflake built
  from the gap's start.
- Stop at the first message at or after the gap's end, or at an empty page.
- Map each message through §3 and batch-insert.
- **Rate limits.**
  - One request in flight across the whole backfill.
  - discord.js's REST queue handles 429s and bucket waits.
  - At roughly 3–5 requests per second that is 300–500 messages a second, so 10,000 missed
    messages take about 30 seconds and leave the global limit for live traffic.
  - No per-channel page cap. The 30-day clip bounds the work, and because it runs in the
    background, a long backfill delays only the runs that need it.
- **Failure of one channel:** for example, deleted mid-fetch, permissions changed, or a
  non-429 API error. Log the failure with the channel id, skip the channel and carry on.
  Don't retry in a loop.
- **The gap is marked filled once every channel has been attempted.** A skipped channel is
  logged, not retried.

### 5. Holding the runs that depend on it

`features-system/activity` exposes an in-memory readiness state, `isBackfillPending(): boolean`.
It is true from `ClientReady` until every unfilled gap has been attempted. Activity still
imports no feature.

The scheduler's `deferIfMessaged` gains one rule: **a due run that has a quiet window is
skipped on this tick while a backfill is pending.** It isn't resumed, and its `wakeAt` isn't
touched, so the next tick looks again. Runs without a quiet window (plain delays, button
waits, waits with no quiet window) resume exactly as today.

*As built:* the hold lives in the due-run query rather than in `deferIfMessaged`:
`findDue(now, { withoutQuietWindows: isBackfillPending() })`. Skipping held runs after
fetching them let a full batch (`FLOW_RUN_POLL_BATCH_SIZE`, oldest first) of held runs starve
every plain delay queued behind it, which broke "resume exactly as today". The effect on held
runs is the same: not resumed, `wakeAt` untouched.

This ordering is the load-bearing part of the step. The scheduler's startup sweep runs
immediately at `ClientReady`. Without this rule it would time out quiet runs on the very data
the backfill is about to restore. **Write its test first** and sabotage-verify it.

### 6. Wiring

- `initActivityTracking()` still attaches the listeners at module load.
- A `ClientReady` hook in activity does the rest:
  1. insert the session and start the 60s heartbeat;
  2. find the unfilled gaps;
  3. run the backfill in the background, catching and logging any error;
  4. clear the pending flag when it finishes or fails.
- If finding the gaps fails (for example, the DB is down), clear the flag and log loudly. Quiet
  runs then behave as they do today rather than being held forever.
- The heartbeat is one tiny UPDATE a minute. Log its failures; never let one throw.

## Out of scope (stated, not forgotten)

- **A gateway session invalidated mid-process.** Events are lost without a restart, and a
  startup backfill doesn't cover that. discord.js's RESUME replays events, so this only
  happens when Discord refuses the resume. Those events are lost **for good**: the heartbeat
  kept advancing throughout, so no later gap covers them.
- **A Discord-wide REST failure during a backfill** fails every channel in turn, and the gap
  is still marked filled (§4). A database failure leaves the gap unfilled and retried; a
  Discord outage at startup does not. Revisit if it is ever seen in practice.
- Reactions are not backfilled. Discord has no history of when a reaction was added, and
  reactions never count toward quiet windows anyway.
- Archived threads (see §4).
- Prioritising the channels that parked runs watch. Activity would have to know about flows.
  Revisit if backfills turn out slow in practice.

## Tests (target ~90%, effort on behaviour)

- **Scheduler hold (first, sabotage-verified):** a due quiet-window run isn't resumed and its
  `wakeAt` is untouched while a backfill is pending. A due plain-delay run still resumes.
  Once the backfill clears, the quiet run is deferred or resumed as today.
- **Gap derivation:**
  - first session: nothing to fill;
  - normal restart: one gap with the margin;
  - crash mid-backfill: two unfilled gaps, filled oldest first;
  - the 30-day clip.
- **Channel selection:** skips by `lastMessageId`, skips without Read Message History,
  includes active threads.
- **Paging:** forward through several pages, stopping at the gap end; bot, webhook and system
  messages are filtered; thread parent recorded.
- **Idempotency:** re-running a gap inserts nothing new. A live insert that collides with a
  backfilled row returns null and notifies no subscriber.
- **Record only:** the subscriber is never called for backfilled rows.
- **One failing channel** is logged and skipped, and the gap is still marked filled.
- **TestDiscord:** extend the harness with `GET /channels/:id/messages` (`after`, `limit`).
  Don't hand-build channels.
- **Postgres gate:** live-run the migration on a throwaway `postgres:16`. Check that the
  unique index allows many NULLs and that `ON CONFLICT DO NOTHING` returns no row on a
  duplicate.

## Migration

`2026-10-02-Activity_Backfill.ts`:

- create `activity_recorder_sessions`;
- add `activity_events.message_id` (nullable) plus a unique index;
- each SQLite arm runs in its own `db.transaction()`, as the existing 2026-10-01 activity
  migrations do;
- no data copy.

## Docs to update

- `AGENTS.md` activity line: sessions, backfill, record only.
- PRD §4: outage blindness resolved, plus the out-of-scope list.
- `docs/plans/activity-events.md` only if it claims something this changes.
