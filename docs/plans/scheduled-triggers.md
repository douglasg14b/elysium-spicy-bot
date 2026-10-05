# Scheduled triggers — step 1: runs about nobody

> **Status**: Step 1 built 2026-10-04, uncommitted, not run on a real guild. The plan was
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
> Steps 2 and 3 are sketched at the end and get planned when they start.
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

> **Status**: Built 2026-10-04, uncommitted, not run on a real guild. **Ship it with step 1, or
> after it.** Both migrations are dated 2026-10-04, and step 2's sorts after step 1's. Kysely
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

## Sketch: step 3 — the Schedule trigger

- **Block:** `trigger.schedule`, with `requires: []`, so its runs are about nobody and have no
  channel.
  - Repeat shapes: every day at a time, chosen weekdays at a time, or every N hours or minutes.
  - The minimum interval is bounded by `FLOW_RUN_POLL_INTERVAL_MS` (15s); pick a sensible
    product floor (15 minutes?).
- **New trigger source** in `BLOCK_TRIGGER_SOURCES`, mirrored in `web/src/api/types.ts`.
- **When it fires next is stored as its own row**, not as a parked run, so `findDue` can't
  confuse the two. It needs a small table under `flows/data/`:
  - keyed by flow and trigger node;
  - rebuilt by a `FlowsRepo.registerAfterWrite` callback on every committed flow write;
  - ticked by the existing scheduler loop.
- **Times are computed in JS with `Intl`** in the server's time zone, never in SQL. Days when
  the clocks change must be tested.
- **Missed while down:** the startup sweep runs each overdue schedule once, then sets the next
  time from now.
- Runs start at chain depth 1, with no actor and no channel.
