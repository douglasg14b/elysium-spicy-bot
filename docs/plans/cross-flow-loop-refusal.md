# Step 2 of ticket triggers — refuse a loop between flows

> **Status**: Built 2026-10-05 on `feat/web-ui-flow-engine` (uncommitted); planned and plan-reviewed
> the same day. See [Decisions made while building](#decisions-made-while-building).
> **Follows**: [ticket-event-trigger.md](ticket-event-trigger.md) (step 1, the Ticket Event trigger). Its
> "Step 2 sketch" is the starting material; this plan supersedes it where they differ.
> **PRD**: [flow-engine-v2-journeys-and-provisioning.md](../prds/flow-engine-v2-journeys-and-provisioning.md)
> line 255 (cascades must be bounded)

## What the operator gets

- **A flow that would start a loop with other flows can't go live.** A loop is when one flow's
  action starts another flow, and that one (perhaps through more) starts the first again.
- **Checked whenever a loop could go live:** switching a flow on, and saving changes to a flow
  that's already on (those go live at once).
- **The refusal names every step of the loop**, in order, from the flow being saved and back to
  it. For example:

  > That would make a loop between flows: "Welcome" (Kick Member) starts "Goodbye" → "Goodbye"
  > (Close Ticket) starts "Ticket closed" → "Ticket closed" (Open Ticket) starts "Welcome" again.
  > Change one of them, or switch one off.

  A flow that would start itself reads `"Opener" (Open Ticket) starts "Opener" again.`
- **Nothing changes on a refusal.** The switch flips back. A refused save keeps the canvas
  unsaved, and the autosave keeps it as the operator's draft, as a refused save already does.

## Decisions (Douglas, 2026-10-05)

- **When:** on switching on, and on saving a flow that's on.
- **Only flows that are on count.** A loop through a flow that's off can't happen. It's caught if
  that flow is ever switched on.
- **The message:** every step of the loop.
- **A flow that would start itself is refused**, like any other loop. The depth cap of 5 isn't
  relied on.
- **Carried over from 2026-10-03:** over-refusal is accepted. "Member Leaves → Close Ticket" plus
  "Ticket Closed → Kick Member" is refused, although at runtime the second kick has nobody to
  kick.

## Decisions made in planning (not asked)

- **Open Ticket causes `opened` only, not `claimed`.** The sketch said "both, conservatively".
  The code doesn't need that:
  - Open Ticket passes `openerId: null` (`actionOpenTicket/index.ts:128`).
  - Auto-claim is `definition.autoClaimOnOpen ? input.openerId : null`
    (`tickets/ticketService.ts:118`), so a flow-opened ticket is never claimed.
  - Even a person's auto-claimed ticket announces only `opened` (`ticketService.ts:243`; the
    Ticket Event description says so).
- **What can start another flow today:** exactly three actions.
  - **Open Ticket** causes Ticket Event `opened`, of its picked type. The type is a fixed key:
    `ticketTypePicker` takes no `{{var}}`.
  - **Close Ticket** causes Ticket Event `closed`, of an **unknown** type. Its ticket is a
    `{{var}}` token (`actionCloseTicket/index.ts:40-46`), so it is linked to every Ticket Event
    `closed` trigger, whatever type filter that trigger has. This is accepted conservatism.
  - **Kick Member** causes Member Leaves (`member.kick()` reaches `GuildMemberRemove`, handled
    by `engine/memberLeaveDispatch.ts`).
- **Everything else causes nothing,** checked against every trigger:
  - **Bot posts** (Send Message, Post Embed, Prompt, the ticket state embed, level-up
    announcements) never reach Message Sent. They also earn no XP, so they can't reach Level
    Reached either. `toMessageActivity` drops `message.author.bot`
    (`features-system/activity/activityRecorder.ts:17`).
  - **Award XP** never sets off Level Reached. `awardFlowXp` calls `announceLevelUp`, never
    `notifyLevelUp` (`leveling/awardFlowXp.ts`).
  - **Reactions:** no block reacts, and bot reactors are ignored
    (`engine/reactionAddDispatch.ts:37`).
  - **Other sources:** Assign and Remove Role have no trigger to reach. Nothing causes a member
    join. Button clicks are people. Prompt's buttons resume their own run. Wait For Event and
    Delay park their own run.
  - **No block claims, unclaims, reopens or deletes a ticket.** Only people do (buttons,
    dashboard, mod modal), at depth 0.
- **Schedule** can never be in a loop, because nothing causes `scheduleDue`. That falls out of
  the model and needs no special case.
- **The loop graph is made of trigger nodes, not whole flows.** The dispatcher starts a run at
  one matched trigger node (`startTriggeredRun` with `triggerNodeId`; the executor walks from
  `triggerNodeId`, `engine/executor.ts:173,449-462`). So there is an edge from trigger T to
  trigger U when an action **reachable from T inside T's flow** causes what U listens for.
  - Flow-level edges would wrongly refuse a two-trigger flow whose paths never meet: "Member
    Join → Close Ticket" next to "Ticket Closed → Send Message" in the same flow is not a loop.
- **A trigger is identified by `(flowId, nodeId)`, never by node id alone.** Builder ids are
  `${type}-${Date.now().toString(36)}` (`web/src/pages/FlowBuilderPage.tsx:934`), unique only by
  timing, and test fixtures reuse ids like `trigger-1` across flows.
- **The check mirrors what runs.**
  - **A listening trigger** is selected with `isTriggerStartedBy`, and its **raw `node.data`**
    is parsed against its block's `configSchema`, as `matchingTriggers` does
    (`logic/ticketEventDispatch.ts:152-185`). A listener whose config doesn't parse matches
    nothing. That is ticketChanged's rule; `memberLeaveDispatch.ts:27` parses nothing, which
    agrees only because Member Leaves' schema is `z.object({})`. The generic rule assumes that
    every dispatcher means "parses or matches nothing", and the JSDoc says so.
  - **An emitting node** is parsed the way the executor parses it,
    `configSchema.safeParse(visibleNodeData(configFields, node.data))` (`engine/executor.ts:267`,
    `visibleNodeData` at `blocks/manifest.ts:904`). An emitter that doesn't parse causes nothing,
    because its run fails at that node.
  - **A node whose block type isn't registered** (a removed block in a stored flow) is neither a
    trigger nor an emitter. It must never throw: one stale flow would turn every save in that
    guild into a 500.
  - The check must never call a pair linked that the dispatcher wouldn't start, except where a
    value is unknown statically (Close Ticket's type).
- **Only loops through the flow being saved are refused.** A loop already live among other flows
  (only possible from before this ships) isn't this save's business.
  - Editing a flow that is itself already in such a loop is refused until one flow in it is
    switched off. That is loud by design, and no real guild has run ticket triggers yet.
- **Not checked:**
  - **Switching off.**
  - **Renaming.** A rename can't add an edge.
  - **Re-sending `enabled: true` to a flow that's already on,** with no graph.
  - **A save that lands as the saver's draft.** It doesn't go live.
  - **Saving a flow that's off.**
  - **The draft autosave routes,** which never touch the flow row.
- **Journey install is exempt, and the reason is written down.** `applyResourcesToFlows`
  (`logic/applyResourcesToFlows.ts:87-90`) writes graphs only and never enables a flow.
  - It writes a Discord snowflake into any `node.data` key that has a `*Key` companion
    (`logic/resourceTargets.ts:44-58`), whatever the field's control. So an API caller could make
    it write into `event` or `ticketType`.
  - A snowflake never equals an event kind or a ticket type key, so such a write can only
    **remove** edges. It can never add one.
- **The seed script checks too.** `templates/seedOnboardingFlow.ts` creates a flow already on.
  It already runs `flowReadinessIssues` first, so the loop check sits beside it. The template
  today causes nothing, so it can't fail, but every switch-on path asks the same question.
- **The race is accepted and documented.** Two PUTs on two different flows of one guild, landing
  together, each check against the other's old row and could both pass. A lock was considered
  and not taken:
  - It needs two operators closing the same loop from both ends within milliseconds.
  - What gets through is still bounded at runtime. A ticket chain stops at depth 5. A loop
    through Kick Member removes one member per lap.
- **No `graphology`.** The graphs are a few dozen trigger nodes. A breadth-first search from
  each of the saved flow's triggers in turn, back to that trigger, is a few lines. It returns the
  first loop found, which is the shortest one back to that trigger and keeps the message short.
  `hasCycle` (`engine/graphValidation.ts:844`) can't be reused:
  it answers yes or no inside one flow graph, and the message needs the path.
- **`emits` is server-only** (it goes in `NON_WIRE_MEMBERS`). Nothing in the builder reads it,
  so serving it would add a browser mirror and a drift fixture for nothing.
- **It lands on `feat/web-ui-flow-engine`, before `feat/web-sdk` rebases.** That branch rewrites
  `flowRoutes.ts` as OpenAPI routes (`decidePut` survives), changes `nodeRoutes.ts`, and deletes
  `web/src/api/flows.ts`. When it rebases it must carry:
  - the `decidePut` change;
  - `emits` left out of its OpenAPI node descriptor schema;
  - the refusal sentence in its generated client's docs instead of `flows.ts`.

  This list is added to the web-SDK memory's carry list.
- **The loop isn't a readiness issue.** It stays out of `flowReadinessIssues`, `POST /check` and
  the list's `issueCount`:
  - it's a conflict between flows, not a problem on one node;
  - its message names other flows;
  - a refusal *with* issues would lock the builder's switch (`storedIssueCount`), mark cards by
    node ids from other flows, and overwrite the list row's issue chip.

## Design

### 1. Blocks declare what they cause: `emits` (manifest contract)

A new **required** manifest member, on the footing of `requires` and `capabilities`. Required, so
the author of a future Reopen Ticket block has to decide; most blocks declare `[]`.

```ts
/** A value the caused event carries, compared against the listening trigger's field. */
type BlockEmittedValue =
    | { readonly value: string } // a literal, e.g. the event kind
    | { readonly fromField: string }; // the emitting node's own config value

interface BlockEmission {
    /** The trigger source this block's action fires. */
    readonly startedBy: BlockTriggerSource;
    /**
     * What the caused event is known to carry, keyed by the **listening trigger's** config
     * field. A field left out is unknown: it could be anything.
     */
    readonly carries?: Readonly<Record<string, BlockEmittedValue>>;
}

readonly emits: readonly BlockEmission[];
```

**The match rule** (generic: no block or source named) is that trigger node U listens to
emission E from node N when:

1. U's block `isTriggerStartedBy(E.startedBy)`, and U's config parses against its schema;
2. for every key k in `E.carries`, U's parsed `config[k]` is unset (`undefined`, `null` or `''`,
   meaning "any") **or** strictly equals E's resolved value at k. A `fromField` value resolves
   from N's parsed config; an unset one is unknown, and unknown matches;
3. a field of U's that E doesn't carry matches whatever it holds.

**Declarations:**

| Block | `emits` |
|---|---|
| Open Ticket | `[{ startedBy: 'ticketChanged', carries: { event: { value: 'opened' }, ticketType: { fromField: 'ticketType' } } }]` |
| Close Ticket | `[{ startedBy: 'ticketChanged', carries: { event: { value: 'closed' } } }]` (no type: see above) |
| Kick Member | `[{ startedBy: 'memberLeave' }]` |
| Every other block | `[]` |

- **The `JSDoc`** states the rule above. It cites the bot-author filter as why posting blocks
  declare nothing. It cites `awardFlowXp` as why Award XP declares nothing: "if that ever
  changes, it becomes an emission here".
- **Ticket words stay inside the block directories, as string literals.** `manifest.ts` gains
  only generic names.

### 2. Conformance (`blocks/conformance.ts`)

**Per block, inside `checkBlockConformance`** (declaration-only, as the contract promises):

- **`REQUIRED_ARRAYS`** gains `emits`. The "missing" probe works by adding `'emits'` to the
  existing required-member list (`blockConformance.test.ts:108-123`), not by writing a new probe.
- **A trigger declares `emits: []`.** A trigger is the event, not an action.
- **`fromField`** must name one of the emitting block's own `configFields`.
- **`fromField` must not name a field that can hold a `{{var}}`.** That means a field with
  `rendersTokens`, or a control that is a key of `PICKER_VALUE_KINDS` (`blocks/manifest.ts:779`;
  token rendering at `copyRendering.ts:351,452`).
  - Why: a written token compares unequal to everything, which would quietly drop a real edge.
    The right answer there is "unknown, so it matches".
  - Open Ticket's `ticketType` is a `ticketTypePicker`, so it passes.

**Across blocks, in a new exported pure function**, `checkEmissionTargets(definitions: readonly
BlockManifest[])`. It is the one check that isn't declaration-only. `block-authoring.md`
§Conformance (`:823` promises "from your declaration alone") names it as the exception.

- It runs over `listBlockDefinitions()` in the shipped-blocks section of
  `blockConformance.test.ts` (around `:1501`).
- Its probes feed hand-built lists.
- It checks two things:
  - **every `carries` key** names a config field of at least one trigger whose `startedBy` is
    that emission's source. Without this, a typo'd key would silently match everything;
  - **every `{ value }` literal** is one of the `options` declared on that field, in at least one
    such trigger, when the field declares options (Ticket Event's `event` is a `select`).
    Without this, a typo'd literal would silently match nothing. That is the worse direction,
    because the check would miss real loops.
- Precedent for conformance reaching outside one block: `conformance.ts:2` imports
  `../engine/eligibility`.

### 3. The cycle finder: `engine/flowCycles.ts`

- **The code is generic.** The engine vocabulary gate covers `engine/`, `data/`, `constants.ts`
  and `blocks/*.ts` (one level deep, so `manifest.ts` and `conformance.ts`). Its `MEMBER` regex
  also catches object-literal keys.
- **Naming:** prefer the allowed word `cycle` to `loop` or `cross`, which is the gate's
  documented practice (rename rather than admit). Hence `findFlowCycleThrough`, `FlowCycleStep`
  and `describeFlowCycle`.
- **Words that still need allowlist entries,** each with a one-line justification as `live` got:
  the manifest's `emits`/`emit`, `emission`, `emitted`, `emitter`, `carries` and `through`. Use
  whichever of these survive in the final identifiers.
- **No ticket word appears.**
- **Branching gate:** the finder reads every config through `getBlockDefinition(type)`
  (`blocks/registry.ts:195`) and imports no block module, so it needs no
  `DECLARED_BLOCK_DEPENDENTS` entry (`blockTypeBranching.test.ts:165`). Importing a block's
  schema, as `ticketEventDispatch.ts` does, would fail that gate.

```ts
interface FlowCycleStep {
    readonly flowId: string;
    readonly flowName: string;
    /** The node whose action starts the next step's flow. */
    readonly emitterNodeId: string;
    readonly emitterLabel: string; // the emitting block's manifest label
}

/**
 * A cycle of triggered runs that passes through `flowId`, or null.
 * `flows` is every flow that will be live after the write, the saved one included
 * exactly once, already in its post-write shape.
 */
export function findFlowCycleThrough(flows: readonly FlowEntity[], flowId: string): readonly FlowCycleStep[] | null;
```

- **The algorithm:**
  - **Collect** every trigger node of every flow given, keyed `(flowId, nodeId)`. A trigger is a
    node with `getBlockDefinition(node.type)?.kind === 'trigger'`, the existing idiom
    (`graphValidation.ts:521,747`).
  - **Draw edges.** For each trigger T, take the nodes reachable from T in its own graph. For each
    of those that has non-empty `emits` and a config that parses (the executor's way), resolve its
    emissions and add an edge T → U for every listening trigger U, per the match rule.
  - **Search.** Breadth-first search from each trigger of `flowId` in turn, until the walk returns
    to that trigger. Return the first cycle found, as steps.
- **Reachability:** export `walkFrom` and `outgoingTargets` from `engine/graphValidation.ts` (or
  move them into a small `engine/graphWalk.ts` that `graphValidation.ts` imports). Don't copy
  them.
- **The message is formatted by a separate pure function,** `describeFlowCycle(steps)`, next to
  the finder, in the wording shown under "What the operator gets". It is the same sentence for a
  switch-on and for a save.

### 4. Where it runs

- **`PUT /:guildId/flows/:flowId`** (`src/web/api/flowRoutes.ts`):
  - **Before `mutate`,** outside the transaction (for the synchronous-check reason `mutate`
    gives):
    - read only when a check is possible: a graph arrives, or `request.enabled === true`, **and**
      the flow is or will be on (`existing.enabled || request.enabled === true`);
    - read `flowsRepo.getByGuildId(guildId)`;
    - keep `others = all.filter((flow) => flow.enabled && flow.flowId !== flowId)`. **The saved
      flow's own stored row must be excluded.** Otherwise its old graph refuses the very edit that
      breaks a loop.
  - **`decidePut` gains `otherLiveFlows: readonly FlowEntity[] | null`.** After the two existing
    refusals and before `write`:
    - check when the flow **ends on** (`request.enabled ?? current.enabled`) **and** (it **was
      off** or **a graph arrived**);
    - run `findFlowCycleThrough([...otherLiveFlows, { ...current, name: request.name ??
      current.name, graph: runs, enabled: true }], current.flowId)`;
    - on a cycle, return `{ kind: 'refuse', refusal: { error: describeFlowCycle(cycle), issues:
      [] } }`.
  - The draft branch returns earlier, so a drafted save is never checked.
  - Update `decidePut`'s doc comment ("In this order") and the route's comment.
- **`templates/seedOnboardingFlow.ts`:**
  - after the readiness check, read the guild's flows that are on;
  - run `findFlowCycleThrough` with the new flow added under a placeholder id;
  - on a cycle, throw with `describeFlowCycle`.
- **`POST /flows`** creates switched off, and nothing else enables a flow. Journeys are exempt,
  as above.

### 5. The builder (no change expected; verify)

All three catch paths branch on `issues.length > 0`, so an empty-issues 400 already shows its
`error` as a plain red notification:

- **Builder switch** (`FlowBuilderPage.tsx:1489-1503`): it reverts, and `storedIssueCount` is
  untouched.
- **Builder save** (`:1366-1388`): the title is "That graph won't fly" and the message is the
  error. Nothing is marked or selected, the canvas stays dirty, and the autosave keeps the draft.
  Update the stale comment at `:1367-1370`, because a 400 here is no longer only "too broken to
  store".
- **List switch** (`FlowsListPage.tsx:1144-1161`): the row reverts, `issueCount` is kept, and a
  red notification appears.
- **`web/src/api/flows.ts:54-65`:** `updateFlow`'s doc lists the refusals. Add this one.
  `feat/web-sdk` deletes this file; see the carry list above.

### 6. Docs

- **`docs/contracts/block-authoring.md`:**
  - an `emits` row in the manifest table;
  - a short "What a block causes" section with the match rule, the "unknown matches" rule, and
    when to declare;
  - an entry under "Where a new graph rule goes";
  - the conformance list, naming `checkEmissionTargets` as the one check that isn't
    declaration-only (`:823`);
  - `:86`, which lists only `configSchema` and `run` as withheld from the wire.
- **The withheld-members comments** in `blocks/manifest.ts:995` and `src/web/api/nodeRoutes.ts:105`
  gain `emits`.
- **`constants.ts:184-197`:** the depth-cap comment says the other half "checks the flows
  themselves when one is switched on". Make it "when one goes live (switched on, or saved while
  on)", and name `findFlowCycleThrough`.
- **`AGENTS.md`:** one clause in the ticket-path line about the check at go-live.
- **`ticket-event-trigger.md`:** point the "Step 2 sketch" at this plan.

## Tests

- **`engine/__tests__/flowCycles.test.ts`** (real blocks via the registry). At least one fixture
  reuses a node id (for example `trigger-1`) across two flows, so a finder keyed by node id
  alone fails.
  - "Ticket Closed → Open Ticket (Support)" plus "Ticket Opened (Support) → Close Ticket" is a
    loop, and the steps are in order from the saved flow.
  - **Type narrows:** Open Ticket (Support) doesn't start Ticket Opened (Verification). Ticket
    Opened with no type filter is started.
  - **Close Ticket** starts Ticket Closed whatever its type filter.
  - **Kick Member** starts Member Leaves, so "Member Leaves → Kick Member" loops with itself
    (the accepted over-refusal).
  - **Self-loop:** "Ticket Opened (Support) → Open Ticket (Support)".
  - **Trigger-level, not flow-level:** one flow with "Member Join → Close Ticket" and "Ticket
    Closed → Send Message", on unconnected paths, is not a loop.
  - **An emitting node unreachable from the trigger** adds no edge.
  - **A Schedule-rooted flow** never sits on a loop, even when it closes tickets.
  - **A listening trigger whose config doesn't parse** matches nothing.
  - **A loop among other flows only** returns null for an unrelated flow.
  - **A node with an unregistered block type** is skipped, not thrown on.
  - **`describeFlowCycle`** gives the multi-step sentence and the self-loop sentence.
- **Route tests, two homes:**
  - **New `src/web/api/__tests__/flowLoopRoutes.test.ts`** on a real database, the pattern of
    `flowDraftRoutes.test.ts` (`migrateTestDatabase`, a flow created per case):
    - **refused on a switch-on:** off → on with a loop returns 400 `{ error, issues: [] }`, and
      the row stays off;
    - **refused on a live edit:** a graph edit to a flow that's on and would close a loop returns
      400, and the stored graph is unchanged;
    - **refused when editing B closes a loop with A,** where A is on;
    - **a live edit that breaks a loop saves:** a flow currently in a loop with B, edited to
      remove its emitter, is saved (this pins the own-row exclusion);
    - **flows that are off are ignored:** the same pair with A off saves;
    - **never refused:** switching off, renaming, re-sending `enabled: true` with no graph,
      saving a flow that's off, and a live save that lands as a draft.
  - **The existing mocked `flowRoutes.test.ts`** needs `flowsRepoMock.getByGuildId.mockResolvedValue([])`
    in its `beforeEach` (`:184-227`, after `vi.clearAllMocks()`). Otherwise every existing
    graph or switch-on case fails with a 500.
- **Conformance probes:**
  - `emits` missing (add `'emits'` to the list at `blockConformance.test.ts:108-123`);
  - a trigger with an emission;
  - a `fromField` that isn't an own field;
  - a `fromField` naming a token-rendering or variable-picker field;
  - `checkEmissionTargets`: a `carries` key no trigger of that source has, and a literal outside
    the listener field's options.
- **e2e (one, `web/e2e/`):**
  - follow `web/e2e/flowIncomplete.test.tsx:118-124` and its helpers (`TestDiscord`,
    `createSeedApi`, `bootBotForDashboard`, `buildDashboardApp`, `installDashboardApi`,
    `flowRow`, `renderDashboard`);
  - use a single "Member Leaves → Kick Member" flow, a self-loop, so no ticketing config is
    needed;
  - switching it on from the list shows the message, reverts the switch, and leaves the row's
    issue chip alone.
- **Sabotage targets** (each one is broken, a named test is seen going red, then it's restored):
  - remove the call in `decidePut`: the route tests fail;
  - drop the `flowId !== flowId` filter: the "edit that breaks a loop saves" test fails;
  - ignore `carries`: the type-narrowing test fails;
  - build edges flow-level (every emitter in the flow): the trigger-level test fails;
  - key triggers by node id alone: the shared-id fixture fails;
  - drop the "unparsed listener matches nothing" guard: its test fails.

## Hazards for the implementer

- **`mutate`'s check is synchronous.** Read the guild's flows before it, never inside it (the
  single sqlite connection deadlocks; memory `sqlite-single-connection-deadlock`).
- **Return `issues: []`.** Issues would lock the builder switch and mark the wrong cards.
- **Mirror what runs:** the listener is parsed raw, as `matchingTriggers` does; the emitter is
  parsed through `visibleNodeData`, as the executor does. If the check and the runtime disagree,
  it either refuses a pair that could never fire or misses one that can.
- **Use the post-write shape of the saved flow** (the new graph, the new name, and on), and
  **exclude its stored row** from the others. Use the stored rows for every other flow.
- **Key triggers by `(flowId, nodeId)`.**
- **An unregistered block type** must be skipped, never thrown on.
- **One corrupt flow row:** `getByGuildId` runs `assertValidGraph` on every row, so a corrupt one
  turns every save and switch-on in that guild into a 500. That already breaks dispatch, so this
  is accepted, not fixed here.
- **The engine vocabulary gate** is an allowlist over `engine/`, `data/`, `constants.ts`,
  `manifest.ts` and `conformance.ts`, and it catches object-literal keys. New identifier words
  need entries with reasons, or a rename onto an allowed word. Ticket words must not appear in
  identifiers in those files.
- **`NON_WIRE_MEMBERS`:** add `'emits'` to it **and** peel `emits: _emits` off in
  `toDescriptor`'s destructure (`src/web/api/nodeRoutes.ts:65`). `tsc` enforces the pair through
  `NonWireMembersAreWithheld` (`:83-90`). Without the list entry, `emits` gets served and the
  drift test fails. Check `tsc`, not only the tests.
- **29 blocks** gain `emits: []` or a declaration. Missing one fails conformance through
  `REQUIRED_ARRAYS`.
- **Hand-built manifests need `emits` too:**
  - the 11 fixture manifests under `src/features/flows/__tests__/fixtures/blocks/**`:
    - `conforming/fixtureBlock`;
    - the two `duplicateType` claimants;
    - the four in `contract/`;
    - `producer/actionRecordValue`;
    - the three in `subjectAbsent/`;
  - `validManifest()` at `blockConformance.test.ts:55`.

  Registry-sourced manifests in tests need nothing.

## Out of scope

- Relaxing the accepted over-refusals (Close Ticket's unknown type, a kick with nobody left to
  kick).
- Showing loops already live among other flows anywhere in the dashboard.
- A lock against the two-PUT race.
- Any change to the runtime depth cap.

## Decisions made while building

- **The finder takes `FlowCycleCandidate = Pick<FlowEntity, 'flowId' | 'name' | 'graph'>`,** not
  `FlowEntity[]`. A stored row still satisfies it, and the seed script no longer has to invent an
  `id`, timestamps and an `entityVersion` for a flow that isn't written yet. So `decidePut` passes
  `{ flowId, name, graph }` and the plan's `enabled: true` falls away: the finder never reads it.
- **The finder throws on a duplicate `flowId`, and on a `flowId` it wasn't handed.** The plan's
  contract says the saved flow is passed "exactly once". With triggers keyed `(flowId, nodeId)`, a
  stored row and its post-write shape sharing trigger ids would quietly merge in the map. Then
  dropping the own-row filter would pass the "edit that breaks a loop saves" test. Throwing turns
  that mistake into a 500. That is how the sabotage for that guard goes red.
- **`BlockEmittedValue` became `BlockEmissionValue`,** so the vocabulary gate didn't need
  `emitted`. That follows the gate's practice of renaming rather than admitting a word. Five
  words were admitted:
  - `emit`, `emission`, `carries` and `emitter` are contract words, so they went into
    `DOMAIN_VOCABULARY` beside `chain`.
  - `through` is a preposition, so it went into `GENERIC_VOCABULARY`. It is kept because the
    plan names `findFlowCycleThrough`. Internal helpers were named onto allowed words too
  (`triggersIn`, `cycleFrom`, `parentOf`, `isAbsent`, `wanted`).
- **One condition, `goesLive(enabled, request)`, decides both the read and the check.** It is
  true when the write leaves the flow on and either switches it on or carries a graph. The route
  asks it of the row it read first (`existing`), and `decidePut` asks it of the row inside the
  transaction (`current`). It is tighter than the plan's read condition, `existing.enabled ||
  request.enabled === true`: a re-sent `enabled: true`, or a graph sent with `enabled: false`,
  no longer reads the guild for nothing.
  - **When the two rows disagree, the save is refused.** Say another request switches the flow
    on between the read and the transaction. The check is now owed, but the other flows were
    never read. `decidePut` then refuses with `This flow was switched on or off while you were
    saving. Save again.` (400, no issues) instead of skipping the check.
  - The reviewer found this. It is not the accepted two-PUT race: it takes one flow open in two
    tabs, not two flows, and a loop through Kick Member isn't bounded by the depth cap. A mocked
    test in `flowRoutes.test.ts` pins it.
- **The executor's parse is shared, not copied.** `parseNodeConfig` in `blocks/manifest.ts` is the
  one place that does `visibleNodeData`, then parse, then `visibleNodeData` again. The executor
  and the finder's emitter both call it. `isObjectValue` moved there from `executor.ts` too.
  The reviewer found this.
- **`BlockEmissionValue`'s arms exclude each other at compile time** (`fromField?: never` /
  `value?: never`). Readers branch on `value !== undefined`.
- **`isTokenField` asks the executor's own predicates,** `isCopyField` and
  `isVariablePickerField` from `engine/copyRendering.ts`. It doesn't keep a third copy of "can
  this hold a `{{var}}`".
- **The self-loop sentence.** The plan gave only its middle. Wording is chosen by distinct flows,
  not by step count, so a flow that loops through two of its own triggers reads the same way:
  - **one flow:** `That would make this flow set itself off in a loop: "Opener" (Open Ticket)
    starts "Opener" again. Change it so it doesn't.` "Between flows" and "switch one off" would
    describe flows that aren't in the loop.
  - **two or more flows:** the plan's sentence, word for word.
- **Conformance also checks each emission's `startedBy` against `BLOCK_TRIGGER_SOURCES`** (in
  `checkVocabulary`), and checks each carried value has exactly the `{ value }` or
  `{ fromField }` key set. A source outside the vocabulary would link to nothing, so the check
  would miss what the block causes. The plan didn't list either.
- **`checkEmissionTargets` holds only `{ value }` literals to the listener's options,** not
  `fromField` values. What a node holds is the author's. Today the only `fromField` is Open
  Ticket's free-text type key against Ticket Event's free-text type key.
- **The journey-install exemption is written down where install writes,** in
  `logic/applyResourcesToFlows.ts`. One nuance is recorded there too. An API caller who pointed
  an emitting field and a listening field at the *same* resource could make install write one
  snowflake into both, which would be a new link. No builder control offers that: neither the
  event select nor the ticket type picker has a sidecar. So the plan's "only removes edges" holds
  for anything the dashboard can produce.
- **The walk passes through nodes whose block isn't registered.** At run time the executor fails
  at such a node, so what lies past it never runs. Treating it as reachable over-refuses, which
  is the conservative way round. It is also the over-approximation `walkFrom` already makes
  through both branches of a condition.
- **The real-database route tests use a fresh guild per case.** The check reads the whole guild,
  and several cases leave live flows behind. Loops that already exist are written through
  `flowsRepo.create` directly, because the route won't build one.
- **The e2e lives in `web/e2e/flowLoopRefusal.test.tsx`.** It creates the flow with its graph in
  one `POST` (ready, so no issue chip). It asserts the list's own red notification text, that
  the switch reverts, that the row shows no "Needs fixes" chip before or after, and that the row
  is still off on the server.
- **The web-SDK memory's carry list was not edited here.** It is the user's memory, outside the
  repo, and is left to the caller (line 137 above).
