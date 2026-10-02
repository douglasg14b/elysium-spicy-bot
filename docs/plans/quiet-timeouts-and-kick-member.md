# Quiet timeouts, Kick Member, and Member Left

> **Status**: Built 2026-10-01; postgres gate passed; not yet run against a real guild
> **Owner**: Douglas
> **Predecessor**: [activity-events.md](activity-events.md) — the record this step reads
> **Example, not scope**: "kick a member who sits in a ticket without posting" is the scenario
> used to find which capabilities are missing. Nothing here is a verification system, and
> nothing is named after one: these are general blocks, and that scenario is one flow an
> operator could build from them.

## What an author gets

1. **"Count the time limit from"** on the three blocks that wait on a clock — Prompt, Wait for
   Event and Delay:
   - *When it started waiting* — today's behaviour, and the default
   - *The member's last message* — the run's member
   - *Anyone's last message*
2. **"Messages in"** beside it — a channel, which may be `{{var.ticketChannelId}}`. Empty means
   anywhere in the server. Replies in a thread count toward the thread's parent channel.
3. **Kick Member** — kicks the run's member, with an optional reason that lands in the
   server's audit log.
4. **Member Left** — a trigger that starts a run when someone leaves the server, however
   they left. *(Built with the palette label "Member Leaves", to read alongside "Member
   Joins"; the type is `trigger.memberLeave`.)*

The example scenario, end to end — two flows:

```
Open Ticket → Prompt (staff: Approve / Deny)
                Give up after 7 days, counted from the member's last message
                in {{var.ticketChannelId}}
              └─ Timed out → Has Open Ticket? → Send DM → Close Ticket → Kick Member

Member Left → Has Open Ticket? → Close Ticket
```

The second flow covers the member who leaves before the time limit runs out, which the first
cannot (see "A run cannot outlive its member" below).

The same option on Delay *is* "wait until it goes quiet", so there is no separate block for it.

## Decisions (2026-10-01)

- Only **messages** reset the clock, including replies in threads under the channel.
  Reactions do not.
- The author chooses **whose** messages: the run's member, or anyone.
- Kick Member on a member who has **already left carries on**, so the rest of the flow (closing
  the ticket) still runs.
- Kick Member takes an optional **reason**.

## How the deadline moves — the scheduler, not the block

A quiet park is an ordinary timed park whose `wakeAt` the scheduler may push back.

When `runFlowRunTick` finds a due run carrying a quiet window, it looks up the latest
qualifying message. If `lastMessageAt + durationMs` is still in the future, it moves `wakeAt`
there and does **not** wake the run. Otherwise it resumes with `RESUME_TIMEOUT` exactly as
today.

Why not let the block wake, check and park again:

- **Prompt would re-post its buttons** on every re-park, because posting is what its suspend
  leg does.
- **Every wake costs a visit.** A member who posts just inside each window would spend the
  100-visit budget — a one-hour window runs out in about four days — and the run would fail.
- **The blocks stay unaware.** They see `timeout` only when it is genuinely quiet, so the
  executor still names no block and conformance needs nothing new.

The deadline needs no stored "parked at": the first `wakeAt` *is* park time plus the window,
so the effective deadline is `max(original wakeAt, lastMessageAt + window)`. A message before
the park can never move it earlier.

**Pushing back is a conditional update, never a claim.** `flowRunsRepo.deferWake(runId,
readWakeAt, nextWakeAt)` updates only while the row is still `suspended` with the
`wakeAt` the tick read. A button press that claimed the run in between wins, and the deferral
quietly does nothing. A deferral also costs no visit and writes no log line.

*As built:* losing that race also skips the resume on that tick — whatever moved the run
owns it, and timing out a park nobody asked to end would be worse. A lookup that throws
leaves the run parked for the next tick rather than timing it out on a guess.

**That equality is the whole race guard, so it must round-trip exactly.** `findDue` reads
`wakeAt` as a `Date` and the update writes it back with `toISOString()`. Text-to-text on
SQLite; on postgres it holds only if `timestamptz` hands back the same milliseconds it was
given. If it did not, every deferral would silently miss and quiet timeouts would behave as
plain ones with a green suite — so the postgres live run parks a quiet run, posts, ticks, and
asserts `wake_at` **moved**. *(As built, because a lost race skips the resume, a missing
equality would instead leave the run due and re-checked every tick — polling rather than
sleeping, and holding a slot at the head of the due batch — still timing out at the right
moment. The live run is justified either way.)*

## The data

**`flow_runs.quiet_window`** — a nullable JSON column carrying
`{ durationMs, who: 'member' | 'anyone', channelId?: string }` (typed `FlowQuietWindow`, a union
on `who` in which `anyone` requires `channelId`, so "anyone, anywhere" cannot be stored and is
refused on read). Null on every existing row and
every non-quiet park. It joins `flow_runs` in `SqliteJsonPlugin` in `database.ts`, or it comes
back a string on SQLite and an object on postgres. It is a field on `FlowStepSuspension`, so a block asks for it the same
way it asks for `wakeAt`. It is not folded into `waitConfig`, which describes an *event* wait
and which Delay never sets. *As built:* Wait for Event now builds `waitConfig` as
`{ eventKind, timeoutMs }` rather than handing over its whole config, so the two new keys do
not leak into it.

**`activity_events.parent_channel_id`** — a nullable column holding the parent channel when an
event lands in a thread. Recorded for reactions too although they never reset the clock, so the
column is never "null only sometimes". "Messages in #ticket" matches `channel_id = X OR
parent_channel_id = X` — written as two indexed lookups, each `LIMIT 1`, taking the later, so
neither dialect has to plan an `OR` across two indexes. Recorded for new events only; nothing
to backfill, because no earlier row carries a channel at all.

~~One migration~~ **Two migrations, as built**, both sorting after
`2026-10-01-Create_Activity_Events` (Kysely refuses out-of-order migrations):
`2026-10-01-Quiet_Timeouts.ts` adds `flow_runs.quiet_window`, and
`2026-10-01-Record_Activity_Thread_Parents.ts` adds `activity_events.parent_channel_id` and an
index on `(guild_id, parent_channel_id, occurred_at)` (its SQLite arm in its own
transaction). Split because the flow-runs test database applies its migrations one by one
and has no `activity_events` table — one combined migration would have forced either a
hand-copied column there or a conditional DDL arm. The existing
`(guild_id, channel_id, occurred_at)` and `(guild_id, user_id, occurred_at)` indexes cover the
rest.

## The lookup

`findLastMessageAt({ guildId, userId?, channelId? })` in `features-system/activity`, returning
`Date | null`. Messages only. A user, a channel, or both — but never neither: "anyone,
anywhere" is never quiet in a live server, so the schema refuses it before it can be saved.

*As built:* a method on `activityEventsRepo` (exported from the activity barrel); its input
type is a union that cannot be written without a user or a channel, and it throws if handed
empty strings for both. The recorder takes a reaction's thread parent from the guild's
channel cache, never a fetch, so a reaction in a thread the bot has never seen records a null
parent — harmless, since reactions never count.

## The fields, shared by three blocks

A shared fragment at `blocks/quietTimeout.ts` (the blocks root, beside `manifest.ts`; it is not
a block directory) supplies the two config fields, their Zod shape and a
`toQuietWindow(config, durationMs)` helper. That way the three blocks cannot word or validate
the option three different ways.

- `timeoutCountsFrom`: `select`, `'waitStart' | 'memberMessage' | 'anyMessage'`, default
  `'waitStart'` in both schema and `defaultValue`. A saved graph without the key parses as
  today's behaviour.
- `quietChannelId`: `channelPicker`, optional, may hold one `{{var.<name>}}`. The executor
  resolves the token before `run`, so the block receives a plain id. *As built:* no channel
  picker had been optional before, and the builder's picker could not be cleared at all — a
  pick, once made, was permanent. So the `channelPicker` arm gained an `optional` member (the
  same meaning as on `text` and `duration`; browser mirror and drift fixture updated), the
  picker turns `clearable` for it, and clearing removes the key. The schema is
  `z.string().optional()`, so absent and `''` both read as anywhere.
- *As built, a park-time refusal:* `toQuietWindow` takes the guild and throws when "Messages
  in" names a channel the bot cannot view — it would never record a message there, so the
  deadline could never move and the run would time out on people who are talking. Ask a
  Question computes the window before posting, so a refusal leaves no orphaned buttons.
  Access revoked mid-park is not caught.
- Schema refinements, each with an author-readable message:
  - `anyMessage` without a channel is refused.
  - On Prompt and Wait for Event, a non-default `timeoutCountsFrom` without `timeoutMs` is
    refused — there is no time limit for it to count.

The inspector has no conditional fields, so both fields always show. The channel field's
description says it only matters for the two message options. A "show when" vocabulary member
would be a contract change across every block, and two fields do not justify it.

## Kick Member

`action.kickMember`, in its own directory under the one-directory rule.

- Config: `reason`, `text`, optional, `rendersTokens`, max 512 characters (Discord's audit-log
  limit). *As built:* the schema caps the typed template at 512, but the field declares no
  `maxLength`, because the executor fails a node whose copy *renders* past it — a long display
  name in a token would have stopped the kick. The rendered reason is trimmed to 512 code
  points in `run` instead.
- Kicks `context.subject`. Requires `subject`.
- **Already gone carries on.** The member is re-fetched immediately before the kick, and an
  unknown member counts as success. *As built:* the fetch is `force: true` (the cache can
  still hold a leaver), and an Unknown Member answer to the kick itself also carries on.
- **Refused kicks fail by name.** If `member.kickable` is false, the run fails saying why: the
  member is the owner, or ranks at or above the bot's highest role. *As built:* also the bot
  lacking Kick Members, and the member being the bot itself — the other two things
  `kickable` checks.
- New capability `kickMembers`, which goes in `BLOCK_CAPABILITIES` and its browser mirror
  (`web/src/api/types.ts`; `nodeDescriptorDrift.test.ts` gates it).
- The block's `note` says to send any DM before the kick: once the member shares no server
  with the bot, a DM fails.

## Member Left

`trigger.memberLeave`, mirroring `trigger.memberJoin` and `engine/memberJoinDispatch.ts`.

- New trigger source `memberLeave` in `BLOCK_TRIGGER_SOURCES` and its browser mirror.
- `GuildMemberRemove` → run every `memberLeave` trigger in every enabled flow in the guild,
  errors isolated per trigger, exactly as joins do.
- **Establishes `subject` only.** No `actor` — a member who was kicked or banned did not cause
  their own leaving, and the event cannot say which happened. No `channel`.
- **Needs `Partials.GuildMember`.** Without it discord.js drops `GuildMemberRemove` for any
  member not in the cache, which on a large server is most of them. Adding it changes what
  other member-bearing events may hand their listeners, so every listener that receives a
  `GuildMember` is checked before the partial is turned on.
- The subject is a departed member: blocks that read the member's state or act on them (roles,
  DM, kick) fail loudly, and blocks that only need the id (Has Open Ticket?, Close Ticket)
  work. The trigger's `note` says so.

  *Corrected as built:* only blocks that **act** on the member fail (Assign/Remove Role and
  Send DM fail at Discord; Kick Member carries on, by its own rule). Blocks that **read** their
  state do not fail: Has Role and Is Booster answer from whatever discord.js last knew — stale
  but populated for a member who was cached, empty for an uncached (partial) one. The note says
  that. Making those conditions fail on a departed subject is a separate change.

  *Contract change, as built:* `FlowRunSeed.subject` is now `GuildMember | PartialGuildMember`,
  because `GuildMemberRemove` hands an uncached leaver over as a partial. The partial nulls only
  `joinedAt`, `joinedTimestamp` and `pending`, which nothing reads, so every block compiled
  unchanged; `ticketIdentityFromMember` was narrowed to the two members it reads. This is not
  the "subject may be absent on resume" change ruled out below — the subject is present, just
  departed.

## A run cannot outlive its member

**A run woken after its member left ends at resume.** `rebuildResumeContext` needs the member,
so the run fails before reaching anything after the wait. That includes a Member Left run that
parks. "Already gone carries on" in Kick Member covers only a member who leaves in the seconds
between the wake and the kick.

Member Left is how a flow reacts to a departure. A subject that may be absent on resume is a
contract change across every block and is not this step's.

## Tests (90%, not 100%)

- **Scheduler defers on recent activity** — a due quiet run with a newer qualifying message has
  its `wakeAt` moved and is not resumed. Sabotage: skip the check, watch it resume.
- **Scheduler resumes when quiet** — no qualifying message, or one older than the window.
- **Deferral loses to a claim** — a run claimed between read and defer is untouched.
- **Thread replies count toward the parent**, and **reactions do not count**.
- **Member vs anyone** — another member's message defers an `anyMessage` window and not a
  `memberMessage` one.
- **Schema refusals** — `anyMessage` with no channel; a non-default mode with no time limit.
- **Kick Member** — kicks with the reason; carries on when the member is gone; fails by name
  when not kickable.
- **Member Left** — a departure runs every `memberLeave` trigger in enabled flows, including
  for a member who was not cached. Through the TestDiscord harness if it can dispatch
  `GUILD_MEMBER_REMOVE`; extend it rather than hand-building a member.
- Conformance covers both new fields on all three blocks, and the new block, without new code.
  *As built, one line:* the suspending-block probe now parses its config through the block's
  schema before calling `run`, as the executor always does — the raw probe lacked the
  defaulted `timeoutCountsFrom`.

*Where they live:* `flows/__tests__/quietTimeouts.test.ts` (scheduler, `deferWake`, the stored
window, schema refusals — real migrated SQLite, only the resume stubbed),
`features-system/activity/__tests__/findLastMessageAt.test.ts` and the recorder suite (threads,
reactions), `flows/__tests__/kickMember.test.ts` (hand-built members: the harness's role
positions are made up, so it cannot answer `kickable`), and
`flows/__tests__/memberLeaveDispatch.test.ts` — through TestDiscord driving the real
`DISCORD_CLIENT`, which gained `GUILD_MEMBER_REMOVE` for it. Sabotage-verified: skipping the
deferral, dropping either half of the `deferWake` guard, dropping the parent lookup or the
recorder's parent, dropping the executor's `quietWindow` on a new run's row, and removing
`Partials.GuildMember` each fail a named test.

## Not verified by this step

- **The postgres arm**, again a merge gate: run the migration live against a scratch
  `postgres:16`. **Passed 2026-10-01.** Both migrations went up, down and up again (columns,
  the parent index, and `quiet_window` as `jsonb` all confirmed each way). A quiet run parked
  with a millisecond-bearing `wakeAt` came back from `create` and `findDue` with its window as
  an object and the same milliseconds; `deferWake` with a read 1 ms off matched nothing; and a
  real `runFlowRunTick`, after a thread reply recorded under the window's channel, **moved**
  `wake_at` from the parked value to exactly that reply plus the window, leaving the run
  `suspended` with no visit spent. Not repeated in CI — a later edit to either arm needs the
  run again.
- **A real guild.** The scheduler's deferral is the part a live run should watch: park a run
  with a short window, post, and see it stay parked.

## Open after review (owner's call)

- *Resolved 2026-10-02 by [activity-backfill.md](activity-backfill.md):* activity now records
  its own uptime and backfills missed messages from Discord history on startup, and the
  scheduler holds quiet-window runs until that finishes. The original finding is kept below.
- **The record is blind while the bot is down, and a quiet window reads blindness as quiet.**
  Discord replays nothing after a restart, so a member who keeps posting through an outage that
  spans their deadline looks silent: the startup sweep finds no recent message and times the
  run out. Options weighed by the reviewer, none taken: count from process start as a floor
  (costs one extra window after every deploy — steep for 7-day windows); REST-fetch a channel
  window's latest message on the first tick (exact for channels, misses threads and
  "member, anywhere"); or persist a recorder heartbeat and defer only when the blind interval
  overlaps the window.
- **A member-plus-channel lookup walks the channel's history** on SQLite's single connection
  when the member never posted there — the existing `(guild_id, channel_id, occurred_at)` index
  seeks the channel and filters the user row by row. Once per due run, so bounded, but busy
  channels make it slow. `(guild_id, channel_id, user_id, occurred_at)` and the parent
  equivalent would make it a seek, at the cost of two more indexes maintained on every recorded
  event. The plan decided the existing indexes suffice; left as decided.
- **Webhook and proxied messages never reset the clock** — the recorder has always skipped
  them (it was written for XP), so members posting through a proxy bot look silent.
- **A `{{var.x}}` left in "Messages in" after switching back to "When it started waiting"**
  is still resolved before `run`, so a path where that variable is unrecorded fails the node
  over a field that has no effect. The picker is now clearable, so it is fixable by hand; a
  save-time refusal or skipping resolution in that mode would close it.
- **The card does not show a non-default "count from".** `cardSummary` has no way to hide a
  part at its default value, only when empty.
