# Flow primitives for time and messages

> **Status**: Approved 2026-10-02 — §8 answered; §5.1 and §5.2 built 2026-10-02, §5.3 and §5.4 built 2026-10-03 (none yet run on a real guild; TestDiscord end-to-end tests stand in) — see [message-sent-and-message-wait.md](../plans/message-sent-and-message-wait.md)
> **Owner**: Douglas
> **Parent**: [Flow Engine v2](flow-engine-v2-journeys-and-provisioning.md) — this extends its block contract; it does not replace any of it
> **Built so far**: [activity-events.md](../plans/activity-events.md), [quiet-timeouts-and-kick-member.md](../plans/quiet-timeouts-and-kick-member.md), [set-variable-and-time-since.md](../plans/set-variable-and-time-since.md)

## 1) Summary

Flows can wait, but they cannot reason about time, and they cannot react to someone talking.
This PRD adds the missing **primitives**: a way to start a run from a message, to wait for one,
to ask how long it has been since something, and to store a value — including a time — for
later blocks to read.

Each one is a general building block. The scenario that exposed the gaps is below, but it is
an example used to find them, not the thing being built.

## 2) Design principle — primitives, not use cases

This is the product's core rule, stated by the owner twice on 2026-10-01:

- **Build general primitives an operator composes**, never a block shaped for one scenario.
  A "record the time" block is too narrow; a **Set Variable** block that can hold a time is the
  primitive.
- **Name things after the capability.** Nothing is called "verification", "nudge", or after any
  one flow. Example scenarios live in docs, labelled as examples.
- **When a scenario hits a gap, ask what general capability closes it.** A departed member's
  open ticket was closed by a generic Member Leaves trigger, not by a cleanup feature.

## 3) The example that exposed the gaps

*Example, not scope.* An operator wants a member who goes quiet in their ticket to be reminded,
then removed if they stay quiet:

```
Open Ticket
 → Delay 2 days, counted from the member's last message in {{var.ticketChannelId}}
 → Time Since: member's last message in {{var.ticketChannelId}} is at least 2 days? ── No → (end)
 → Send Message in {{var.ticketChannelId}}: "Oi {{subject.mention}}, you've gone quiet…"
 → Wait for Event: a message from the member in {{var.ticketChannelId}}, give up after 3 days
     ├ It happened → back to the Delay
     └ Timed out  → Send DM → Close Ticket → Kick Member

Member Leaves → Has Open Ticket? → Close Ticket
```

Other flows the same primitives make possible (all examples):

- **Keyword reply** — Message Sent, containing "rules", anywhere → Send Message in that channel.
- **Seniority gate** — Button Click → Time Since the member joined is at least 7 days? → Assign
  Role, otherwise tell them to wait.
- **Follow-up after an action** — Set Variable `lastContactedAt` = now → … later … → Time Since
  `{{var.lastContactedAt}}` is at least 1 day?
- **Idle channel sweep, per message** — Message Sent in a category → Delay 1 day → Time Since
  anyone's last message in that channel is at least 1 day? → post a prompt.

## 4) What already exists (built 2026-10-01, uncommitted, not yet run on a real guild)

- **Activity record** — `activity_events` (`features-system/activity`): every eligible guild
  message and reaction, with channel and thread parent, recorded whatever features are
  enabled. Leveling's ledger is now `leveling_xp_grants` and gets its events from the activity
  feature. Lookup: `activityEventsRepo.findLastMessageAt({ guildId, userId?, channelId? })`.
- **Quiet timeouts** — Ask a Question, Wait for Event and Delay can count their time limit from
  the member's or anyone's last message, optionally in one channel (`{{var}}` allowed; threads
  count toward their parent). The scheduler pushes the deadline back instead of waking the run.
- **Kick Member** action (optional audit-log reason; already-gone carries on; refusals named).
- **Member Leaves** trigger (subject only; works for uncached members via `Partials.GuildMember`).
- **Builder fix** — the node inspector scrolls; tall blocks no longer crush their Delete button.
- Postgres migration gates passed for both migrations.

**Open from that work** (carried here so it is not lost):

- ~~**Outage blindness**~~ — **resolved 2026-10-02** by the startup backfill
  ([activity-backfill.md](../plans/activity-backfill.md)). Each process is a row in
  `activity_recorder_sessions`; on startup activity fetches the messages Discord's history holds
  for every gap since the last session (30-day cap, crash-safe, deduplicated on
  `activity_events.message_id`) and records them without notifying any subscriber. Due runs with
  a quiet window are held, not resumed, until it finishes. Still out of scope: a gateway session
  Discord refuses to resume mid-process (events lost without a restart), reactions (Discord keeps
  no history of when one was added), threads archived during the outage, and prioritising the
  channels parked runs watch.
- ~~"This member in this channel" lookups walk a busy channel's history on SQLite~~ —
  **resolved 2026-10-03** by `(guild_id, channel_id | parent_channel_id, user_id, occurred_at)`
  indexes.
- Webhook and proxied messages never count as activity.
- The block card cannot show a non-default "count from".
- ~~The activity subscriber is a **single slot**~~ — **resolved 2026-10-03**: a list, notified
  in parallel, each failure isolated (see §5.4).
- Commits must stage only this work's hunks: `manifest.ts`, `web/src/api/types.ts`,
  `executor.ts`, `PickerControls.tsx`, `FlowBuilderPage.tsx`, `NodeInspector.tsx` and the block
  contract also carry other sessions' uncommitted edits.

## 5) Requirements

### 5.1 Set Variable (action)

The general way to put a value in the run's variable bag.

- [x] **The author names the variable** (an `authored` output, like Pick Random's `outputKey`),
  read back as `{{var.<name>}}`.
- [x] **Value types**: text, number, true/false, and **time**.
  - text renders tokens, so a variable can be built from other variables and built-ins.
  - number and true/false are literals.
  - time is **now** (see §8 for whether an offset belongs here).
- [x] **A time is a real type to the builder, not just a string.** Its output declares a `time`
  value kind, so pickers and Time Since can offer time variables and only time variables.
  *Contract gap:* an output's `valueKind` is static in the manifest today, but Set Variable's
  depends on the type the author picked. The manifest needs a way to derive an output's kind
  from a config field. That is a contract change: manifest, conformance, browser mirror and
  `block-authoring.md` together. *(Closed by `valueKindFrom`.)*
- [x] Writing an existing variable overwrites it — the bag's existing last-writer-wins rule.
- [x] Never holds message content or other evidence; the bag stays scalar (contract rule).

### 5.2 Time Since (condition)

"Has at least / less than *duration* passed since *something*?" Answered instantly; never parks.

- [x] **Sources**, chosen per node:
  - the member's last message, optionally in one channel
  - anyone's last message in a channel
  - when the member joined the server
  - when this run started
  - a time recorded earlier — a saved time variable, picked by name
- [x] **Comparison**: *at least* or *less than*, against a duration.
- [x] Channel fields accept `{{var}}`; message sources count thread replies toward their parent,
  as quiet timeouts do.
- [x] Yes / No / **No record** handles (§8.3): no activity found, no join time, no start time on
  an older run, or an unset saved time.
- [x] **A recorded time that is not a time fails the run by name**, never answers a branch.
- [x] *Implementation note:* "when this run started" needs the start time on the run context
  and through a park; neither carries it today. *(Now `context.startedAt`, kept in the run's
  snapshot from the first park.)*
- [x] *Implementation note:* the member's join time can be null for a partial member (a Member
  Leaves run). *(Answers No record.)*

### 5.3 Message event on Wait for Event

- [x] New wait kind: **a message**, from **the run's member** (the existing rule for every wait
  kind), optionally in one channel (`{{var}}` allowed; thread replies count toward the parent).
- [x] Works with the existing time limit and its *Timed out* exit.
- [x] Waking on a message must not cost a database read per message for guilds with no run
  parked on one. Parked message waits are indexed in memory by guild, channel and member
  (§8.5), so only a message from a waiting member in a watched channel goes further.
- [x] *Added in planning:* a reply sent while the bot was down wakes the wait once the backfill
  has restored it; the scheduler holds message waits until then.

### 5.4 Message Sent (trigger)

- [x] Starts a run when someone posts. The author is the subject **and** the actor; the
  channel posted in is the run's channel.
- [x] **Where**: anywhere, one channel, or **every channel in a category**. Thread replies count
  toward their parent channel. The category option is what makes channels created on the fly
  (such as ticket channels) reachable, since a trigger cannot hold a `{{var}}`.
  *Vocabulary gap:* no picker offers a category today — either a category picker control or a
  channel-kind option on the channel picker (the guild API already sends categories with a
  `type`). *(Closed by a `categoryPicker` control.)*
- [x] **Contains**: an optional text filter, case-insensitive. No other match modes (§8.4).
- [x] **Never fires for bots, webhooks or system messages** — so a flow's own Send Message can
  never re-trigger it.
- [x] Records the channel posted in as an output of kind `channel`, so later blocks can pick it.
  *Decided 2026-10-03 (Douglas):* **threads give both values.** A message hands later blocks the
  channel it belongs to (a thread's parent) **and** the place it was actually posted (the
  thread itself); neither is chosen for the other, and both are always set. "In Channel" now
  counts a thread toward its channel too.
- [x] **No database read per message for guilds with no enabled Message Sent trigger.** Every
  message in every guild passes through this; the matching set must be cached and invalidated
  when a flow is saved, enabled or disabled. The cache is indexed by where each trigger listens
  (channel, category, anywhere), so a message only meets the triggers that could match it
  (§8.5). ~~No per-member cooldown.~~ *Amended 2026-10-03:* a fixed, engine-wide flood limit
  applies — see §8.5. Each guild is read once, on its first message, and dropped after any
  flow write this process makes.
- [x] **The activity record is written before flows see the message**, so a Time Since right
  after this trigger sees the triggering message. That rules out flows adding its own listener
  in parallel, and means **the activity subscriber stops being a single slot** — a second
  registration today silently evicts leveling.

## 6) Non-goals

- No scheduled or sweeping triggers ("every hour", "went quiet" across a server). Still the
  largest open option; revisit when a flow needs to act on something no run is holding.
- No expression language. Time Since compares one span against one duration.
- No keyword filter beyond "contains" (§8.4).
- ~~No per-member cooldown on Message Sent (§8.5).~~ *Amended 2026-10-03:* there is an
  engine-wide flood limit on message activity, per guild and per member, with fixed defaults
  (§8.5). Still no per-flow or operator-set cooldown.

## 7) Constraints

- Everything in `docs/contracts/block-authoring.md` holds: one directory per block, vocabulary
  extensions through the closed unions with their browser mirrors and drift gates.
- Production runs postgres and CI runs SQLite: any migration gets a live postgres run.
- SQLite has one synchronous connection: nothing on the per-message path may scan.
- User-facing copy keeps the bot's adult, sassy voice.

## 8) Decisions (answered 2026-10-02)

1. **A time is stored as an ISO-8601 UTC string.** It reads sensibly if a token puts it in
   copy and parses unambiguously; the `time` value kind tells the builder what it is.
2. **Set Variable's time is "now" only.** No offset; Time Since with *less than* covers
   deadlines. Add an offset when a flow needs one.
3. **Time Since with no record leaves by a third *No record* exit.** Either guess is wrong for
   some flow. This covers a member who never posted (or only before the record began) and a
   partial member with no join time.
4. **Message Sent matches "contains", case-insensitive, only.**
5. ~~**No per-member cooldown.**~~ The guard against cost is filtering: a message
   must be matched against only the triggers and waits that could care about it. Index the
   enabled Message Sent triggers and parked message waits by guild, then by channel/category
   (and, for waits, by member), so a message in a channel nobody is listening to costs a map
   lookup and nothing else. See §5.3 and §5.4.

   *Amended 2026-10-03 (Douglas): filtering **and** a basic flood limit.* Filtering alone does
   not stop the bot spamming itself — "Message Sent → reply → wait for a message → reply" wakes
   every earlier copy on every message — or keep a busy guild under Discord's rate limits. So
   message activity draws from an in-memory token count, per guild (a burst of 30, one back per
   second) and per guild + member (a burst of 5, one back every ten seconds), both checked
   before either is spent. It limits **only** Message Sent run starts (one token per run
   started, checked after a trigger matched) and live message-wait wake-ups (one per run woken;
   a skipped run stays parked). Catch-up wakes after an outage, joins, leaves, reactions,
   level-ups and button clicks are never limited: each is a one-off event, and dropping one
   loses it for good. Refusals log one summary line per guild per minute. Fixed defaults in
   `constants.ts`; not per flow and not operator-set.
6. **Wait for Event's message kind waits on the run's member only.** It keeps the rule that
   every wait is about the run's member.

### Sequencing (decided 2026-10-02)

One step at a time, each planned, built and verified before the next is planned:

1. ~~**Outage blindness**~~ — **done 2026-10-02**: the startup backfill (§4,
   [activity-backfill.md](../plans/activity-backfill.md)).
2. **Step A** — Set Variable, the `time` value kind (the contract change in §5.1) and Time
   Since (§5.2).
3. **Step B** — Message Sent (§5.4) and the message event on Wait for Event (§5.3), which also
   turn the activity subscriber into a list and add a category picker. **Built 2026-10-03**,
   not yet run on a real guild.

## 9) Acceptance criteria

- [ ] The §3 example builds in the builder from these blocks alone, saves, and runs on a real
      guild: the reminder posts after the quiet period, a reply restarts the clock, continued
      silence kicks and closes, and a member who leaves has their ticket closed.
- [ ] Each §3 "other flows" example builds and runs.
- [ ] Conformance passes for every new block with no special case.
- [ ] The per-message path performs no database read in a guild with no Message Sent trigger and
      no run waiting on a message. *Amended 2026-10-03:* this is **flows' share** of the path —
      after a guild's one lazy load, flows reads nothing per message there. Activity still writes
      a row per message and leveling still reads its config per message; neither is flows'.
      (Covered by `messageSent.test.ts`; still to be checked on a real guild.)
- [ ] Leveling still awards message XP with a second activity consumer registered.
