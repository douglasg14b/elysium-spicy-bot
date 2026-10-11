# Step B — Message Sent trigger and the message wait

> **PRD**: [flow-time-and-message-primitives.md](../prds/flow-time-and-message-primitives.md) §5.3, §5.4, §6, §8, §9, §4 open items
> **Status**: Planned 2026-10-03, revised after two plan reviews (grounding and coverage) and Douglas's answers
> **Builds on**: activity events, quiet timeouts and backfill (`83bf681`), Step A (`67aef56`)
> **Built in two parts**: Part 1 = §1–§4 (no new flood source; unblocks the PRD §3 example). Part 2 = §5–§9.

## What the operator gets

- **Wait for Event → a message** (Part 1): the run waits until its member posts, optionally
  in one channel, which may be a `{{var}}`. Thread replies count toward their channel. It
  works with the existing time limit and its Timed out exit. A reply sent while the bot was
  down is noticed once the bot catches up.
- **Message Sent** (Part 2): a trigger that starts a run when someone posts.
  - **Where:** anywhere, one channel, or every channel in a category. Thread replies count
    toward their channel.
  - **Contains:** an optional text filter, case-insensitive.
  - **Never** bots, webhooks or system messages.
- **A category picker** (Part 2), and **a flood limit** on message activity (Part 2).

## Decisions (Douglas)

- "Contains" only, case-insensitive (PRD §8.4). The message wait is for the run's member
  only (§8.6). The backfill stays record-only, so a recovered message never *starts* a run.
- **Threads give both values** (2026-10-03): a message hands later blocks the channel it
  belongs to and the place it was actually posted. Neither is chosen for the other (§6).
- **Replies sent while the bot was down are noticed** once the backfill finishes (§4).
- **Anti-spam** (2026-10-03): it must be basic and clean, and must keep the bot from spamming
  itself or hitting Discord's rate limits.
  - **It limits message activity only:** Message Sent starts and live message-wait wake-ups.
    Joins, leaves, reactions, level-ups and button clicks are not limited, because dropping
    a one-off event loses it for good (a leaver's ticket would never close).
  - **Wake-ups count against the limit.** That stops the loop "Message Sent → reply → wait
    for a message → reply", where every message would otherwise wake every earlier copy. A
    skipped wake-up isn't lost: the run stays parked, and the member's next message or the
    time limit moves it on.
  - This **overrides** the PRD's 2026-10-02 "no per-member cooldown" (§6 non-goal and §8.5).
    There is still no per-flow, operator-set cooldown. The limit is engine-wide with fixed
    defaults. Amend PRD §6 and §8.5.
- A real-guild run is deferred. TestDiscord end-to-end tests stand in for now.

## Technical decisions (made in planning)

- **Category picker:** a new `categoryPicker` control, outside `PICKER_VALUE_KINDS`.
  Triggers refuse `{{var}}` anyway (`graphValidation.ts:~500-517`).
- **Activity subscribers become a list,** notified in parallel with per-subscriber isolation.
- **Vocabulary gate:**
  - Add `category`, `thread` and `parent` to the domain list as Discord nouns, each with a
    reason.
  - For the limiter, prefer words already allowed (`limit`, `tokens`, `count`, `interval`),
    e.g. `FLOW_MESSAGE_LIMIT_PER_GUILD` and `..._INTERVAL_MS`. Admit `bucket`/`refill` only
    with a stated reason.
  - Avoid `sent`, `contains`, `keyword`, `cache`, `lookup`, `anywhere`, `idle`, `prune`.
- **§9's "no DB read per message"** applies to what *flows* adds. Activity already writes a
  row per message, and leveling reads its config per message. Amend §9.

---

# Part 1

### 1. Composite indexes for "this member in this channel"

- Migration `2026-10-03-Activity_Member_Channel_Indexes.ts`:
  - `(guild_id, channel_id, user_id, occurred_at)`
  - `(guild_id, parent_channel_id, user_id, occurred_at)`
  - Use the per-dialect pattern, with the SQLite arm in its own transaction.
  - Keep the existing three indexes.
- `kind` is left out of both, deliberately: it's an equality filter, and reaction rows are a
  minority. Record that in the report.
- Verify with `EXPLAIN QUERY PLAN` (SQLite) and `EXPLAIN` (Postgres) that both
  user + channel shapes seek the new indexes, including the new range query in §4. Paste the
  output into the report.
- Postgres gate: a live migration run on a throwaway `postgres:16`.

### 2. Activity subscribers as a list

- `activitySubscribers.ts`:
  - the slot becomes an array;
  - register appends;
  - clear empties it;
  - `notifyActivity` uses `allSettled` with one log line per failure.
- Update the doc comment that says replacing is what tests do.
- Add `parentChannelId` to `MessageActivityEvent`.
- **Acceptance:** leveling still awards message XP with a second subscriber registered, and
  with a throwing one (next to `leveling/__tests__/activitySubscription.test.ts`).

### 3. Message wait on Wait for Event

- **Vocabulary:** `'message'` in all three wait-kind copies, kept together:
  - the block's enum **and its `eventKind` select options** (label "A message");
  - `FlowWaitKind` (`data/flowRunsSchema.ts`);
  - `waitConfigSchema` (`data/flowRunsRepo.ts`).
- **`waitConfig` shape:** gains `channelId?: string` and `parkedAt: string` (ISO) in **both**
  `FlowRunWaitConfig` and the stripping `waitConfigSchema`.
  - Add an `AssertTrue<Equals<…>>` guard between them, as `quietWindowSchema` has, so a key
    can't silently vanish on read.
  - Write `parkedAt` on every park onto a message wait. **Don't** use `flow_runs.updatedAt`:
    claim, release, reclaim and `deferWake` all bump it.
- **Field:** `messageChannelId`, a channelPicker, optional, `{{var}}` allowed,
  `visibleWhen: { field: 'eventKind', equals: ['message'] }`.
  - The executor resolves the token before `run`.
  - `waitConfig.channelId` stores the resolved id.
  - Reuse `checkChannelUsable` on the parking leg.
- **Entity version:** `FLOW_RUN_ENTITY_VERSION` → 4, with a documented empty migration, per
  the 2026-09-15 and 2026-10-02 precedent.
  - **Rollback hazard:** an older build fails its enum on a `'message'` row, and
    `assertValidJsonColumns` throws for the whole `findWaiting`/`findDue` batch. Say so in the
    migration's doc comment.
- **Quiet windows coexist,** as today.

### 4. The message-wait index, live wakes, and outage catch-up — `engine/`

**Live wakes**

- `initFlows` registers an activity subscriber (name it e.g. `wakeMessageWaits`; **not**
  `handleMessageActivity`, which is leveling's private method). It acts only on
  `kind: 'message'`.

**The index**

- It is keyed by **runId**, one entry per run: `{ runId, guildId, userId, channelId? }`, with
  a secondary map guild → member → runIds for matching.
- **Every transition writes or deletes the run's entry, whatever the wait kind:**
  - `create` (executor) and `park` (resume): write it if the new park is a message wait,
    otherwise delete it;
  - `releaseClaim`: re-write it from the run's current park;
  - a **successful claim** deletes it.
  - Startup reclaim feeds the rebuild (below).
  - `flowRunLifecycle.ts` lists the transitions. The test suite must prove each one.
- **Claims are narrowed:** the message-wake claim uses `claimForResume`'s existing `narrow`
  callback with `waitKind = 'message'`. A leftover entry for a run now parked on a Delay or a
  question then **can't** claim it. Without this, a member's message would end a Delay early.
  This is load-bearing: test and sabotage-verify it.
- **No lazy pruning on a missed claim.** Pruning would race a fresh re-park (message A
  claims, B misses, A re-parks, B deletes the fresh entry) and lose a wake.
- **Matching:** an entry matches when it has no channel, or when the message's channel or its
  `parentChannelId` equals the entry's channel.
  - **Copy the matching runIds before resuming any of them.** A run that re-parks inside this
    handler must not be woken again by the same message.
- **Rebuild:** once, in the scheduler's startup path **after** `reclaimStrandedFlowRuns`
  (`runStartupSweep`), from `findWaiting({ waitKind: 'message' })`, so runs stranded mid-resume
  are included.
  - Not in `initFlows`: one bad row would stop the boot there, and no messages arrive before
    ready anyway.
  - If the rebuild fails, log loudly and leave the index empty. Parked message waits then get
  no live wakes until the next restart; say so in the log line.

**Scheduler hold and outage catch-up**

- **Hold:** while `isBackfillPending()` **or catch-up is still running**, `findDue` also
  holds `waitKind = 'message'` runs, alongside today's quiet-window runs. Otherwise the
  startup sweep times out a wait whose member replied in time while the bot was down.
- **Catch-up:** when the backfill finishes, go through every parked message wait once, **one
  at a time** (each resume finishes before the next starts; this is the pacing, and it
  doesn't touch the Part 2 limit). For each:
  - **New repo query:** "is there a message by this member in this channel (or a thread under
    it) between `parkedAt` and the earlier of `wakeAt` and now". The §1 indexes serve it.
  - **If there is one,** wake the run with the event exit. Each run wakes at most once,
    however many messages there were.
  - **If there isn't,** leave it. A run past its deadline is then timed out by the scheduler
    once the hold lifts. A message *after* the deadline doesn't save it.
- **Signal:** activity exposes "backfill finished" without importing flows, as a promise or
  a callback registration that fires immediately when registered late.
  - It also fires when the backfill failed or couldn't start. In that case catch-up runs on
    partial history; say so in the doc comment.
  - Test both: registering late, and a failed backfill.

### Part 1 tests (~90%, behaviour)

- **Indexes:** the `EXPLAIN` evidence and the Postgres gate.
- **Subscribers:** XP is still awarded with a second subscriber, and with a throwing one.
- **Message wait** (TestDiscord with `start({ client: DISCORD_CLIENT })`, live messages
  after start):
  - wakes on the member's message in the channel, in a thread under it, and anywhere when no
    channel is set;
  - ignores other members and other channels;
  - a `{{var}}` channel resolves;
  - the time limit still times out;
  - `waitConfig` round-trips `channelId` and `parkedAt`.
- **Index correctness:**
  - re-parked after a resume and after a released claim, still woken;
  - **two quick messages to a flow that loops back to the wait**: one wake per message, and
    the second message still finds the re-parked entry;
  - a leftover entry for a run now on a Delay can't claim it (sabotage the `narrow`);
  - a run re-parked inside the handler isn't woken twice by one message.
- **Outage catch-up** (beside `restartAfterOutage.test.ts`):
  - a reply recovered by the backfill wakes the wait;
  - a deadline passed during the outage with a reply before it takes the happened exit;
  - a reply only after the deadline times out;
  - no reply stays parked or times out as due;
  - the scheduler doesn't time out a message wait while backfill or catch-up is pending
    (sabotage the hold).
- Threads can only be created before `start()` in TestDiscord. Create them first and use
  `moveTo` afterwards.

---

# Part 2

### 5. Activity-driven trigger plumbing

- **One shared start function:** `startTriggeredRun(...)`, or similar, in `engine/`, used by
  every gateway dispatcher in place of a direct `executeFlow`:
  - `memberJoinDispatch`
  - `memberLeaveDispatch`
  - `reactionAddDispatch`
  - `levelUpDispatch`
  - the new message dispatcher
  
  The button path (`flowTriggerDispatch`) is left alone. Only the message dispatcher passes
  a limit, but the single entry point keeps run starts in one place.
- **Trigger index for Message Sent** (per guild):
  - entries are `{ flowId, nodeId, where, channelId?, categoryId?, contains? }`, bucketed by
    anywhere / channel id / category id;
  - **loaded lazily** on a guild's first message, sharing the in-flight load between
    concurrent messages;
  - an empty entry is cached for guilds with none;
  - if the load throws (`getByGuildId` validates graphs), log it, cache nothing, and retry on
    the next message.
- **Invalidation:**
  - a **write-listener registration on `FlowsRepo`**, wired from `initFlows` (the
    `registerResourceWriteBack` pattern), so `data/` never imports `engine/`;
  - it fires **after** the write's transaction commits: `create`, `update` (install
    write-back), `mutate` (save and enable/disable; a `drafted` outcome doesn't fire) and
    `deleteByFlowId`. `setEnabled` has no production caller and delegates to `update`;
  - a **version counter** discards a reload that began before an invalidation.
- **Seed script:** `seedOnboardingFlow` writes from another process, so the running bot
  doesn't see it until a restart. Note it.

### 6. Message Sent trigger — `blocks/triggerMessageSent/`

- **Vocabulary:** `'messageSent'` in `BLOCK_TRIGGER_SOURCES`, plus the browser mirror, the
  drift gate and the `startedBy` list in `block-authoring.md`. `requires: ['subject', 'actor',
  'channel']`. No eligibility field.
- **Fields:**

  | field | control | shown when | schema |
  |---|---|---|---|
  | `where` | select: Anywhere / A channel / A category | always | default `anywhere` |
  | `channelId` | channelPicker | where = channel | optional; required when visible |
  | `categoryId` | categoryPicker | where = category | optional; required when visible |
  | `contains` | text, optional, `maxLength` | always | optional; trimmed; empty means no filter |

- **Outputs:** fixed, `valueKind: 'channel'`, **always set**, so neither is ever a trap:
  - **channel**: the channel the message belongs to. For a thread reply, that's the channel
    the thread sits under.
  - **posted in**: where it was actually posted. For a thread reply that's the thread;
    otherwise it's the same channel.
  
  The keys are exported by the block (e.g. `MESSAGE_SENT_VARIABLES`) and filled in by the
  dispatcher, following the Level Reached precedent. Add `DECLARED_BLOCK_DEPENDENTS` entries.
- **The run's channel** is where the message was posted, so replies land in the thread.
- **The run's member:** `message.member`, or a fetch. If that fails, skip that trigger and
  carry on, like `reactionAddDispatch`.
- **Matching** happens in the dispatcher, after wake-ups:
  - **where:** anywhere; the channel or a thread under it; any channel whose `parentId` is the
    category, or a thread whose parent's `parentId` is, read from the cache;
  - **contains:** `toLowerCase()` on both sides (locale-independent).
- **The limit is checked after a trigger has matched,** so messages that match nothing spend
  nothing.
- **Disclosed limits** (block description and doc comment):
  - only live messages that activity recorded start runs;
  - uncached channels are dropped by discord.js (no `Partials.Channel`);
  - after a resumed gateway session, Discord replays missed messages as live, so they can
    start runs (the limit covers it);
  - for a forum thread, the channel output is the forum, which Send Message can't post into.

### 7. "In Channel" counts threads toward their channel

`conditionInChannel` compares `context.channel.id` only, so a thread reply that Message Sent
counted toward #general answers No. Make it also match the thread's parent, so threads count
toward their channel everywhere. It's a small behaviour change to a shipped block: test both
cases and note it in the commit.

### 8. Flood limit on message activity

- **One helper** in `engine/`: an in-memory token count per key with a burst size and a
  refill interval. `take(key, now)` checks before taking. No timers: refill is computed from
  elapsed time. Unused keys are dropped after a while.
- **Two keys:** per guild, and per guild + member. **Check both before taking from either,**
  so a member refusal doesn't spend a guild token.
- **What draws a token:**
  - each Message Sent **run start**, one per run started, so a message matching three
    triggers spends three;
  - each **live message-wait wake-up**, one per run woken.
- **On refusal:**
  - a start is dropped;
  - a wake-up is skipped, and the run stays parked for the next message or its time limit.
- **Never drawn by:** catch-up wakes (paced on their own in §4), joins, leaves, reactions,
  level-ups or button clicks.
- **Logging:** one summary line per guild per minute
  (`[flows] Message limit: skipped N run start(s)/wake-up(s) in guild X`). It's flushed by the
  next refusal after the minute is up, or by a small `unref`'d interval; say which.
- **Defaults** in `constants.ts`, with the reasoning:
  - per guild, a burst of 30 refilling 1 per second;
  - per member, a burst of 5 refilling 1 every 10 seconds.
  
  Not operator-configurable.

### 9. Category picker control

- `'categoryPicker'` in `BLOCK_CONTROL_TYPES` (both sides), a config-field arm,
  `BLOCK_CONFIG_FIELD_KEYS`, arms in `renderControl.tsx` and `cardSummary.ts`, and the drift
  fixture.
- **Builder:** a select of `type === 'category'` from `/:guildId/channels`, plus declared
  `category` resources through the existing `<field>Key` sidecar path.
- No `{{var}}`. The card shows the category name.

### Part 2 tests (~90%, behaviour)

- **Message Sent** (TestDiscord, live):
  - matches anywhere, a channel, a thread under the channel, a category, a channel moved
    into a category and a thread under it;
  - contains matches regardless of case and refuses a miss;
  - bots, webhooks and system messages never start a run;
  - both outputs are always set, and correct for a thread reply;
  - the run's channel is where the message was posted;
  - a save, enable/disable, delete and install write-back each change what fires without a
    restart (sabotage one invalidation path);
  - a failed guild load retries.
- **No-read guarantee:** in a guild with no trigger and no wait, messages cause no flows repo
  read. Sabotage the empty-guild entry.
- **Limit:**
  - a member flood starts at most the member burst, while others get through;
  - a guild flood is capped;
  - **the loop shape** ("Message Sent → reply → wait for a message → reply") stays bounded
    under a burst of messages;
  - joins, leaves, level-ups and button clicks are never limited;
  - drops log one summary line.
  
  Sabotage the member key.
- **In Channel:** a thread reply under #general answers Yes for #general.
- **Category picker:** dom test; drift and conformance.
- **Inventory:** conformance passes for `triggerMessageSent` with no special case. Add it to
  `SHIPPED_BLOCK_TYPES`.

## Out of scope

- A "variable is set" condition.
- Recording which message or channel woke a message wait.
- Message Sent on backfilled messages.
- Match modes beyond "contains".
- Operator-configurable or per-flow limits.
- Forum channels in the pickers.
- `Partials.Channel`.
- A real-guild run (deferred by Douglas).

## Docs

- **`AGENTS.md`:** the activity line (subscriber list) and the flows message dispatcher.
- **`block-authoring.md`:**
  - `categoryPicker`;
  - `messageSent` in `startedBy`;
  - the message wait kind;
  - the shared run-start function.
- **PRD:**
  - tick §5.3 and §5.4;
  - amend §6 and §8.5 (the flood limit overrides "no per-member cooldown");
  - amend §9 to cover flows' share only;
  - record the thread decision.
