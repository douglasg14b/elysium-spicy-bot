# Step 1 of ticket triggers — the Ticket Event trigger

> **Status**: Built 2026-10-03 (not yet run on a real guild)
> **PRD**: [flow-engine-v2-journeys-and-provisioning.md](../prds/flow-engine-v2-journeys-and-provisioning.md) line 267 ("Ticket triggers: opened / claimed / closed / deleted, filterable by type"), and the cascade-bounding requirement at line 255
> **Next**: step 2 checks for loops across flows when a flow is saved (its own plan, sketched at the end)

## What the operator gets

- **Ticket Event**, a trigger block. Pick an event (opened, claimed, unclaimed, closed,
  reopened, deleted) and, optionally, a ticket type. Any ticket matching both starts the
  flow.
- **The run's member** is the person the ticket is about, even if they have left the server.
  **Whoever did it** (claimed it, closed it, and so on) is the run's actor when a person did
  it.
- **The ticket travels with the run.** Later blocks read `{{var.ticketId}}` and
  `{{var.ticketChannelId}}`, so Close Ticket works on the triggering ticket without setup.
- **Ticket types come from the server's own list** in the type picker, in Ticket Event,
  Open Ticket and Has Open Ticket. Support and Verification are just the seeded entries,
  never special cases.
- **A runaway chain stops itself.** A flow's ticket change can start other ticket flows, and
  theirs can start more, but only up to a depth cap. The run past the cap is refused and
  logged.

## Decisions (Douglas, 2026-10-03)

- **Events:** all six of opened, claimed, unclaimed, closed, reopened and deleted.
- **One block** with an event dropdown, not a block per event.
- **Ticket changes a flow makes do start other flows.** No blanket one-generation rule.
  Loops are handled by:
  - **static detection across flows** (step 2): treat flows as a directed graph, with an
    edge where one flow's action causes what another flow's trigger listens for. A cycle is
    refused when a flow is turned on;
  - **runtime detection** that halts a firing loop early (this step).
- **Ticket types are the server's own.** The seeded ones are never special.

## Decisions made in planning (not asked)

- **Opened fires once the ticket has its channel,** not when the record is created.
  `openTicket` returns before any channel exists, and an opened flow with no channel to talk
  in is useless. A ticket whose channel creation fails fires nothing; its creator already
  reports that failure. *(Moved later in review — see "Decisions made while building":
  opened now fires once the state message is recorded.)*
- **An auto-claimed ticket fires opened only, not claimed.** Nobody claimed it; the type
  did. Recorded here so it is a decision, not a surprise.
- **Deleted carries no channel.** The delete button deletes the channel right after
  recording the delete. A channel deleted by hand is not a ticket delete: it only clears
  `channelId`, as it does today.
- **The member who has left:** the run gets a partial member, exactly as Member Leaves does.
  It is not skipped the way Level Reached skips. Blocks that need a full member fail by
  name, as they already do on Member Leaves.
- **Depth cap: 5.** A run started by a person's action has depth 1. A run started by a
  ticket change that a depth-N run made has depth N+1. A run that would have depth 6 is not
  started, and the refusal is logged with the flow and the ticket.

## Decisions made while building (2026-10-03)

- **The dispatcher lives in `logic/ticketEventDispatch.ts`, not the block directory.** The
  branching gate's cross-block import check only sees `blocks/<dir>` imports, so a
  subpath import from `initFlows` would have slipped past it; importing the block's index
  instead would have made `initFlows` a declared block dependent. `logic/` is ungated by
  the vocabulary gate, and the file is a declared residual dependent of the trigger, the
  shape `levelUpDispatch` and `planButtonDeployment` already have.
- **`setImmediate` promises no nesting, not "A finishes before B starts".** Flow B is never
  on flow A's stack, and A never awaits B. But if A is still waiting on Discord when the
  dispatch fires (Close Ticket syncs, re-renders and announces after the row commits), B
  runs beside it. The ordering test holds because TestDiscord answers without real I/O.
  Getting the stronger property would mean deferring dispatch until A's segment ends
  (`AsyncLocalStorage` around the executor, draining a per-run list) — engine surface this
  step did not take on.
- **Opened fires when the state message is first recorded, not on attach** (review fix).
  Both creators attach the channel, then send the embed with Claim and Close on it, then
  record its id. Announcing on attach let a flow that starts on Opened and closes the
  ticket win the race: the record read closed while the embed posted after it showed the
  ticket open. So `attachTicketChannel` is silent, and `recordTicketStateMessage` — a
  conditional write on an open ticket with no state message recorded — announces.
  **A ticket whose state message fails to send, or whose id cannot be recorded, fires
  nothing.** The creator logs the failure; nobody listening for Opened hears that ticket.
- **A leaver's partial member is built the way discord.js builds one.** There is no public
  API; the dispatcher calls `guild.members._add({ user }, false)` after fetching the user,
  exactly what discord.js's own `GuildMemberRemove` action does. Only Discord's
  `Unknown Member` makes the subject a leaver; any other member-fetch failure — and a user
  Discord cannot fetch at all — throws, and the subscriber logs it with nothing started.
  The same rule holds for the actor.
- **`change` is required on every announcing service function** (review fix; the plan had it
  optional) and on `applyTicketTransition`. There is no default for a caller to fall back
  on by forgetting, and a forgotten depth is the silent failure the cap exists to prevent.
  Claim announces `change.actorId`, not the claimer, so a future flow-made claim cannot
  report the bot as a person. `change.actorId` is kept apart from the displayed actor:
  Close Ticket names the bot in the channel but reports nobody acted.
- **Unclaim is a conditional write** on the claimer it read (`releaseClaimIf`), like every
  other transition: two concurrent unclaims cannot both announce, and a stale one cannot
  wipe a fresh claim. A miss fails "changed before it could be unclaimed".
- **The dashboard passes the operator's Discord id** — the session's `user.id` comes from
  the OAuth login.
- **Attaching is conditional on an open ticket with no channel recorded**, so a second
  attach fails rather than overwriting the first. A ticket whose channel was deleted also
  has no channel or state message recorded; nothing re-attaches or re-records today, and a
  path that does must decide whether that is a second opened.
- **`ticketChannelId` is seeded only when the channel resolved**, so the variable and the
  run's channel always agree.
- **A run for a member who has left fails if it waits:** resuming re-fetches the member.
- **Ticket Event declares `requires: ['subject']` only.** Actor is absent when a flow made
  the change, and channel on a delete, so promising either would let graphs go live that
  cannot always be satisfied.
- **The depth-cap test pings and pongs Open Ticket between two types**, not close and
  reopen: there is no Reopen Ticket block.
- **Cosmetic, known:** the service announces before `applyTicketTransition` syncs and
  announces, so a flow started by Closed can post before the "closed by" line lands.

## Design

### 1. The ticket service announces changes (tickets stays flows-free)

- **A subscriber list in tickets**, `registerTicketSubscriber`, mirroring
  `features-system/activity/activitySubscribers.ts`: subscribers are notified with
  `Promise.allSettled`, and each failure is logged and isolated. Flows registers one
  subscriber from `initFlows`.
- **Emit from the service functions, never from `applyTicketTransition`.** That would miss
  open, delete, and Close Ticket's direct-close fallback. The emitting functions are:
  - `recordTicketStateMessage`, as opened (first record only — moved from
    `attachTicketChannel` in review);
  - `claimTicket`;
  - `unclaimTicket`;
  - `closeTicket`;
  - `reopenTicket`;
  - `deleteTicket`.
- **The event:** `{ kind, ticket: TicketEntity, actorId: string | null, chainDepth: number }`.
  - The service functions gain an optional `change` input carrying `actorId` and
    `chainDepth`. Today only claim knows who acted, so close, unclaim, reopen and delete
    must be handed it by their callers (buttons, dashboard routes, flow blocks).
  - `chainDepth` defaults to 0 for a person's action. A flow block passes its run's depth.
  - "Chain depth" is a causation idea, not a flows idea, so tickets can name it without
    learning about flows.
- **Emit only after the write succeeds.** Never inside a repo transaction: a subscriber's
  first query would deadlock SQLite's single connection (memory note
  `sqlite-single-connection-deadlock`).

### 2. The flows subscriber never runs a flow inside the caller

When flow A's Close Ticket block closes a ticket, the event fires inside A's node. If the
subscriber awaited `startTriggeredRun`, flow B would run nested inside A, and a loop would
recurse on the stack.

- **The subscriber schedules its dispatch** (`setImmediate`) and returns at once. B is
  never nested in A's step and never starts on A's turn; A never awaits B. It is *not*
  promised that A finishes first — if A is still waiting on Discord when the dispatch
  fires, the two run side by side (see "Decisions made while building").
- **Tests prove the nesting:** B is not nested in A's step and does not start on A's turn.

### 3. Dispatch

- **Placement** (built in `logic/` instead — see "Decisions made while building").
  `'ticket'` is a proven rejection in the engine vocabulary gate, by design:
  the engine must not learn a use case. So the dispatcher does not live in `engine/` and
  declares no ticket-named identifiers there.
  - It lives beside the trigger block, in a non-gated file in the block's own directory,
    as other block-owned helpers do.
  - `initFlows` wires it as the subscriber. Check that the `blockTypeBranching` /
    `DECLARED_BLOCK_DEPENDENTS` rules allow `initFlows` to import from a block directory.
    If they don't, put it in an ungated flows folder and record the reason.
- **New trigger source** `'ticketChanged'` in `BLOCK_TRIGGER_SOURCES`, with its browser
  mirror and drift gate. It is a string literal, which the gate doesn't scan.
- **Matching:**
  - load the guild's enabled flows (`levelUpDispatch` is the model);
  - keep trigger nodes started by `ticketChanged` whose config parses, whose `event` equals
    the event's kind, and whose type filter is empty or equals the ticket's type;
  - start each through `startTriggeredRun`.
- **Seed:**
  - `subject` is the ticket's member. Fetch it; on failure use a partial member, copying
    `memberLeaveDispatch`.
  - `actor` is the acting member when `actorId` is set and fetchable.
  - `channel` is the ticket's channel when it has one.
  - `eventAt` is the time of the change.
  - `variables` holds `TICKET_VARIABLES.ticketId` and `ticketChannelId` (the latter only
    with a channel), declared as `fixed` outputs on the trigger like Has Open Ticket's.
- **Depth:** a run started here records `chainDepth + 1`. A run whose depth would exceed
  `FLOW_MAX_CHAIN_DEPTH` (5) is refused, logged, and not started.

### 4. Runs carry their depth

- **Persisted on the run** (the snapshot or `waitConfig` home, whichever `startedAt` used),
  with an entity-version bump (`FLOW_RUN_ENTITY_VERSION` 4 → 5). The bump has an empty,
  documented migration: an older run reads as depth 1. No new column, so no
  Postgres-gated migration.
- **On the run context** (`FlowRunContext.chainDepth`), so Open Ticket and Close Ticket
  pass it to the service. A parked run keeps its depth across restarts.
- **Every other trigger starts runs at depth 1.**
- **Known limit:** Kick Member → Member Leaves goes through Discord's gateway, which
  cannot carry a depth, so that run restarts at the root. Step 2's static check covers it.
  Award XP → Level Reached is not a second case: `awardFlowXp` announces the level but
  never notifies level-up subscribers, so flow-awarded XP starts no Level Reached run.

### 5. Ticket-type picker (contract change)

- **A new control `ticketTypePicker`.** It stores a type **key** and offers the guild's
  configured types by label. It is loaded the way the other guild pickers in
  `PickerControls.tsx` load their options, from the existing ticket-types read in
  `ticketRoutes.ts` (around line 672). Add it to `BLOCK_CONTROL_TYPES` on both sides,
  plus conformance and the drift key list.
- **A stored key that is no longer configured** shows as "not available here", the way the
  channel picker shows a deleted channel. At run time:
  - Open Ticket fails by name on an unknown type, as it does today;
  - Has Open Ticket answers from the key;
  - Ticket Event simply matches nothing.
- **Switch Open Ticket and Has Open Ticket** from their hardcoded `support` / `verification`
  selects to the picker. Stored values are already keys, so no data migration. Remove the
  "stay the two seeded keys" comments.
- **Ticket Event's filter is optional:** empty means any type.
- **Known gap, unchanged:** deleting a ticket type doesn't check flows that name it. The
  stale marker is what surfaces it.

### 6. The block: `blocks/triggerTicketEvent/` (`trigger.ticketEvent`)

| Field | Control | Notes |
|---|---|---|
| `event` | `select` | opened (default), claimed, unclaimed, closed, reopened, deleted |
| `ticketType` | `ticketTypePicker` | optional; empty means any type |

- **Outputs:** `ticketId` (kindless) and `ticketChannelId` (`valueKind: 'channel'`, absent
  for deleted).
- The description notes that auto-claimed tickets fire opened only, and that deleted has no
  channel.
- Copy is in the bot's voice, like its siblings.

## Tests

- **Service:** each of the six functions emits once, after a successful write, with the
  actor and depth it was handed. A refused transition, or a write that lost a race (claim,
  unclaim, the lifecycle moves), emits nothing. Opened fires on the first state-message
  record only; opening the record and attaching the channel are silent.
- **Dispatch:**
  - matching on event and type, where empty type means any;
  - the seed (subject, partial member for a leaver, actor, channel, variables);
  - a disabled flow never starts.
- **Nesting:** flow B, started by flow A's Close Ticket, is never nested in A's step and
  never starts on A's turn.
- **Depth cap:** two flows that close and reopen the same ticket stop at depth 5 with a
  logged refusal. Sabotage: remove the cap and watch the test fail, then restore it.
- **Parked depth:** a run parked at depth 3 that later closes a ticket starts its follow-on
  at depth 4.
- **Picker:**
  - conformance and the drift gate for the new control;
  - the control offers the guild's types and marks a stale key;
  - Open Ticket and Has Open Ticket accept a custom type key.
- **End to end on TestDiscord:**
  - pressing Close on a ticket starts a Ticket Event (closed) flow that posts in the ticket
    channel;
  - a flow-opened ticket starts a Ticket Event (opened) flow.

## Step 2 sketch (not planned in detail yet)

- **Actions declare what they cause:** `emits: [{ source, match }]`.
  - Open Ticket emits opened, and claimed only if its type auto-claims; conservatively,
    both.
  - Close Ticket emits closed.
  - Kick Member emits a member leaving.
  - Award XP emits **nothing**: flow-awarded XP never sets off Level Reached
    (`awardFlowXp` skips `notifyLevelUp`, by design — see that trigger's note). If that
    ever changes, it becomes an edge here.
- **The graph:** an edge A → B when something A emits matches what B's trigger listens for,
  by event, and by type when both name one. A cycle is refused when a flow is turned on.
  That includes every way a flow gets turned on: check whether journey install enables
  flows.
- **Graph library:** consider `graphology` with its cycle and strongly-connected-component
  helpers, against the existing `hasCycle` DFS in `graphValidation.ts`.
- **Known over-refusal, accepted:** "Member Leaves → Close Ticket" plus "Ticket Closed →
  Kick Member" is a static cycle that stops at runtime, because the second kick has no one
  to kick. It will be refused. Douglas chose refusals for now; relaxing them is a later
  problem.
