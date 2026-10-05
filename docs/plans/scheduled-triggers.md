# Scheduled triggers — step 1: runs about nobody

> **Status**: Step 1 built 2026-10-04, committed with step 2 in `ca254c8`, not run on a real
> guild. The plan was
> reviewed (coverage and repo grounding) before the build, and the build was reviewed after
> (domain/runtime, maintainability, general).

## Decisions made while building (2026-10-04)

- **"Whoever did it" (Douglas).** A ticket change a flow makes names **the bot** as its
  actor. `change.actorId` is never null now, and an actor who has since left the server
  arrives as a partial member. So Ticket Event always supplies an actor
  (`requires: ['subject', 'actor']`). `actor` gained a `fromTrigger` refusal:
  `{{actor.mention}}` is refused below Member Leaves, because Discord doesn't say who kicked
  someone. It will also be refused below future runs about nobody. Recording the bot's own
  kicks, so that Kick Member → Member Leaves could name the bot, is out of scope.
- **The builder's copy of the server's rule is drift-gated.** `REQUIREMENT_ABSENT_WHEN` is
  derived from `CHECKED_REQUIREMENTS` and mirrored on the web.
- **The executor does not enforce `channel`.** A run whose channel was deleted while parked
  resumes as being nowhere (`parkedRunChannel.test.ts`). Subject, actor and interaction are
  enforced.
- **A parking block's own copy counts as after the park.** Example: `{{actor.mention}}` in
  Ask a Question's own text. It used to pass save and fail on every answer.
> **PRD**: none. The time-primitives PRD lists "scheduled or sweeping triggers" as out of
> scope (`docs/prds/flow-time-and-message-primitives.md`, ~line 179). This plan and Douglas's
> answers below are the requirements.
> **Steps**:
> 1. Runs about nobody (this plan).
> 2. A server time zone.
> 3. The Schedule trigger.
>
> Step 2 and step 3 are planned in their own sections below.
> **After this feature**: ticket triggers step 2 (refusing a flow that would close a loop
> across flows), then the shared binding table cleanup.

## What the operator gets from this step

**Almost nothing visible yet, on purpose.** No trigger starts a run about nobody until step 3.
This step teaches the engine and the builder what such a run is, so the Schedule trigger, and
the memberless triggers after it, land on something already built and checked.

One visible change: **`{{actor.mention}}` after a wait is now caught in the builder instead
of failing when the run gets there.** It falls out of the same mechanism (see "The model").
A flow that already has one shows the mark and won't switch on until it's fixed. Before this,
it failed on every run that reached it.

What step 3 will then show, because this step built it:

- **Palette.** A flow whose runs are all about nobody **greys out the blocks that always need
  a member**, such as Assign Role, Send DM, Kick Member, Award XP, Open Ticket and Has Role.
  Hovering one says why, and they can't be added. Triggers are never greyed, so an author can
  still add a member trigger.
- **Canvas.** Where a flow has both kinds of trigger, the palette stays open. Instead, a node
  that needs a member is **marked on the canvas** as soon as it's connected where a run about
  nobody would reach it. The flow won't switch on like that.
- **Inspector.**
  - `{{subject.*}}` chips are greyed with a reason, as `{{actor.mention}}` already is after a
    wait.
  - Options that need a member are disabled with a reason, for example "The member's last
    message" in a quiet window.
- **Blocks that only sometimes need a member stay usable.** Time Since works with "the last
  message in a channel", "when the run started" or "a time in a variable". Only its member
  options are disabled.

## Decisions (Douglas, 2026-10-03/04)

- **A scheduled run is about nobody.** Not each member of a role, and not a stand-in member.
- **"About nobody" is a general engine idea, not a scheduling detail.** More triggers about
  nobody will follow. It must be integrated carefully, with its side effects thought through,
  which is why it is a step of its own.
- **Blocks that can't work without a member aren't allowed where a run has nobody.** The
  builder shows it, greying them out with an explanation, so the author learns what fits where.
  This covers Ask a Question too: it is refused there, not opened to anyone.
- Later steps:
  - one time zone per server, in the server's configuration;
  - repeat daily, on chosen weekdays, or every N hours or minutes;
  - a run missed while the bot was down runs once when it's back.

## Decisions made in planning (from the plan review)

- **What a node needs is worked out from three sources, all declared, with no list of blocks
  anywhere.** A node's *effective requirements* are:
  1. its block's `requires`;
  2. plus the `requires` of each **picked option** in its visible `select`/`segmented` fields
     (new: `BlockConfigOption.requires?`);
  3. plus the requirement of each **built-in token** used in its visible copy fields and
     `objectList` copy columns (new: each built-in token declares one, so `subject.*` →
     `subject`, `actor.*` → `actor`, and `guild.name` → none).

  The existing per-requirement walk in `checkContextRequirements` then runs on effective
  requirements instead of `block.requires`. One mechanism covers whole blocks, options and
  tokens, for `subject`, `actor`, `channel` and `interaction` alike.
- **Consequence, accepted:** `{{actor.mention}}` after a park becomes a save-time issue. It
  used to be only greyed in the picker and then fail at runtime. This is the same rule the
  picker already showed, now enforced.
- **The executor checks requirements, once, for every block.** Before a block's `run`, it
  compares the node's effective requirements with the context. A miss fails the step by name.
  The 11 subject blocks then narrow with a shared helper (`requireSubject(context)`), not
  hand-written guards that nothing tests. The executor check is what the tests sabotage.
- **The canvas mark comes from the server, not a second copy of the walk.** The builder
  already re-checks with the server when focus leaves the inspector. It will also re-check
  (debounced) after a structural edit: adding, removing or connecting nodes, or removing an
  edge. The server stays the one authority, with no client-side duplicate to drift.
- **The builder still computes availability for greying**, because greying must be instant
  and per field:
  - generalise `actorAvailableAt` into `requirementAvailableAt(requirement, nodeId, nodes,
    edges)`;
  - for `subject`: false when some ancestor trigger lacks it;
  - for `actor`: false when some ancestor trigger lacks it, or some ancestor parks;
  - built on `ancestorsOf`, which skips unreached nodes and triggers by itself, as the server's
    walk does;
  - a block the builder has no descriptor for is treated permissively, as today.
- **Time Since becomes `requires: []`.** Its `memberMessage` and `memberJoined` sources
  declare `subject` on the option. Its default source (`memberMessage`) is flagged on a flow
  whose runs are about nobody. That's correct: the author picks another source.
- **This branch owns the new descriptor fields.** `feat/web-sdk` is unmerged and replaces the
  hand-mirrored `web/src/api/types.ts`. When it rebases onto this work, it has to carry
  `BlockConfigOption.requires` and the token requirements.

## The model

**A trigger that doesn't declare `subject` in `requires` starts runs about nobody.** That's
already what `requires` means on a trigger: what it supplies. Today every trigger declares
`subject`, so the rule is vacuous. Nothing new is declared, and no trigger is named anywhere
in the engine.

- `FlowRunSeed.subject` becomes optional, exactly as `actor` and `channel` already are. Its
  doc changes from "Always present" to "absent on a run whose trigger supplies nobody".
- **Absent means about nobody. It never means "the member left".** Those stay two different
  facts everywhere, including in the snapshot and on resume.
- No stand-in member, no bot-as-subject, no placeholder id. Any of those would make the
  `subject` checks lie.

## Changes

### Declarations (`blocks/manifest.ts`, `engine/copyRendering.ts`)

- `BlockConfigOption` gains `readonly requires?: readonly FlowContextRequirement[]`. Add a
  conformance check that each entry is in `FLOW_CONTEXT_REQUIREMENTS` (precedent:
  `conformance.ts:195`).
- Each built-in token declares its requirement, typed against `RenderableToken`, so a token
  added without one is a compile error. Prefer a `Record<RenderableToken,
  FlowContextRequirement | null>` beside `RESOLVERS` over parsing the namespace prefix.
- Delete the "every run has a subject" comments: `manifest.ts:875-894` and
  `graphValidation.ts:650, 662`.

### Engine

| Where | Change |
|---|---|
| `blocks/types.ts` `FlowRunSeed.subject` | Optional. Rewrite the doc. |
| `engine/executor.ts`, before `run` | Compute effective requirements (shared with validation; see below) and fail the step by name on a miss: "needs a member, and this run is about nobody". Generalise to every requirement. |
| The 11 blocks with `requires: ['subject']` | Narrow through a shared `requireSubject(context)`. It returns the member, or throws a named programming error that the executor check makes unreachable. |
| `actionWaitForEvent` | Declares `requires: ['subject']`. All four of its wait kinds wait for *this member's* event, so with nobody the run could never wake. No existing flow breaks, because every shipped trigger supplies a member. |
| `actionPrompt` | `requires: ['subject', 'channel']`. Only the subject can answer (`flowChoiceDispatch.ts:99`). |
| `conditionTimeSince` | `requires: []`. Its `memberMessage` and `memberJoined` options declare `subject`. Its code narrows with `requireSubject` only on those paths. |
| `blocks/quietTimeout.ts:60-73` | The `memberMessage` option declares `requires: ['subject']`. |
| `executor.ts:526` snapshot | Leave out `userId` when there is no subject (the same spread as `channelId`). |
| `engine/messageWaitIndex.ts` | `MessageWaitPark.userId` becomes optional. `record()` still always deletes the run's old entry first (it runs on **every** park, Delay included). Only **after** its `eventKind === 'message'` check does it throw a named programming error when `userId` is missing. Leave the three call sites as they are: `executor.ts:553`, and `flowRunResume.ts:360` (release) and `:575` (re-park). In `rebuildMessageWaitIndex`'s `addMissing` (`:143-149`), catch per run, so that one bad row is logged by run id and the rest still load. Today a throw there aborts the whole rebuild. |
| `flowRunResume.ts:75-93` `rebuildResumeContext` | No stored `userId` → no member fetch, and `subject: undefined`. A stored id that fails to fetch keeps today's "no longer in guild" failure. |
| `waitingRunDispatch.ts:56`, `flowChoiceDispatch.ts:99`, `messageWaitDispatch` | No code change. A run with no `userId` never matches, which is correct, and validation keeps such runs from parking there. One comment each saying so. |
| `flowRunScheduler.ts:278-286` quiet window `who: 'member'` with no `userId` | Unreachable once the option declares `subject`. If it is reached, **end the run terminally** with a named reason, using the resume path's fail outcome. Don't throw: the tick catches a throw and leaves the run parked, so it would be retried every 15s forever while holding a slot in the due batch. |
| `engine/triggeredRun.ts` | `startTriggeredRun` is documented "Never throws", so type the flood-limit case away. Make `TriggeredRun` a union: `{ seed: SetRequired<FlowRunSeed, 'subject'>; limit: … }` or `{ seed: FlowRunSeed; limit?: never }`, so that the narrowing on `limit` compiles. |
| `copyRendering.ts:83-94` | The six `subject.*` resolvers return `undefined` when there is no subject. Write two failure messages (`:186-191`), one per namespace: an actor lost after a wait, and a subject absent because the trigger has nobody. |
| `data/flowRunsSchema.ts:33`, `flowRunsRepo.ts:145` | `userId` becomes optional in the interface and the Zod schema together (the `Equals` guard at `:182-200` enforces this). No SQL change, since it is a JSON member. |
| `constants.ts:177` | `FLOW_RUN_ENTITY_VERSION` 5 → 6, because older code would refuse a row with no `userId`. Add an empty marker migration, as `2026-10-03-Record_Flow_Run_Chain_Depth.ts` did. |

**Vocabulary gate:** it's an allowlist. `nobody`, `memberless`, `timer` and `clock` aren't
on it. Name things after the absence instead: `subject`, `absent`, `optional`, `from`,
`trigger` and `requirement` are allowed.

### Save-time refusal (`engine/graphValidation.ts`)

- **Effective requirements live in one function**, used by the validator and the executor.
  It reads the block's `requires`, the `requires` of each picked option in visible fields, and
  the requirement of each built-in token in visible copy fields and `objectList` copy columns.
  Reuse `checkCopyTokens`' traversal (its `isFieldVisible` skip and column handling at
  `:539-545, 595-620`) rather than writing a second walk that could skip either.
- Remove `Exclude<…, 'subject'>` (`:650`). Add a `subject` entry to `CHECKED_REQUIREMENTS`:
  - no `afterParking`, because resume re-fetches the member;
  - from-trigger message: "it can be reached from a trigger whose runs are about nobody";
  - advice: "Remove it, or start this path from a trigger about a member."
- **Rename the `fromGateway` key** to `fromTrigger`, since the trigger lacking a requirement
  is no longer always a gateway event. **Keep the existing message texts.**
  `executor.test.ts:404` asserts `/happens in no particular channel/`.
- `checkContextRequirements` iterates effective requirements instead of `block.requires`.
  Report what caused it. A block's own requirement reads as it does today. An option names the
  field and the option's label. A token names the token.

### Builder (`web/src/`)

- `api/types.ts` mirrors the new `BlockConfigOption.requires` and the token requirements.
  The drift gates must cover them. **`nodeDescriptorDrift.test.ts:143-144` samples `select`
  and `segmented` with `options: []`, so an option-level member would drift unnoticed.** Give
  those samples an option carrying `requires`.
- `flows/builtinTokens.ts`: replace `lostAfterSuspend` with the mirrored requirement, held by
  `builtinTokenDrift.test.ts`.
- `flows/variables.ts`: replace `actorAvailableAt` with `requirementAvailableAt` as decided
  above. Thread the availability through `FlowBuilderPage.tsx:1628-1634` (where
  `actorAvailable` is computed today), `NodeInspector.tsx`, `controls/types.ts`,
  `TextControls.tsx` and `VariablePicker.tsx`.
- **Select and segmented controls** disable an option whose requirement is unavailable at the
  node, and say why on hover. A value already picked stays visible, with the server's issue
  beside it.
- **Palette** (`NodePalette.tsx`): when the flow has at least one trigger and none of them
  declares `subject`, non-trigger blocks whose own `requires` include `subject` are greyed. They
  can't be dragged or clicked, and show the tooltip "Needs a member — this flow's runs are about
  nobody." Triggers are never greyed. A mixed flow leaves the palette unchanged.
- **Canvas:** `useFlowIssues` also asks for a re-check after structural edits, debounced. It
  takes only the newest answer, as it already does.

### Docs

- `docs/contracts/block-authoring.md:531, 545`: `subject` can be absent. On a trigger, leaving
  `subject` out of `requires` means its runs are about nobody. An option can declare
  `requires`. A block reads the subject through `requireSubject`.
- `AGENTS.md`: one line on the flows bullets saying a trigger without `subject` starts runs
  about nobody.

### Tests

- **A test-only trigger fixture** with `requires: []` and no `startedBy`. Use the existing
  mechanism:
  - `vi.mock('../blocks/registry')` wraps `ensureBlocksDiscovered` and `getBlockDefinition`
    with `discoverBlocks(FIXTURE_ROOT)` (`src/features/flows/__tests__/runStartTime.test.ts:30-44`);
  - put the fixture under `src/features/flows/__tests__/fixtures/blocks/<dir>/`;
  - drive it with `executeFlow` directly.
- **Validation:**
  - each refused case on a path from the fixture trigger: a subject block, `{{subject.*}}` in a
    copy field and in an `objectList` column, the quiet-timeout `memberMessage` option, Time
    Since's member sources, Wait For Event, and Prompt;
  - Time Since with `channelMessage` is accepted;
  - the same graphs are accepted from a member trigger;
  - a mixed graph refuses only the nodes the memberless trigger reaches;
  - `{{actor.mention}}` after a park is now refused, and before a park from a member trigger it
    is accepted.
- **Executor:** a node reached at runtime without its requirement fails by name. Sabotage it:
  remove the check, and a named test fails.
- **End-to-end:** fixture trigger → Send Message → Delay → Send Message, through park and
  resume, with no `userId`.
- **Resume:** a snapshot with no `userId` resumes with no subject and never calls
  `members.fetch`. A snapshot whose `userId` fails to fetch still fails as "left".
- **Rendering:** one `renderCopy` test per `subject.*` token with no subject, expecting the
  subject-absent failure, not the text "undefined".
- **Message wait index:**
  - a Delay park with no `userId` records nothing and doesn't throw;
  - a message-wait park with no `userId` throws;
  - one bad row during rebuild doesn't stop the others.
- **Repo:** a row without `userId` round-trips, and `FLOW_RUN_ENTITY_VERSION` is 6.
- **Builder** (dom project, hand-built descriptors; the e2e harness serves the real registry):
  - the palette greys on an all-memberless flow, but not triggers, and not on a mixed flow;
  - `subject` chips are greyed;
  - a member option is disabled;
  - a structural edit asks for a re-check;
  - an unconnected Assign Role on an all-memberless flow isn't greyed by availability.
- **Sabotage-verify:**
  - drop the `subject` entry from `CHECKED_REQUIREMENTS`;
  - make resume fetch on an absent id;
  - skip option requirements in effective requirements;
  - remove the executor check.

  Each must turn a named test red.

### Hazards for the implementer

- **Nothing in Vitest typechecks.** The baseline is recorded in
  `reports/tsc-baseline-root.txt`: 17 errors, none under `src/features/flows`. The web project
  has 0. At the end, `pnpm exec tsc --noEmit -p .` must show no new errors, and so must
  `pnpm exec tsc --noEmit -p web`.
- `blockConformance.test.ts:41` drives every block with `subject: {}`. Leave that as it is.
- The `Equals` guard in `flowRunsRepo.ts:182-200` fails to compile unless the interface and
  the Zod schema change together. That is intended.
- SQLite runs in CI and Postgres in production. The marker migration must be valid on both.
- The branching gate forbids lists of block types outside their own directories, and the
  cross-block import gate stops `engine/` importing `blocks/quietTimeout`. Everything above is
  declared on the block, option or token, so neither should trip.
- Run tests with `--maxWorkers=4` if the machine is busy.
- Never commit. Leave `reports/` and `docs/plans/sdk-generation-handoff.md` alone.

## Out of scope for this step

- A "message from anyone in a channel" wait mode, or a Prompt anyone may answer. Each needs a
  real flow asking for it first.
- Any product trigger. The fixture is test-only.
- **The eligibility `subject` principal** ("only the person it's about"). Only two things
  evaluate it. A button-click trigger supplies the presser as the subject. Prompt now requires a
  subject, so it can't be on a path about nobody. A run about nobody therefore never reaches it,
  and if one did, it would refuse everyone, which is the safe answer.

## Step 2 — a server time zone

> **Status**: Built 2026-10-04, committed with step 1 in `ca254c8`, not run on a real guild.
> **Ship it with step 1, or after it.** Both migrations are dated 2026-10-04, and step 2's sorts after step 1's. Kysely
> refuses a pending migration that sorts before one already applied, so deploying step 2
> alone and step 1 later would stop the bot from starting. The Postgres arm has not been run.

### Decisions made while building

- **Validate canonically, store the operator's spelling.** Node turns `Europe/Kyiv` into
  `Europe/Kiev` and `Asia/Kolkata` into `Asia/Calcutta`, so the validation canonicalises first.
  What gets stored is what the operator picked, trimmed. The canonical name is stored instead
  only when the two differ in letter case alone (`utc` → `UTC`).
- **The note reads "using Pacific Time"**, derived from `defaultTimeZone`, not hardcoded.
- **One insert-or-update on `guild_id`**, replacing read-then-write. With two Save buttons,
  two first saves at once used to fail on the unique index.
- **Each card merges only the fields it owns** into the page state, so an out-of-order
  response can't bring back the other card's old value.
- **A saved zone the browser's own tz data doesn't know** is labelled "(offset unknown in this
  browser)" instead of crashing the page.
- **`GuildSettings` joins the wire-shape drift gate** (`GUILD_SETTINGS_KEYS`).

### What the operator gets

- **The Server Settings page gets a Time zone picker.** It's searchable, and each zone shows
  its current offset, for example "America/New_York (UTC−04:00)".
- **Until someone picks one, the page asks for it:** "Not set: using Pacific until you pick
  one." Once a zone is picked, the note goes away.
- Nothing uses the time zone yet. Step 3's Schedule trigger is the first consumer, and it
  repeats the ask beside its time field, with a link to the setting.

### Decisions (Douglas, 2026-10-04)

- One time zone per server, in the server's configuration.
- **Unset means Pacific** (`America/Los_Angeles`, the bot's existing default). The dashboard
  asks the operator to pick one until it's set.

### Decisions made in planning

- **The ask lives where the setting is used, not in a dashboard-wide banner.** Today that is
  the Server Settings page; in step 3 it is also the Schedule trigger. A banner on every page,
  for a setting nothing reads yet, would be a warning on the normal case.
- **Its own default constant**, `DEFAULT_GUILD_TIME_ZONE` in
  `features-system/guild-settings/constants.ts`. Not `BIRTHDAY_TIMEZONE`: that one is
  birthday-owned and overridable by env. Whether birthdays and leveling should read the server
  zone too is out of scope.
- **No "unset" action.** Once picked, a server changes its zone but never goes back to "not
  set". Nothing needs that.

### Changes

- **Migration:** a nullable `time_zone` text column on `guild_settings` (an IANA name; null
  means not set). Valid on SQLite and Postgres. Follow the column-naming convention the table
  already uses.
- **Schema:** `GuildSettingsTable.timeZone: string | null`.
- **Repo** (`guildSettingsRepo`):
  - `getTimeZone(guildId)` returns `{ chosen: string | null; effective: string }`. Step 3
    reads `effective`.
  - `setTimeZone(guildId, timeZone)` writes **only** that column, creating the row if needed
    (with `staffRoleIds` `[]`).
  - `setStaffRoleIds` must not touch `time_zone`. This is the ticket-config clobber lesson,
    and it gets a test both ways.
- **Validation:** a zone is valid when `Intl` accepts it. Use membership in
  `Intl.supportedValuesOf('timeZone')`, plus `UTC`, which some runtimes leave out of that
  list. Store the canonical spelling.
- **Routes** (`src/web/api/guildRoutes.ts`):
  - `GET /:guildId/settings` adds `timeZone: string | null` and `defaultTimeZone: string`.
  - **New `PUT /:guildId/settings/time-zone`** with body `{ timeZone }`. It's separate from
    the staff-role PUT, so neither form can wipe the other.
  - An invalid zone is a 400 with a persona-appropriate message.
- **Web:**
  - `api/types.ts` `GuildSettings` gains the two fields;
  - `api/config.ts` gains `updateGuildTimeZone`;
  - `ServerSettingsPage.tsx` gains the picker (Mantine searchable `Select` over the browser's
    `Intl.supportedValuesOf('timeZone')`) and the not-set note. Save follows the page's
    existing pattern.
- **Tests:**
  - repo round-trip;
  - the clobber guard both ways (sabotage it: make `setStaffRoleIds` write the whole row, and
    a named test fails);
  - the route refuses an invalid zone and accepts `UTC`;
  - GET on a guild with no row;
  - a dom test for the not-set note appearing and then going after a save.
- **Branch note:** `feat/web-sdk` replaces the hand client. The new route and fields must be
  carried into its spec when it rebases.

## Step 3 — the Schedule trigger

> **Status**: Built 2026-10-04, not committed, not run on a real guild. The plan was
> reviewed (coverage and repo grounding) before the build. The migration's Postgres arm has
> not been run; it is dated 2026-10-05, so it sorts after step 2's.

### Decisions made while building

- **"Every so often" defaults to Every hour.** The plan gave `time` and `days` field
  defaults and none for `every`; without one, switching a node to "Every so often" left it
  unsaveable until something was picked. It is a field default only, like `time`'s, since a
  field `visibleWhen` hides must stay optional in the schema.
- **A Schedule node whose settings stop parsing keeps its row, with no next time.** Rows go
  only with their node or flow, and the row may be the only link to a run it started that is
  still parked. No row is created for one that never parsed. Either way it is logged.
- **A card-summary part's `visibleWhen` sits on the field-reference arm only.** Nothing needs
  a literal part shown by a choice yet. Its rules are the field ones, through one shared
  conformance check (`checkVisibleWhenSource`).
- **Card-summary parts are now drift-gated** (`BLOCK_CARD_SUMMARY_PART_KEYS`, one list per
  arm). There was no gate for their members before, so `visibleWhen` would have drifted
  unnoticed. The next-runs body joined the flow wire-shape gate (`FLOW_NEXT_RUNS_KEYS`).
- **`FlowRunResult` always says `parked`** (a boolean), beside the new `runId`.
- **`startFlowRunScheduler` takes only the dependencies it should replace**, merged over the
  defaults, so `initFlows` passes just `{ onTick: fireDueSchedules }`.
- **`deleteByFlowId` reads the guild inside its transaction, and tells no one when there was
  no flow.** It used to tell every callback even for a missing row. `update` now tells after
  reading the row back.
- **Reconcile never throws.** A failure is logged and the next write, zone change or restart
  tries again, so none of the three callers needs a catch of its own, and the time-zone PUT
  answers 200 either way.
- **A key mismatch at fire time reconciles with the fire's own clock reading**, so the fresh
  next time is worked out from the same "now" the fire used.
- **The missing-`flow_schedules` message is said once per process**, not every tick, by
  firing and by reconcile alike (`reportMissingTableOnce` in
  `features-system/data-persistence/missingTable.ts`, beside `isMissingTableError`).
- **"Every so often" can't jump past a mark on the far side of a gap.** A jump that crosses a
  clock change is pulled back to the change. Without that, every 2 hours from 2:00 AM across
  Helsinki's 3 → 4 AM change would read 5 AM and miss 4 AM. Tested.
- **The time picker shows empty parts for an unset value**, rather than the default as the
  choice controls do: a time drawn that the node does not hold is one the save would refuse.
  Nodes are seeded with `09:00` on drop and backfilled on load, so this is rare.
- **The zone ask reads "Not set: using Pacific Time until you pick one in Server Settings."**
  The default zone's name comes from the same helper the Server Settings card uses.
- **The browser's day list is held to conformance** by a test that builds a schema from
  `DAYS_OF_WEEK` (`web/src/flows/clockValues.ts`) and requires conformance to accept it.
- **A node the saved flow does not have shows no countdown.** The card only shows what the
  server listed, and it cannot know that an unsaved node would be scheduled.
- **The once-a-minute refresh** checks every minute while the server listed anything, and
  asks again only once a listed time has passed.
- **Past a day away, the countdown counts days** ("Next run in 3 days").
- **The dashboard e2e boot reconciles after flow writes**, as `initFlows` does in production.
- **`deleteByIds` instead of `deleteExcept`.** Reconcile already holds every row it read, so
  it picks the rows whose node or flow is gone and deletes them by id. A "keep these" clause
  grew one `OR` per schedule.
- **A row that no longer matches its node is taken off the due list before the reconcile.**
  Its next time is set to none (conditionally, like any advance), and reconcile then gives it
  the right one. Otherwise a reconcile that kept failing would retry the row, and log, every
  15 seconds while holding a slot at the front of the batch.
- **A guild Discord reports unavailable is skipped like one the bot left.** It is cached
  during an outage, and a run there could only fail.
- **The missing-table check matches each dialect's exact wording.** Postgres names the table
  in a missing-*column* error too (`… of relation "flow_schedules" does not exist`), and the
  schedule tick says the missing table once and then goes quiet.
- **The countdown is cleared before it is asked for again** after a save or a toggle, so a
  card never counts down to a time from before the change.
- **Accepted, not closed: a small window where a parked run loses its schedule link.** The run
  parks (its row is written) before `last_run_id` is saved. A crash in between, or a failed
  `setLastRunId` (logged), lets the next time overlap that run.
- **A resolved schedule, not a config with optional members.** `resolveSchedule` in the block
  narrows a parsed config to a `ResolvedSchedule` union (daily / days / interval, each with
  only its own fields) and throws once for one that skipped the schema; `scheduleKey` and
  `nextScheduleTime` switch exhaustively on it. The key keeps its member order and its
  `null`s, so keys written before this are unchanged.
- **Schedule nodes are selected by the block's type, not by `scheduleDue`.** Every node read
  is parsed with this one block's schema, so selecting by source would hand it any other
  block that ever declared the source. Simpler than a conformance rule that at most one block
  may declare it.
- **A fire that throws takes its row off the due list.** If the row still holds the time the
  tick read, it is conditionally set to no next time and logged with its flow and guild —
  a stored graph that no longer reads would otherwise retry every 15 seconds at the head of
  the batch. A save or a restart reconciles it back. A mismatch whose reconcile fails was
  already covered: the row is set to no time before the reconcile runs.
- **Reconcile says a missing `flow_schedules` table once**, through the same
  `reportMissingTableOnce` firing uses, which lives with `isMissingTableError` in
  `features-system/data-persistence/missingTable.ts`.
- **One wiring function, `registerScheduleReconcile`**, called by `initFlows`, the dashboard
  e2e boot and the next-runs route test.
- **`isLiveRunStatus` in `data/flowRunLifecycle.ts`** decides skip-while-running, as an
  exhaustive switch. `live` joined the engine vocabulary's generic list, with its reason.
- **The seven day keys are declared once, as `BLOCK_DAY_KEYS` in `blocks/manifest.ts`.** The
  `daysOfWeek` arm's default is typed by them, the block's enum and the conformance probes
  use them, and the browser mirrors them under the vocabulary drift gate (which replaced the
  conformance test that read the browser's list). `DAY_KEYS` passes the engine vocabulary
  gate because `day` is shorter than the words it reads, and these are a control's stored
  values, not a concept the interpreter reasons about.
- **The builder's countdown lives in `useFlowNextRuns`**, which owns the next times, the
  saved node configs, the request counter, the reset on another flow and the minute poll;
  the page keeps the call sites (open, save, toggle).
- **Unparseable Schedule nodes are only warned about on switched-on flows.** On a switched-off
  flow it is work in progress.
- **Branch note:** `feat/web-sdk` must carry into its spec, when it rebases, the next-runs
  route and `FlowNextRuns`, the `timeOfDay` and `daysOfWeek` controls, the `scheduleDue`
  source, `BLOCK_DAY_KEYS`, and a card-summary part's `visibleWhen`.

### What the operator gets

- **A Schedule trigger in the palette.** It starts the flow:
  - **every day** at a time;
  - **on certain days** at a time (pick any of Mon–Sun);
  - **every so often**, from a fixed list lined up with the clock: every 15, 20 or 30 minutes,
    or every 1, 2, 3, 4, 6, 8 or 12 hours. "Every 30 minutes" fires at :00 and :30; "every 6
    hours" fires at midnight, 6 AM, noon and 6 PM. All times are server time.
- **"9 AM and 5 PM" is two Schedule triggers on one flow.** Nothing limits a flow to one
  trigger, and every trigger node gets its own schedule.
- **The time picker shows a 12-hour clock** (hour, minute, AM/PM) and says which zone it's in:
  "Server time: America/New_York". If the server hasn't picked a zone, it asks, as Server
  Settings does: "Not set: using Pacific until you pick one", with a link to Server Settings.
- **The card on the canvas** reads "Every day at 9:00 AM", "Mon, Wed, Fri at 9:00 AM" or "Every
  30 minutes".
- **A next-run countdown on the card**, small and muted: "Next run in 3 hours". Hovering shows
  the exact time in server time. It's only shown for a saved schedule on a flow that's switched
  on. When the card's schedule has unsaved edits, it says "Next run is worked out when you
  save" instead.
- **What fits below it:** a scheduled run is about nobody, so the builder greys member blocks
  and `{{member…}}` / `{{actor…}}` tokens below it. Step 1 built that; this is the first
  shipped trigger to use it. Blocks that pick their own channel (Send Message, Post Embed) work.

### Decisions (Douglas, 2026-10-03/04)

- A scheduled run is about nobody.
- Repeat shapes: every day, on chosen weekdays, or every N minutes/hours. Not monthly, not
  one-off.
- One time zone per server (step 2), no per-schedule zone.
- **Missed while the bot was down: run once when it's back,** however many times were missed.
- **"Every N" is lined up with the clock** and picked from a fixed list, not any number.
- **The shortest gap is 15 minutes.** The fixed list starts there; there is no other limit.
- **One run per schedule at a time.** When it's time again and the last run from this schedule
  is still going (parked on a delay, say), this time is skipped and the skip is logged.
- **Switching a flow off and on starts fresh from now.** Times passed while it was off don't
  run. "Run once when back" only covers the bot being down.
- **Show when the next run is,** somewhere unobtrusive but useful (Douglas's addition). It goes
  on the trigger's card on the canvas.
- **Times are shown on a 12-hour clock** (9:00 AM).

### Decisions made in planning

- **Every schedule row has a key: its saved settings plus the server's effective time zone.**
  - The key is built only from the fields visible for the chosen `repeat` (`repeat`, `time`,
    `days`, `every`) and the zone.
  - `days` is sorted Mon–Sun by the schema, so picking the same days in another order, or a
    deploy that adds a field or default, doesn't change it. A changed key would silently drop
    the missed-while-down catch-up, and deploys are exactly when the bot is down.
  - A new schedule, a changed schedule, and a changed server time zone each get a fresh next
    time from now. A flow edit that doesn't touch the schedule keeps its next time.
- **A switched-off flow keeps its rows, with no next time** (`next_run_at` null: never due,
  never shown). Switching back on gives a fresh next time from now and **keeps `last_run_id`**.
  - Switching a flow off doesn't stop its parked runs (`flowRunResume.ts` only checks that the
    flow exists). `flow_runs` stores no trigger node, so the row is the only link to a parked
    run.
  - Deleting the rows would let a run started after switching back on overlap one still parked
    from before.
  - Rows are deleted only when their node or their flow is removed.
- **When the clocks change** (server zone, `Intl`-computed):
  - **A daily or weekday time fires once per local day.**
    - The algorithm: walk local dates from the date of `after`. Resolve each eligible date's
      `HH:MM` to exactly one instant: a skipped time moves forward by the gap (2:30 AM →
      3:30 AM), and a repeated time takes the first (1:30 AM PDT). Return the first instant
      strictly after `after`.
    - Never "the next instant whose wall clock reads 01:30". That fires twice on fall-back,
      because the first fire advances from a `now` between the two 01:30s.
  - **"Every so often" fires whenever the wall clock reads a time where
    `(hour × 60 + minute) % N === 0`.**
    - So hourly runs twice through a repeated hour, and a skipped hour doesn't run.
    - It's a wall-clock match, not "midnight + k·N". That matters in zones whose clock change
      skips midnight (America/Santiago).
  - Weekdays are read with `formatToParts` in a fixed `en-US` locale, `weekday: 'short'`.
- **Any minute is allowed** in the time picker (00–59), not 5-minute steps. Stored as 24-hour
  `HH:MM`; shown 12-hour.
- **The week in the picker starts on Monday,** so Mon–Fri sits together.
- **Drafts never schedule.** Only the saved flow (the `flows` row) counts. A draft write doesn't
  go through `flowsRepo`, so it never touches schedules.
- **A guild the bot is no longer in:** its due rows still advance, with a log line, and never
  start a run. They're kept, so the schedule picks up again if the bot is re-added and the flow
  is still on. Deleting the flow removes them.
- **A stored zone `Intl` rejects** (only possible if the runtime's time zone data changes, since
  step 2 validates on write):
  - reconcile gives that guild's rows no next time and logs an error naming the guild and zone;
  - a due row whose next time can't be worked out, at fire time, gets `next_run_at` null with a
    named log line, so it isn't retried every 15 seconds;
  - this fails loudly, and nothing falls back to Pacific quietly. The countdown shows nothing
    for those cards.
- **A failed reconcile is not retried on a timer.** It's logged. The next flow write, zone change
  or restart reconciles again. Firing guards the gap: it checks the trigger node still exists
  and that its current key matches the row's. If not, it skips and reconciles that guild.
- **The time-zone PUT still answers 200 when its reconcile fails.** The zone is saved; the
  failure is logged.
- **Scheduled runs execute inline in the shared tick,** like resumes. A long run delays the next
  resumes and fires. That's accepted at this scale and documented in the code.
- **No per-guild cap on schedules.** The 15-minute floor is the guard. Each fire is one run,
  and skip-while-running stops a pile-up.
- **Not held by the activity backfill.** A run about nobody can't park on a message (Wait For
  Event needs a subject), so `isBackfillPending` doesn't hold it.
- **At most once, not at least once.** A fire advances the row's next time **before** starting
  the run. If the bot crashes mid-run, that time doesn't run again.
- **The trigger supplies no variables.** Nothing needs one yet; "when it fired" is `startedAt`,
  which Time Since already reads.

### Changes

#### The block — `blocks/triggerSchedule/`

- **Type:** `trigger.schedule`; `kind: 'trigger'`; `group: 'triggers'`; `requires: []`;
  `capabilities: []`; `canSuspend: false`; `run` returns `{ kind: 'continue' }`;
  `handles: [{ label: 'Then', … }]` like the other triggers; no outputs.
- **New trigger source.** It goes in `BLOCK_TRIGGER_SOURCES` (`blocks/manifest.ts:76-84`) and
  the web mirror (`web/src/api/types.ts:168-178`); `nodeDescriptorDrift.test.ts` already gates
  the pair.
  - The doc above the list (`manifest.ts:37-75`) asks that a source name something that
    happened, so call it `scheduleDue` ("a schedule came due"), not `schedule`.
  - Update the doc comment and the `startedBy` row in `block-authoring.md:78`.
- **Config schema:**
  ```ts
  repeat: z.enum(['daily', 'days', 'interval']).default('daily')
  time:   z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()   // visibleWhen repeat ∈ daily, days
  days:   z.array(z.enum(['mon','tue','wed','thu','fri','sat','sun'])).min(1).refine(unique).optional()
                                                                         // visibleWhen repeat = days
  every:  z.enum(['15m','20m','30m','1h','2h','3h','4h','6h','8h','12h']).optional()
                                                                         // visibleWhen repeat = interval
  ```
  - A `superRefine` requires each field that's visible for the chosen `repeat`, using the
    `checkWhere` pattern from `triggerMessageSent`. Hidden fields must be optional in the
    schema (conformance `checkVisibleWhen`).
  - Uniqueness uses `.refine()`. `uniqueItems` fails `fieldChecks.test.ts`.
  - `days` is sorted into Mon–Sun order by a `.transform()` after validation, so the key
    doesn't depend on click order. Check the JSON Schema export the browser checks use still
    accepts this.
  - `time` has a field default of `'09:00'`, and `days` defaults to Mon–Fri. Conformance checks
    defaults against the schema.
- **Fields:**
  - `repeat` is a `select` with labels "Every day", "On certain days" and "Every so often";
  - `time` is the new `timeOfDay` control;
  - `days` is the new `daysOfWeek` control;
  - `every` is a `select` labelled "Every 15 minutes" … "Every hour", "Every 2 hours" … "Every
    12 hours".
- **Card summary** reads "Every day at 9:00 AM" / "Mon, Wed, Fri at 9:00 AM" / "Every 30
  minutes".
  - **The current parts can't build this.** `repeat` is never hidden, and `resolveValue` always
    renders its label (`cardSummary.ts:110-116`), giving "On certain daysMon, Wed…".
  - **So a card-summary part gains an optional `visibleWhen`**, with the same shape and the same
    one-level rules as a field's. It's generic, mirrored on the web, conformance-checked
    against the source field's offered values, and drift-gated with the other summary members.
  - The parts:
    - `repeat` (visibleWhen `daily`), showing "Every day";
    - `days`;
    - `time`, with prefix `' at '`;
    - `every`.
- **The time math** is a pure module in `logic/` (e.g. `logic/scheduleTimes.ts`), never
  `engine/`: `nextScheduleTime(config, timeZone, after: Date): Date`, strictly after `after`.
  - It imports the schema type from `../blocks/triggerSchedule`, as
    `logic/ticketEventDispatch.ts:4` does.
  - **Not inside the block directory.** The block-dependents check (`blockTypeBranching.test.ts`)
    only matches imports ending at `blocks/<dir>`, so a listed file importing
    `blocks/triggerSchedule/<file>` fails it.
  - No date library is in the repo. Use `Intl.DateTimeFormat(…, { timeZone, hourCycle: 'h23' })
    .formatToParts` with cached formatters. `birthdayCelebration.ts:30-70` is the nearest prior
    art (it has no minute and no weekday).
  - Implement the clock-change rules from "Decisions made in planning" exactly.
  - It throws a `RangeError` for a zone `Intl` rejects. The caller logs it; there is no fallback.

#### Two new controls (server + web)

Both are generic, with nothing about schedules in them.

- **`timeOfDay`** stores `HH:MM` (24-hour). The web control has three parts, because Mantine
  is v7.17 with no `@mantine/dates`, and v7's `TimeInput` is a native input whose 12/24-hour
  format follows the browser:
  - an hour `Select` (1–12);
  - a minute `Select` (00–59, searchable);
  - an AM/PM `SegmentedControl`.

  Under it is the zone line: "Server time: <zone>". When the zone isn't chosen, the step 2
  wording is used instead: "Not set: using Pacific until you pick one". It links to Server
  Settings. The control owns this, because any time-of-day field is in server time.
  - **The zone reaches the control through `ControlContext`** (`web/src/flows/controls/types.ts:27-61`),
    not a fetch of its own; no control fetches today.
  - `FlowBuilderPage` fetches `GuildSettings` once. The wire fields are `timeZone` and
    `defaultTimeZone` (`web/src/api/types.ts:129-136`).
  - **Fetch it outside the `Promise.all` at `FlowBuilderPage.tsx:760-768`,** the way drafts are
    fetched (802-822), so a failed settings fetch can't block the builder. While it's missing
    or failed, the control shows no zone line.
- **`daysOfWeek`** stores an array of `'mon'…'sun'`. The web control is a `Chip.Group`
  (multiple) in Mon–Sun order.
- **Each control touches:**
  - `BLOCK_CONTROL_TYPES` (`manifest.ts:113-166`, web `types.ts:181-196`);
  - a `BlockConfigField` arm (union at `manifest.ts:309-511`, web `types.ts:313+`). The
    `daysOfWeek` arm needs its own `defaultValue?: readonly string[]` (see
    `manifest.ts:277-290`);
  - the web `BLOCK_CONFIG_FIELD_KEYS` (`types.ts:704-719`);
  - **a per-control conformance check** in `checkConfigFields` (`conformance.ts:757-762`), on
    the model of `checkVariableNameField` (671-699):
    - `timeOfDay`'s schema must accept `00:00` and `23:59`, and reject `24:00` and `9:00`;
    - `daysOfWeek`'s must accept each of the seven keys and reject anything else;
    - `conformance.ts` is under the vocabulary gate, so name these to pass or justify the words;
  - `renderControl.tsx` (its exhaustive `never` forces this);
  - `cardSummary.ts resolveValue`. `timeOfDay` renders "9:00 AM"; `daysOfWeek` renders "Mon,
    Wed, Fri", or "Every day" when all seven are picked;
  - `CONFIG_FIELD_FIXTURES` in `nodeDescriptorDrift.test.ts:163-191`;
  - the controls table in `block-authoring.md:262-282`, and the "other mirrors" table there.
- **The vocabulary gate covers `blocks/*.ts` at the top level.** Arm or interface names like
  `TimeOfDayField` may trip it, while string literal values aren't scanned. Prefer names that
  pass. Otherwise add the word to the gate's domain list with a one-line justification, as the
  gate asks.

#### Storage — `flows/data/flowSchedulesSchema.ts` + `flowSchedulesRepo.ts`

- **Table `flow_schedules`:**

  | Column | Holds |
  |---|---|
  | `id` | serial |
  | `guild_id` | text |
  | `flow_id` | text |
  | `node_id` | text |
  | `config_key` | text: the stable JSON of the parsed visible config plus the effective zone |
  | `next_run_at` | nullable timestamp: null means a switched-off flow or a time that can't be worked out |
  | `last_run_id` | nullable text: the `runId` of the last run this schedule started that parked |
  | `created_at`, `updated_at` | timestamps |

  - Unique `(flow_id, node_id)`; index on `next_run_at`; index on `guild_id`.
  - Follow the `flow_runs` / `flow_drafts` conventions for dates and FKs.
- **Migration:** `2026-10-05-Create_Flow_Schedules.ts`, with a postgres arm and a sqlite arm.
  - It must sort after `2026-10-04-Guild_Settings_Time_Zone`. A `2026-10-04-Create_…` file
    would sort before it, and Kysely would refuse it.
  - Register the table on `Database` and in `SqlDatePlugin` (`database.ts:34-117`).
- **Repo:**
  - `listForGuild(guildId)`;
  - `upsert(row)`, using `onConflict(flow_id, node_id)`;
  - `deleteExcept(guildId, rowsToKeep)`;
  - `findDue(now, limit)`: `next_run_at` not null and `<= now`, ordered by `next_run_at`;
  - `advance(id, readNextRunAt, nextRunAt)`: a conditional update returning whether it won.
    - Model it on `flowRunsRepo.deferWake(runId, readWakeAt, nextWakeAt)` (`flowRunsRepo.ts:557-564`).
    - Keep that function's note: exact timestamp equality had to be proven live on Postgres,
      and production runs Postgres;
  - `setLastRunId(id, runId)`;
  - `nextRunsForFlow(flowId)`.

  Keep column and identifier names inside the vocabulary gate:
  - `schedule`, `next`, `run`, `last`, `config` and `key` pass;
  - `weekday`, `hour`, `minute` and `timeZone` don't;
  - `expected` was deliberately renamed out of the engine (`engineVocabulary.test.ts:327-331`),
    and `keep` isn't listed. Parameters are scanned.
- **Unmigrated-table noise:** `isMissingFlowRunsTableError` (`flowRunScheduler.ts:336-341`) only
  knows `flow_runs`.
  - Generalise it into an exported predicate that takes a table name.
  - `fireDueSchedules` recognises its own missing `flow_schedules` table with it and logs once,
    so the engine's hook catch never names the table.
  - Otherwise an unmigrated table logs a stack trace every 15 seconds.

#### Reconcile — one function, three callers

`reconcileGuildSchedules(guildId)`, outside `engine/` (in `logic/`, beside
`ticketEventDispatch`), does this:

- Reads `flowsRepo.getByGuildId` and `guildSettingsRepo.getTimeZone(guildId).effective`.
- Builds the wanted set from **every** flow (on or off), each Schedule node (selected by
  the block's own type; see the build decisions), parsed with the block schema over
  `visibleNodeData`. A node that fails to parse is kept with no next time (its row, if it
  has one), and logged when its flow is switched on.
- **Inserts a new key** with `next_run_at = nextScheduleTime(config, zone, now)`, or null if
  the flow is switched off.
- **Leaves an unchanged key on a switched-on flow alone.** This is what makes a time missed
  while the bot was down fire once.
- **On a changed key,** recomputes from now and keeps `last_run_id`, so skip-while-running
  still holds across an edit.
- **A switched-off flow:** sets `next_run_at` null and keeps the row and its `last_run_id`.
- **A flow switched back on** (row has null `next_run_at`, flow is on): recomputes from now.
- **Deletes rows whose node or flow no longer exists.**
- **A zone `Intl` rejects:** sets the guild's `next_run_at` null and logs an error naming the
  guild and zone.
- **Serialised per guild** with an in-process promise chain, so two quick saves can't
  interleave. This is load-bearing: each reconcile deletes the rows it read whose node is
  gone, so a stale reconcile overlapping a newer one would delete rows the newer one created.

It's called from three places:

1. **After every flow write.**
   - `registerAfterWrite` passes nothing today (`flowsRepo.ts:70,102`). Widen `AfterFlowWrite`
     to receive `{ guildId }` and to return `void | Promise<void>`.
   - `tellAfterWrites` awaits the callbacks outside the transaction. It still logs, and never
     rethrows, a failure. That way the builder's post-save next-runs fetch sees the new rows.
   - `messageTriggerIndex`'s callback ignores the argument.
   - **`update` tells before it knows the guild** (`flowsRepo.ts:159-163` calls
     `tellAfterWrites()` before reading the row back). Move the call after the read and pass
     `saved.guildId`.
   - **`deleteByFlowId(flowId)` (282-289) has only the flow id.** Select the `guildId` inside
     its transaction before deleting.
   - Check `create` and `mutate` likewise.
2. **After the time zone changes:** the `PUT /:guildId/settings/time-zone` route
   (`guildRoutes.ts`) calls it after `setTimeZone`. Guild-settings itself stays feature-free.
3. **At startup:** `initFlows`' `ClientReady` handler (`initFlows.ts:150-152`) reconciles every
   guild in `client.guilds.cache` before it calls `startFlowRunScheduler`.
   - Each guild is isolated (one failure is logged and the rest continue).
   - Then the first tick can't fire before reconcile, and the engine needs no second hook.
   - This also covers flows written before this feature existed.

#### Firing — injected into the existing tick

- **The engine never names schedules.** `FlowRunSchedulerDependencies`
  (`flowRunScheduler.ts:15-26`) gains a generic extra-work hook, e.g. `onTick(client)`.
  `initFlows` wires in `fireDueSchedules`.
  - **Where it runs:** `runFlowRunTick` calls it **after the main try/catch, still inside the
    `isTickRunning` guard** (before the guard is released in `finally`), in its own try/catch.
  - **Not "after the due-runs loop".** The tick returns early when no parked run is due
    (`flowRunScheduler.ts:205-207`, the normal state) and when `flow_runs` is missing
    (228-238). A hook placed after the loop would almost never run.
- **`fireDueSchedules(client)`** (in `logic/`) handles up to `FLOW_RUN_POLL_BATCH_SIZE` due rows,
  each in its own try/catch. **It takes a fresh `new Date()` per row:** runs execute inline, so a
  `now` captured once goes stale, and a next time computed from it could already be past.
  1. Load the flow (`getByFlowId`). If the flow or the node is gone, the flow is switched off,
     or the node's current key differs from the row's, skip and reconcile that guild.
  2. **Advance first:** `advance(id, row.nextRunAt, nextScheduleTime(config, zone, now))`. If it
     loses, skip.
     - If the next time can't be worked out (an invalid zone), set `next_run_at` null with a
       named log line and skip, rather than leaving it due.
  3. Check the guild is in `client.guilds.cache`. If not, log and skip.
  4. **Skip while running:** if `last_run_id` is set and that run's status is `suspended` or
     `running`, log a skip line naming the flow and node, and stop here.
  5. Start the run with `startTriggeredRun({ flowId, graph, triggerNodeId, source:
     'scheduleDue', seed: { client, guild, variables: {}, chainDepth: FLOW_ROOT_CHAIN_DEPTH }
     })`. There's no subject, actor, channel or flood limit; the `TriggeredRun` union already
     allows exactly this.
  6. If the run parked, `setLastRunId(id, runId)`.
- **Surfacing the run id:**
  - `executeFlow` mints `runId` (`executor.ts:465`) but `FlowRunResult` doesn't carry it. Add
    `runId` to the result.
  - `startTriggeredRun` returns `Promise<FlowRunResult | undefined>` and still never throws.
    `undefined` means it logged a failure.
  - Existing callers ignore the result.
  - A result with `status: 'success'` from a parked run is told apart from a completed one by
    looking the run up. Better: have `executeFlow` say it parked, e.g. `parked: true`, rather
    than the caller guessing.
- **Whatever imports the block's schema** (reconcile, fire) goes in `DECLARED_BLOCK_DEPENDENTS`
  (`blockTypeBranching.test.ts:165-180`) with a reason.

#### Next-run countdown

- **Route:** `GET /:guildId/flows/:flowId/next-runs` returns
  `{ timeZone: string, nextRuns: Record<nodeId, string /* ISO */> }`.
  - `timeZone` is the effective zone the times were computed in, so the tooltip doesn't
    depend on a separate settings fetch.
  - Only rows with a non-null `next_run_at` appear, so it's empty for a switched-off flow.
  - Use the same auth and guild-mismatch 404 as the other flow routes.
- **Web:**
  - The fetcher goes in `web/src/api/flows.ts` (beside `getFlow`), with its type in
    `api/types.ts`.
  - **`FlowBuilderPage` fetches it:**
    - on load, outside the main `Promise.all`;
    - after a save that wrote the flow (not a draft save);
    - after a successful on/off toggle (`handleToggleEnabled`, `FlowBuilderPage.tsx:1409-1414`),
      which is its own request, not a save;
    - every 60 seconds while any shown time is in the past, so the countdown moves on after a
      fire, even when the row stays overdue for a while.
  - **`FlowNodeCard`** shows, for any node that has an entry, a muted line: "Next run in 3
    hours".
    - Its tooltip shows the exact time in the route's `timeZone`, on the 12-hour clock.
    - It ticks once a minute.
    - The new card field goes through `snapshot` (`FlowBuilderPage.tsx:234-261`) and the
      new-node data (717-721, 892-900) as well as the decorate pass (~1574-1616).
  - **The card never names schedules.** It shows an entry if one exists.
  - **Unsaved edits are compared per node, against the saved `flows` row.**
    - Not against `ac669ed`'s baseline: that one serialises the whole canvas and moves to the
      draft on a draft save (`useFlowDraftAutosave.ts:89-90, 229-235`).
    - Keep each node's saved data by node id: from `flow.graph` at load (760-792), and from any
      save that wrote the flow, never a draft.
    - Compare in the decorate pass. If a node's data differs (including when the flow opened
      onto the operator's own draft), the card shows "Next run is worked out when you save"
      instead of the countdown.
  - Relative wording: "in 3 hours", "in 12 minutes", "in less than a minute", "any moment now"
    once it has passed.

#### Docs

- `block-authoring.md`: the `startedBy` row (new source), the controls table (two controls),
  and the context-requirements section's example of a trigger about nobody.
- `AGENTS.md`: the flows "runs about nobody" line says "No shipped trigger does this yet".
  Replace that with the Schedule trigger and a line on the schedules path (reconcile → table →
  tick).
- This plan: build decisions and status.
- **`feat/web-sdk` carry note:** the next-runs route, the two controls and the new source go
  into its spec when it rebases.

### Tests

- **Time math** (table-driven, pure):
  - America/Los_Angeles daily 09:00 from before and after 09:00;
  - **exactly at a fire time gives the next one**;
  - weekdays Mon/Wed/Fri across a week wrap;
  - **Spring-forward (2026-03-08):**
    - daily 02:30 runs at 03:30 PDT;
    - with `after` = 03:15 PDT, the next run is 03:30 the same day;
    - with `after` exactly at 03:30, the next run is the next day.
  - **Fall-back (2026-11-01):**
    - daily 01:30 runs once, on the first;
    - **with `after` = 01:45 PDT, the next run is tomorrow's 01:30**, not 01:30 PST.
  - hourly across fall-back runs at 01:00 PDT and again at 01:00 PST; hourly across
    spring-forward goes 01:00 → 03:00;
  - every 6 hours lines up with local midnight;
  - every 20 minutes in Asia/Kolkata (+05:30) lines up with local :00/:20/:40;
  - an interval across America/Santiago's clock change, which skips midnight, follows the wall
    clock;
  - UTC;
  - an invalid zone throws.
- **Reconcile** (real sqlite, fake guild):
  - a new flow gets a row with the next time;
  - an unrelated edit keeps `next_run_at`;
  - **the same days picked in another order keep `next_run_at`**;
  - a schedule edit recomputes it;
  - switching off nulls `next_run_at` and keeps the row and its `last_run_id`;
  - switching on gives a fresh next time from now;
  - deleting the flow or removing the node deletes the row;
  - a zone change recomputes it;
  - **startup keeps an unchanged overdue row** (the catch-up);
  - an invalid zone nulls next times and logs an error;
  - an unparseable node is skipped;
  - `update` and `deleteByFlowId` tell the callback the right guild.
- **Firing:**
  - **a due schedule fires on a tick with zero due parked runs** (and when `flow_runs` is
    missing);
  - an overdue row missed several times fires **once** and advances past now;
  - each row's next time is computed from a fresh `now`, not one taken at the start of the tick;
  - a lost `advance` doesn't fire;
  - the last run `suspended` is skipped and logged; completed or absent fires;
  - **a run parked, then the flow switched off and back on: the next due time is skipped**;
  - a row whose next time can't be worked out gets `next_run_at` null and a log, and isn't
    retried;
  - a row whose key no longer matches the node reconciles instead of firing;
  - a guild missing from the cache advances and logs;
  - one throwing row doesn't stop the next;
  - the seed has no subject, actor or channel and starts at the root depth;
  - a run that parks records `last_run_id`;
  - startup reconcile runs before the scheduler starts.
- **Engine:** `executeFlow` returns `runId` and says whether it parked; `startTriggeredRun`
  still never throws.
- **Save refusal with the real block:** a Schedule trigger followed by a member block is refused
  with the step 1 wording. Send Message to a picked channel is accepted.
- **Conformance and drift:** the block passes conformance; the new source and both controls are
  in the drift gates; field checks hold (no `uniqueItems`).
- **Route:** next-runs returns entries for an enabled flow and is empty when switched off; the
  time-zone PUT reschedules (next time changes).
- **Web (dom):**
  - the `timeOfDay` control round-trips `HH:MM` through 12-hour parts (12:00 AM ↔ `00:00`,
    12:30 PM ↔ `12:30`);
  - the zone line, and the not-set ask with its link;
  - `daysOfWeek` order and toggle;
  - card summary strings, including a part's `visibleWhen`;
  - the countdown shows for a saved node, swaps to "worked out when you save" after an edit,
    and is absent with no entry;
  - it refetches after an on/off toggle;
  - a failed settings or next-runs fetch doesn't block the builder.
- **Conformance:** the `timeOfDay` and `daysOfWeek` checks each reject a schema that's too
  loose (sabotage: loosen the regex, and a named test fails).

### Hazards for the implementer

- **Vocabulary gate:** time words (`hour`, `minute`, `weekday`, `timeZone`, `day`) are refused
  in `engine/`, `data/`, `constants.ts` and `blocks/*.ts` (top level), and in
  `blocks/conformance.ts`. Keep the time math and reconcile/fire in `logic/`.
- **Midnight hours:** `Intl` `hourCycle: 'h23'`, never `hour12: false`. Some runtimes print
  `24` at midnight with `hour12: false`.
- **Draft writes must not reconcile.** Only `flowsRepo` writes do.
- **`tellAfterWrites` awaiting must stay outside the transaction.** SQLite has one connection,
  so a query inside a transaction from a callback deadlocks (see the
  sqlite-single-connection lesson).
- **Migration order:** the file is dated `2026-10-05`.
- **The `TriggeredRun` union** forbids `limit` without a subject. Don't widen it.
- **Ticket-config clobber lesson:** reconcile writes only the schedule table; nothing writes
  `flows` from here.
- **Don't run the backfill hold** on schedule fires.

### Out of scope

- Monthly, one-off, or custom-interval schedules.
- A countdown on the flows list page. The card is where the schedule is.
- Variables seeded by the trigger.
- Making birthdays or leveling use the server time zone.
- Running schedules on more than one bot process. There is one process; the conditional
  `advance` makes a second harmless, but it isn't designed for.
