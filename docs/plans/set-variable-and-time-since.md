# Step A — Set Variable, the `time` value kind, Time Since

> **PRD**: [flow-time-and-message-primitives.md](../prds/flow-time-and-message-primitives.md) §5.1, §5.2, §8
> **Status**: Planned 2026-10-02, revised after two plan reviews (grounding and coverage)
> **Builds on**: [activity-events.md](activity-events.md), [quiet-timeouts-and-kick-member.md](quiet-timeouts-and-kick-member.md), [activity-backfill.md](activity-backfill.md)

## What the operator gets

- **Set Variable**: name a variable and set it to text, a number, true/false or the current
  time. Later blocks read it as `{{var.<name>}}`. A variable lasts for **one run**: other
  runs, other flows and journeys don't see it, and nothing persists per member between runs.
- **Time Since**: a condition. Has at least (or less than) a given amount of time passed since
  something? It has three exits, **Yes**, **No** and **No record**, and never waits.
- **Fields appear only when they apply.** This works for every block.
- **The builder warns about an easy-to-forget exit left unconnected,** such as No record or
  Timed out.

## Decisions (Douglas, 2026-10-02)

- **Times:**
  - A time is stored as an **ISO-8601 UTC string**: `typeof v === 'string' && new Date(v).toISOString() === v`.
  - Set Variable's time is **"now" only**.
- **No record:** Time Since with nothing to measure from leaves by No record. That covers:
  - no message;
  - no join time;
  - no start time on an older run;
  - an unset or empty variable.
- **Show fields only when they apply,** as a general contract capability.
- **During the startup backfill, Time Since answers from what is recorded so far.** It is a
  documented limit; runs coming out of a quiet wait are already held.
- **Warn about unconnected exits,** but only exits a block marks as easy to forget (C5). An
  unconnected "No" is usually deliberate ("No → end"), and warning on it would fire on most
  normal flows (see the memory note "over-warning does not degrade safely").
- **Step 0 first:** commit the three earlier steps before building this one.

## Step 0 — commit the earlier work

- Commit the activity events, quiet timeouts / Kick Member / Member Leaves, and activity
  backfill work, plus the restart test and the inspector scroll fix.
- **Stage only this work's hunks.** Other sessions' uncommitted edits share files with it
  (PRD §4 lists them).
- **The commit must build and pass tests on its own.** If one of our hunks depends on another
  session's uncommitted hunk, stop and raise it rather than committing half of either.

## Contract changes

Each one goes through the manifest, conformance, the browser mirror, the drift gates and
`block-authoring.md` together.

### C1. `visibleWhen` on config fields

- **Manifest:** a new optional member on every config-field arm:
  `visibleWhen?: { field: string; equals: readonly string[] }`.
- **One helper, mirrored.** Add `isFieldVisible(field, fields, nodeData)` next to
  `resolveOutputName` in `manifest.ts`, mirrored in `web/src/flows/variables.ts`, both built
  on one `effectiveFieldValue(field, nodeData)` helper (stored value, otherwise
  `defaultValue`). C2's `resolveOutputValueKind` uses the same helper. There must be one
  reading of "current value", not three.
- **Every reader that walks config fields must skip hidden ones.** A hidden stale value must
  never fail a run, refuse a save or show up anywhere:
  - `renderNodeCopy` (`engine/executor.ts`): don't render or resolve hidden copy and picker
    fields; drop them from the config handed to `run`.
  - `checkCopyTokens` (`engine/graphValidation.ts`) and the new C3 check.
  - `fieldIssue` / `liveFieldIssues` (`web/src/flows/fieldChecks.ts`). This is another
    session's uncommitted work; extend it, don't fork it.
  - `placeIssues` in `NodeInspector.tsx`: pass only visible keys, so a server issue on a
    hidden field shows at node level rather than under an invisible control.
  - `resolveValue` in `web/src/flows/cardSummary.ts`: a summary part for a hidden field
    renders nothing.
  - `collectResourceTargets` (`logic/resourceTargets.ts`): skip a hidden channel picker's
    resource sidecar, so a hidden field doesn't get provisioned.
- **Present doesn't mean visible.** `defaultDataFor` (`web/src/flows/nodeMeta.ts`) writes
  every `defaultValue` when a node is dropped, so hidden fields usually hold a value. Only
  `isFieldVisible` decides.
- **Schema rule:** a field with `visibleWhen` is optional and has **no per-key constraint a
  stale value could fail**. Every check on it goes in the block's own visibility-gated
  `superRefine`, as `checkQuietTimeout` does.
- **Conformance:**
  - The referenced field exists and is a `select` or `segmented`.
  - It declares a `defaultValue` equal to its schema `.default()`.
  - It has no `visibleWhen` of its own (one level, no chains).
  - Every `equals` value is one of its options.
  - The field carrying `visibleWhen` is optional in the schema.
- **Clearing on switch is not needed** once every reader honours visibility.
- **Adopt it once outside the new blocks.** In `blocks/quietTimeout.ts`, `quietChannelId`
  gets `visibleWhen: { field: 'timeoutCountsFrom', equals: ['memberMessage', 'anyMessage'] }`.
  - Update its description ("Only matters when…" is now redundant).
  - Update the comment there, and the one at `manifest.ts` on the eligibility arm, that say
    the vocabulary can't express "show when".
- **Vocabulary gate:** `visibleWhen` introduces the identifier word `visible`. Add it to
  `DOMAIN_VOCABULARY` in `engineVocabulary.test.ts` with a reason, next to `placeholder` and
  `icon`.
- **Drift:** extend `CONFIG_FIELD_FIXTURES` in `nodeDescriptorDrift.test.ts`.

### C2. Output value kind derived from a config field

- Add `'time'` to `BLOCK_OUTPUT_VALUE_KINDS` and its browser mirror.
- **New optional output member,** mutually exclusive with `valueKind`:
  `valueKindFrom?: { field: string; kinds: Readonly<Record<string, BlockOutputValueKind>> }`.
  An option missing from `kinds` means "no kind".
- **`resolveOutputValueKind(output, fields, nodeData)`** goes next to `resolveOutputName`, on
  both sides, using `effectiveFieldValue`. Switch the readers to it: `outputValueKinds()`,
  which C3 replaces, and `availableVariablesAt()`.
- **Conformance:**
  - The field exists and is a `select` or `segmented` with a `defaultValue`.
  - The keys of `kinds` are among its options, and the values are real kinds.
  - `valueKind` is not also set.
- **Wording that assumes every kind has a picker.** Update all of these:
  - `conformance.ts` ("which no picker takes"), and the assertion at
    `blockConformance.test.ts:~933`;
  - "when a picker can use it" at `manifest.ts:~546`, `web/src/api/types.ts:~458` and
    `web/src/flows/variables.ts:~27`;
  - the `BLOCK_OUTPUT_VALUE_KINDS` comment at `manifest.ts:~513`;
  - `block-authoring.md:~479` and `~610`.
  
  `time` is consumed by C3's control, not by a `PICKER_VALUE_KINDS` picker.
- **New drift gate for output-declaration members.** Add a browser-side keys array in
  `web/src/api/types.ts`, in the style of `BLOCK_CONFIG_FIELD_KEYS`, plus fixtures for both
  naming arms (`fixed` and `authored`) in `nodeDescriptorDrift.test.ts`. A new output member
  then can't go unmirrored.

### C3. `variableSelect` control: pick a variable by name, filtered by kind

The `{{var}}` paths fail the step before `run` on an unrecorded name, so "unset leaves by No
record" can't use them. Time Since takes the variable **by name**:

- **Vocabulary:**
  - Add `'variableSelect'` to `BLOCK_CONTROL_TYPES` on both sides.
  - Add a config-field arm `{ control: 'variableSelect'; valueKind: BlockOutputValueKind; … }`.
  - The stored value is a bare variable name, never a token.
  - The schema reuses the shared variable-name shape.
  - Add arms to the exhaustive switches in `web/src/flows/controls/renderControl.tsx` and
    `web/src/flows/cardSummary.ts`. `docs/prds/flow-engine-v2-execution-strategy.md:~249`
    lists every file a new control touches.
- **Not added to `PICKER_VALUE_KINDS`,** so the executor passes the name through untouched and
  the block reads `context.variables[name]` itself.
- **Builder:**
  - A new component, named distinctly from the existing `VariablePicker.tsx` token chips
    (e.g. `VariableSelectControl`).
  - It lists variables available at this node (`availableVariablesAt`) whose resolved kind
    matches the field's `valueKind`.
  - Empty state: "No time variables before this block — add a Set Variable set to Current
    time".
  - A stored name that's no longer offered (renamed, deleted or moved) shows as **"not
    available here"**, never as a blank select.
- **Save-time checks** (`graphValidation.ts`; name helpers without the word `select`, which
  the vocabulary gate doesn't know):
  - Build **one producer map**: name → producers, each carrying node id, label and resolved
    kind, **including `undefined` kinds** (Pick Random, level outputs, text Set Variables).
    This replaces `outputValueKinds()`, which drops kindless outputs.
  - A `variableSelect` value must be produced by **at least one ancestor** of the node, using
    the same over-approximation as the browser's `availableVariablesAt`. A variable only ever
    produced downstream or on a sibling branch is a wiring mistake, and is refused rather than
    shown as No record.
  - **Every** producer of that name must resolve to the field's kind. Mixed kinds are refused,
    naming both nodes.
  - **Apply the same "every producer matches" rule to the existing channel pickers' `{{var}}`
    check.** Two rules for one question would let a text Set Variable named
    `ticketChannelId` feed Discord text as a channel id. This tightens current behaviour, so
    check that no shipped template or test graph depends on the looser union.
- **At run time,** a value that isn't a strict ISO time fails the run by name. The bag carries
  no types.

### C4. Run start time

- **Executor:**
  - Create `startedAt` in `executeFlow` next to `runId`.
  - Carry it in `ExecuteSegmentOptions` beside `runId`.
  - Add it to the per-node context, where `runId` is added (`executor.ts:~257`).
  - Pass it to `persistNewSuspendedRun` as a parameter, as `runId` is.
- **Snapshot:** an optional `startedAt` ISO string on `FlowRunContextSnapshot`
  (`data/flowRunsSchema.ts`) and `contextSnapshotSchema` (`data/flowRunsRepo.ts`). The
  `Equals` guard forces both to change.
  - Written on the first park only. `park()` on a re-park doesn't rewrite the snapshot, so it
    survives every later park. Test that.
- **Resume:** at the resume call site (`flowRunResume.ts:~474`), set the option from
  `run.contextSnapshot.startedAt`. `rebuildResumeContext` stays unchanged.
  - Rows parked before this change have none. `context.startedAt` is `Date | undefined`, and
    Time Since answers No record.
  - **Never** fall back to `flow_runs.createdAt`, which is the first park, not the start.
- **Entity version:**
  - `FLOW_RUN_ENTITY_VERSION` (`constants.ts`) was bumped to 2 when the snapshot gained
    `channelId`, along with the documented empty migration
    `2026-09-15-Widen_Flow_Run_Context_Snapshot.ts`.
  - Follow that precedent: bump to 3 and add a documented empty migration, unless reading what
    the version gates shows a bump is wrong here. Say which in the report.
- **Update these:**
  - the `blocks/types.ts` comment that says no block reads `joinedAt`;
  - the exact-snapshot assertions that break: `durableRuns.test.ts:~287`,
    `parkedRunResume.test.ts:~168`, `parkedRunChannel.test.ts:~204, ~538`.

### C5. Warn about an easy-to-forget exit left unconnected

- **Manifest:** a new optional member on an exit declaration, `warnIfUnconnected?: true`, for
  exits whose silent dead end is rarely intended.
- **Builder:** an unconnected exit carrying it gets a warning (not a save refusal) on the card
  and in the inspector, worded like "No record isn't connected — runs that land here just
  stop". Mirror the readiness and issue path the builder already uses for warnings; don't add
  a new one.
- **Adopt it on:**
  - Time Since's `noRecord`;
  - Wait for Event's and Ask a Question's timeout exits (an unconnected timeout ends the run
    silently today).
  
  Not on a plain No/false exit.
- Conformance (the flag only sits on a declared exit) and drift (exit-declaration members)
  both cover it.

## Blocks

One directory each. Nothing outside the folder names their type.

### B1. `actionSetVariable` — "Set Variable"

| field | control | shown when | schema |
|---|---|---|---|
| `variableName` | text | always | required, the shared variable-name shape |
| `valueType` | select: Text / Number / True or false / Current time | always | enum `text \| number \| boolean \| time`, `.default('text')`, `defaultValue: 'text'` |
| `textValue` | text, `rendersTokens`, `maxLength` (keep a rendered value well inside the 16 KiB variable bag) | type = text | optional string; required when visible (refine) |
| `numberValue` | text, `optional: true` (no number control; a cleared field must not become 0) | type = number | optional string; when visible, non-blank and a finite number (refine); converted in `run` |
| `booleanValue` | segmented true / false | type = boolean | optional `'true' \| 'false'` with no `.transform()` (the `actionPostEmbed` reason); converted in `run` |

- **Current time:** no input. It writes `new Date().toISOString()`.
- **Output:** `naming: 'authored'`, `fromField: 'variableName'`,
  `valueKindFrom: { field: 'valueType', kinds: { time: 'time' } }`.
- **Writes:** number as a JS number, boolean as a JS boolean, text as the rendered string.
- **Shared name shape:**
  - Move Pick Random's private `VARIABLE_NAME_PATTERN` to a shared file at the `blocks/` root.
  - Name it `VARIABLE_NAME_SHAPE`: `pattern` isn't in the vocabulary gate, `shape` is.
  - Import it from both blocks and from C3.
- **Card summary:** built from what summary parts can do today. Variable name plus type label,
  plus the value part, which only renders when its field is visible. Don't promise
  `name = now` unless a label reads that way.

### B2. `conditionTimeSince` — "Time Since"

| field | control | shown when | schema |
|---|---|---|---|
| `source` | select | always | `memberMessage` "The member's last message" · `channelMessage` "Anyone's last message in a channel" · `memberJoined` "When the member joined" · `runStarted` "When this run started" · `variable` "A saved time"; default `memberMessage` |
| `channelId` | channelPicker, `optional`, `{{var}}` allowed | source ∈ memberMessage, channelMessage | optional; **required** for `channelMessage` (refine) |
| `timeVariable` | variableSelect, `valueKind: 'time'` | source = variable | optional; required when visible (refine) |
| `comparison` | segmented: At least / Less than | always | default `atLeast` |
| `durationMs` | duration | always | positive, capped at 365 days (`FLOW_MAX_DELAY_MS` limits *parking*, not questions) |

**Exits:** `true` (Yes), `false` (No), `noRecord` (No record, `warnIfUnconnected`). The ids
match the shipped conditions. This is the first condition with three exits: confirm
conformance and the card handle it.

**Run:**

1. **Reference time T:**
   - `memberMessage`: `activityEventsRepo.findLastMessageAt({ guildId, userId: subject.id, channelId? })`.
   - `channelMessage`: `findLastMessageAt({ guildId, channelId })`. Threads count toward their
     parent inside the repo.
   - `memberJoined`: `subject.joinedAt`, which is null on a partial member.
   - `runStarted`: `context.startedAt`.
   - `variable`: `context.variables[timeVariable]`.
     - Unset, null or `''` means none.
     - A non-string, or a non-strict-ISO string, **fails the run by name**:
       `"timeVariable" holds "<value>", which is not a time`.
2. **No T** → `noRecord`.
3. **Compare:** elapsed = now − T.
   - `atLeast`: elapsed ≥ duration → `true`, otherwise `false`.
   - `lessThan` is the reverse.
4. **Channel check:** when a channel is given, the bot must be able to view it.
   - Export `checkChannelUsable` from `blocks/quietTimeout.ts`, taking the field label and the
     consequence wording as parameters; its message is quiet-timeout copy today.
   - One implementation; don't copy it.

- **Disclosed behaviours:**
  - A channel `{{var}}` recorded empty (for example, a deleted ticket channel) fails the run
    in `resolvePickerVariable`; it doesn't answer No record. That's the engine's existing
    rule.
  - During the backfill, Time Since answers anyway. Say so in the block's doc comment.
- **Services:** import `activityEventsRepo` from the activity barrel; tests use `vi.mock` or
  `vi.spyOn`.
- **Card summary:** from option labels and the duration (for example "The member's last
  message · At least · 2 days"). Hidden parts render nothing.

## Tests

Target ~90%, effort on behaviour. Sabotage-verify each new guard.

- **C1 (hidden fields):**
  - A hidden stale `{{var}}`, in a copy field and in a channel picker, neither fails the run
    nor refuses the save.
  - Sabotage: remove the skip in `renderNodeCopy`.
  - The inspector hides and shows fields from the sibling's value and default (dom project).
  - A field edited and then hidden shows no live limit issue.
  - A server issue on a hidden field lands at node level.
  - Conformance refuses each bad `visibleWhen` shape.
- **C2 (value kind):**
  - `resolveOutputValueKind` on both sides.
  - The output-member drift gate fails when a member is missing from the browser keys.
    Sabotage-verify it.
- **C3 (variableSelect):**
  - The builder lists only matching-kind variables available at the node, and shows "not
    available here" for a stale name.
  - The save check refuses:
    - a name with no producer;
    - a name produced only downstream;
    - mixed kinds, **including a producer with no kind** (a text Set Variable or Pick Random
      sharing the name).
  - The channel-picker check now refuses a text Set Variable sharing a channel variable's
    name.
  - The executor passes the name through untouched.
- **C4 (start time):** an old snapshot without `startedAt` resumes with `undefined`; the
  rest is covered by the end-to-end test below.
- **C5 (unconnected exits):** an unconnected `noRecord` warns; an unconnected `false` doesn't;
  a connected `noRecord` doesn't.
- **Set Variable:**
  - each type writes the right JS type;
  - text renders tokens;
  - a blank or non-numeric number is refused, never stored as 0;
  - time writes a strict ISO string.
- **Time Since:**
  - every source × At least/Less than, on both sides of the boundary;
  - No record for:
    - no message;
    - a partial member;
    - an old run;
    - an unset variable;
  - a non-time variable fails by name;
  - `channelMessage` without a channel is refused at save;
  - thread replies count toward the parent.
- **One TestDiscord end-to-end flow:** member joins → Set Variable `seenAt` = Current time →
  Delay 1 day (fake clock plus an explicit scheduler tick) → Time Since `seenAt` at least
  1 day → Yes → a second Time Since on "When this run started", at least 1 day → Yes. This
  proves the bag and `startedAt` survive a park and resume.
- **Inventory:** conformance passes for both new blocks with no special case. Add both to
  `SHIPPED_BLOCK_TYPES` (`blockDiscovery.test.ts`).
- A real-guild run waits for Douglas. The TestDiscord end-to-end stands in for now.

## Out of scope

- Variables shared across runs, flows or members.
- Value kinds for text, number and boolean.
- An offset on "now".
- Chained `visibleWhen`, or operators beyond "equals one of".
- Warnings on plain No/false exits.
- **The composite index for "this member in this channel"** (PRD §4). Time Since makes it a
  per-run cost and Step B a per-message one, so build it at the start of Step B.
- Message Sent, the message wait and the activity subscriber list (Step B).

## Docs

- `docs/contracts/block-authoring.md`:
  - `visibleWhen` and the hidden-field rule;
  - `valueKindFrom`;
  - `variableSelect`;
  - `warnIfUnconnected`;
  - `startedAt` on the context;
  - variables last one run;
  - the picker-wording fix.
- **PRD:**
  - §5.2 says "a `{{var}}` of kind `time`". Amend it to "a saved time variable, picked by
    name".
  - Tick §5.1 and §5.2 as built.
