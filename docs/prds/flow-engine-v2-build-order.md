# Flow Engine v2 — Build Order

> **This is a plan, not a PRD.** The base PRD is
> [flow-engine-v2-journeys-and-provisioning.md](flow-engine-v2-journeys-and-provisioning.md) — it is
> the anchor, and product decisions (including anything deferred) are recorded **there**. This
> document says what gets built next and in what order; when the two disagree, the PRD wins.
>
> **Status**: Active — replaces milestone-by-milestone planning
> **Owner**: Douglas
> **Last updated**: 2026-09-18
> **Supersedes**: the per-milestone wave maps in [flow-engine-v2-execution-strategy.md](flow-engine-v2-execution-strategy.md) §8, and the M2 RPI plan
> **Product intent**: [flow-engine-v2-journeys-and-provisioning.md](flow-engine-v2-journeys-and-provisioning.md) §1.3 and §2

## Why this document exists

The PRD specified 119 requirements across six milestones before step 1 ran once. That was a waterfall bet: it spent detail on M4's ticket cutover and M5's permission-intent compiler while nobody had yet watched a flow run in a real Discord guild.

The bet is already visibly losing. M2's planning found three PRD sections stale before its first dependent read them (§5.1's context-requirement set, §5.13's status names, §5.3's claim that random selection "needs no new control type"). A document decaying faster than it is consumed was written too early.

**The unit of work is now PRD §1.3's steps, not milestones.** Each step is re-derived when reached, against the code as it then exists — not planned years ahead.

## The steps

From PRD §1.3, unchanged. This is the durable product intent and the only sequencing that matters.

| Step | Outcome | Done when | Status |
|---|---|---|---|
| **1** | Adding a block is cheap and safe | A new block ships by adding one directory; conformance tests catch an incomplete manifest; the builder needs no edit | **Done** (M1) |
| **2** | Blocks compose | A block can consume a value another block produced, and copy can address the subject | **Done** — slice D absorbed into step 3 as slice E |
| **3** | **A run can ask a human a question** | A moderator presses a button in a channel and *that* parked run advances; non-moderators are refused | **Done** — slice E ran against a live guild 2026-09-15 |
| **4** | A flow can open and drive a ticket | A verification ticket is opened by a flow, is distinguishable from a support ticket, and its channel is addressable by later blocks | **Done** — live-verified 2026-09-15 |
| **5A** | **A journey can build its own home** | Installing a journey on an empty guild creates its categories, channels, and roles with correct visibility | **Done** — live-verified 2026-09-20/21 |
| **5B** | Installed structure stays healthy | Drift is detected and repairable, installs resume after interruption, and uninstall is safe | **Planned — next** |
| **6** | The real journey runs on it | Our onboarding and verification runs end-to-end on the engine with no bespoke code | Not started |

**Only the current step is planned.** Steps 5B–6 have PRD sketches (§5.7–§5.9) that are starting material, not requirements.

### Why step 5 is split (2026-09-18)

§5.7 and §5.8 carry **29 requirements** between them (18 + 11). §1.3's bar for step 5 is one sentence. Shipping all 28 before an install has ever run is precisely the waterfall bet this document exists to reject — and the same bet that made §5.6 stale before step 4 read it.

The requirements are real, so they are scheduled rather than dropped. The split rule is **not** "core versus nice-to-have":

> **5A gets anything cheap now and expensive to retrofit. 5B gets anything genuinely additive later.**

That puts some unglamorous things in 5A. Crash-safety is the clearest: recording intent *before* mutating the guild is a schema and call-ordering decision, so adding it afterwards means rewriting the apply path rather than extending it. Conversely drift detection reads state that already exists and adds no column, so it costs the same whenever it lands.

### Four commits landed after step 3 closed

They belong to no slice, and that is the point: they are what an author hit while *using* the thing, which is the feedback the first three steps could not produce. Recorded here rather than folded into a slice, because "what the first real authoring session surfaced" is worth being able to find later.

| Commit | What an author hit |
|---|---|
| `6a1b1b6` | An edge could not be removed without deleting one of the nodes it joined |
| `c1f57d6` | Every press posted an ephemeral confirming what the member had just watched happen in the channel |
| `ccfde54` | A block named the variable it wrote and a later block's copy read it, and nothing on screen connected the two — a typo surfaced at run time as a token resolving to nothing |
| `de50893` | A question with nothing wired to any answer saved happily and posted buttons that could never work |

Three of the four are authoring-surface defects invisible to every test in the suite, and none was predicted by a plan. That is the argument for step 4 ending in a live run too.

### Full embed authoring

Pulled out of step 2's deferral table, on its stated trigger. `action.postEmbed` authored a title, a body and a colour, so it could not reproduce the verification embeds it exists for. It now authors **fields** plus the flat scalars — title link, author line, footer, timestamp, image, thumbnail.

**`fields` cost a tenth control, `objectList`**, and the deferral table's own prediction about which half was expensive held exactly: the flat scalars were `text` fields and cost nothing but copy, while the list of `{name, value, inline}` records needed a control arm. `textList` (slice B1) edits a list of *strings*; the two alternatives to a new arm were both rejected on the same grounds — encoding a row as `"name|value|inline"` makes the delimiter part of the data and corrupts the first time an author types a pipe, and three index-correlated `textList`s silently re-pair every later row when one entry is deleted. Named `objectList` rather than `embedFields` because `blocks/manifest.ts` is inside the vocabulary gate and a control named after its first consumer is the leak that gate catches.

**The six-file estimate for a new control was right, and it is now nine.** B1 counted the manifest arm, `BLOCK_CONTROL_TYPES`, the drift fixture, the browser mirror plus its keys table, a renderer wired into `renderControl.tsx`, and `cardSummary.ts`. All six were real. Three more were not predicted and all three are *copy* rather than rendering: `copyRendering.ts` needed a second predicate because `isCopyField` narrows to the single-string arms and cannot see a column, and both the executor and `graphValidation.ts` needed a second walk to use it. A control whose value holds no copy would have cost the predicted six.

Two things the plan did not anticipate, each found by a failing gate rather than by reading:

- **Conformance's entry probe was a bare string**, which an `objectList` schema rejects at every length — so the count sweep would have read that as "the schema constrains its entries" and fallen silent, leaving `minEntries`/`maxEntries` unchecked. Exactly the failure B1 had already fixed once for `textList`, reappearing one shape up.
- **A `.transform()` in a block's schema is not conformance-compatible.** `checkFieldDefault` reveals a schema's default by parsing `undefined`, which on a transforming schema yields the *output* while a config field declares its default as *input*. The two can then never agree. The timestamp toggle stores the string its `segmented` control writes instead, and `run` does the comparison.

**The 6000-character total is enforced, in `run` rather than in the schema.** Every per-part limit is a property of one field and lives on it, where the control shows it and a save refuses it. The total is only false for a combination of parts each of which is individually legal, and only knowable after tokens expand — so it fails nameably at post time rather than truncating, because a silently trimmed embed drops whichever field was last and reads to an author as the flow being broken.

**Not done, deliberately**: no live-guild run. Every claim here is structural, which is the condition step 3's slice E existed to make false and which this change re-enters. The card counting `3 fields` rather than listing them, and the field rows' layout in the inspector, are both judgements that want an author looking at them.

**Built in parallel with step 4's opening work, in a separate worktree, and merged clean.** Verified independently of the implementer's own report before merging: 473 tests across 32 files, 17 `tsc` errors matching the documented baseline exactly with none in `src/features/flows`, `src/web`, or `web/src`, and **zero files touched under `src/features/tickets/`** — the isolation the split depended on. The merged suite equals the branch's, so nothing was lost in the merge.

This is worth recording as a process result and not only a feature one. Two workstreams ran at once against disjoint trees, and the file-level check that they stayed disjoint is cheap and mechanical. The thing that made it safe was not discipline but that `BLOCK_CONTROL_TYPES` and the tickets feature share no file; a split chosen without checking that would have been a guess.

## Step 2 — Blocks compose

The bar is PRD §1.3 exactly: *a block can consume a value another block produced, and copy can address the subject.*

### What ships

| Slice | Content | Status |
|---|---|---|
| **A** | Context split — `subject` / `actor` / `channel` / `variables` on `FlowRunContext`, requirements declared and validated | **Done** (`18ba61a`) |
| **B** | Variables flow — `context.setOutput` writes, the bag rides `FlowSuspension`, one shared token renderer expands `{{subject.mention}}`, `{{actor.mention}}`, `{{guild.name}}`, `{{var.<name>}}` | **Done** (`18ba61a`) |
| **C** | Persist it — `flow_runs.contextSnapshot` carries the channel across a park; variables get their own column | **Done** (`21ce4e7`) |
| **D** | Run it against the real guild | **Moved** — now step 3 slice E |

Slice D is not optional and not a formality. **Nothing in this engine has ever been exercised against a live Discord guild or in a real browser** — M1 was verified structurally only. Every deferred decision below is a guess until it happens.

It moved rather than being dropped. Running two steps of pure spine proved little that could be seen, and the observation that nothing visible had changed was correct; running the same infrastructure with a prompt block on top is the same exercise with a result worth looking at. It is still the gate on step 3 finishing.

### Ordering constraints

Only two, and both are real:

1. **B before C.** The migration must know what a variable bag serialises to before it persists one.
2. **Freeze the parked-run fixture before C changes the snapshot shape.** Capture it after and it proves nothing — it freezes post-migration rows. This is the one ordering mistake that cannot be recovered by re-running anything.

### Carried from slice A

`condition.inChannel` now reads the run's channel, but **that is not yet observable after a park** — nothing persists a channel, so the `channel` requirement is declared unsatisfiable after parking and such a graph is rejected at save. When C persists `channelId` and seeds it in `rebuildResumeContext`, it must also remove the `afterParking` message from `CHECKED_REQUIREMENTS.channel` and flip the corresponding `executor.test.ts` case. Both code sites carry comments saying so.

### Deliberately not in step 2

Each of these was in the original M2 scope. Each is a feature that *consumes* the data spine rather than being part of it, and each is a day's work against a spine that exists.

| Deferred | Why | Pull in when |
|---|---|---|
| **Reference picker + `valueType` vocabulary** | `{{var.<name>}}` already lets one block consume another's value, which is step 2's whole bar. The picker is a *nicer* way to wire IDs, not a second capability. It cost a twelve-site control surface, a three-member type vocabulary, a client-side reachability walk, and a new `ControlContext` seam | Authoring a real flow proves tokens insufficient for wiring |
| **List control (`fields`, string lists)** | First non-scalar control in the repo; may force a `ControlChange` signature widening across all eight existing controls | The embed block or pick-random actually needs it |
| **Full embed authoring** | Consumer of the spine. Flat scalars (URL, author, footer, timestamp, image, thumbnail) need no new control; only `fields` does | **Done** — shipped after step 3; see "Full embed authoring" below |
| **Random selection** | One block, one directory, formulaic once outputs exist | A flow wants it |
| **Per-trigger singleton guard** | Durable table, unique constraint, insert-as-guard. Well-understood, self-contained | Double-clicks actually open two tickets in practice |

Deferring the picker and the list control drops **two of the four planned contract amendments** (execution strategy §9). The strategy's own calibration expects 3–6 across all six steps; the original M2 was going to spend four alone.

## Step 3 — A run can ask a human a question

The bar is PRD §1.3 exactly: *a moderator presses a button in a channel and **that** parked run advances; non-moderators are refused.*

Read that sentence as three claims, because the slicing follows from them and nothing else: a run **parks on a question**, a press advances **that specific run** (not any run, not a new one), and a press by the wrong person is **refused**. Everything in §5.4 and §5.5 that is not one of those three is a follow-on.

### The scope lesson this step has to answer for

Steps 1 and 2 shipped no user-visible capability between them — thirteen blocks before, thirteen after — and that was noticed from outside, correctly. It happened because both steps were spine, and because every visible thing in step 2's original scope (reference picker, list control, embed authoring, random selection) got deferred while the spine was kept. Each deferral was individually defensible; the pattern was not.

**So step 3 is sliced so that the visible capability lands in the middle, not at the end.** The prompt block is the deliverable, and it lands at B3 — three commits in, with three more after it. Everything after B3 is hardening that prompt block against its own failure modes. If the step is cut short at any point from B3 onward, what exists is a working button that advances a parked run.

Be honest about the shape of that, though: A and B1 are both invisible, so this step still opens with commits that show nothing. That is not evasion of the lesson — it is the smallest such prefix available, since a prompt cannot name its exit before the resume reason can carry one, and cannot offer choices before a control can edit a list. The difference from steps 1 and 2 is that the invisible prefix is a couple of commits rather than two whole steps, and that it terminates in something to look at.

**It came in one commit shorter than planned.** B2 was budgeted as a third invisible commit and resolved into a decision with no code of its own, so the invisible prefix is A and B1. **B3 has now shipped**, so the step's visible deliverable exists and C is next.

Consequently the fan-outs §5.4 itself defers — the four new gateway triggers — stay deferred, and §5.5's custom events are **not in this step at all**. Reasoning below.

### What ships

| Slice | Content | Visible after it |
|---|---|---|
| **A** | Resume carries a **choice**, not a boolean — widen `FlowResumeReason`, thread it through `engine/flowRunResume.ts`, `engine/executor.ts`, and `blocks/conformance.ts` | Nothing. Interpreter-level, and wider than it looks — see below. **Done** (`1b58846`) |
| **B1** | **List control** — the first non-scalar control, and whatever `ControlChange` widening it forces across the eight existing controls | Authors can edit a list of things. No block uses it yet. **Done** (`db98870`), shipped as `textList` |
| **B2** | **Handles from config** — whichever resolution the manifest contract gets for a block whose handle count is authored, not declared | **Decided, no commit.** Fixed numbered handles won; everything left is B3's own declaration. Folded into B3 — see below |
| **B3** | **The prompt block** — posts a message with one button per choice, parks, resumes by the pressed choice's handle. Run-scoped custom id, new `flowc:` prefix handler | **A run asks a question in Discord and a press advances it.** This is the step's product. **Done**, over two commits (`9261171` groundwork, then the block itself) |
| **C** | **Audience gate** — a principal list evaluated against the clicker; ephemeral refusal; applied to the prompt block *and* to the existing trigger buttons, which today check nothing | Non-moderators are refused. This completes §1.3's step text. **Done** — shipped as `eligibility`, see below |
| **D** | **Lifecycle** — a second press refuses rather than advancing; buttons disabled on choice, timeout, and cancel; the prompt's timeout branch | A stale prompt cannot be pressed twice. **Landed** — see below for what the plan got wrong about it |
| **E** | **Run it against the real guild** — carried over from step 2, now with something worth running | Everything above, proven |

Each row is a commit. E is not a commit; it is the thing that makes the previous ones true.

**B was split into three, and landed as two.** It was one row in the first draft of this plan, and that was wrong: it bundled a control-signature widening across eight controls, a manifest-contract change, and the block itself — two of which are individually larger than slice A, which got its own commit precisely because it touches a documented contract. A commit containing all three could not be reviewed or reverted as a unit, and the thing that stalls if it goes wrong is the one visible deliverable in the step.

That split was right for B1, which shipped alone (`db98870`) and turned up four unchecked declarations on its way through. It turned out **not** to be right for B2: splitting it assumed a manifest-contract change that the wire format then ruled out, leaving a slice whose entire content was the prompt block's own declaration. So B2 is a decision rather than a commit, and B is two commits in the end — see B2 below for why, and for what was given up.

The visible capability therefore lands at the end of **B3**, which has now shipped — before C, D, and E, which is the sequencing property this step exists to have. **C and D have now shipped too, so only E remains** — and E is the one row that is not a commit.

B3 itself came in two commits rather than one: the groundwork that lets a block address its own run (`9261171`) went in separately, because it changes `FlowRunContext` and the executor's run-id ordering and is worth reverting independently of the block that needed it.

### Why custom events (§5.5) are not in this step

§1.3's step text does not mention them, and they fail rule 2 of §3.1 ("the bar is §1.3's step text"). Concretely they are a separate capability with their own hard problem — §5.5's last bullet, bounding run *creation* against cascades, which `FLOW_MAX_NODE_VISITS` does not touch because it bounds one run. Building an event bus in the same step as the prompt block would repeat exactly the M2 mistake: two capabilities, one plan, the harder one dragging the visible one.

They are owned, not dropped. The trigger to pull them in is **step 4**: §5.6's ticket blocks are the first concrete emitter, and "features outside flows can emit" has no call site until tickets exist. Correlation (§5.5's second bullet) is also better designed against a real correlation key — a ticket id — than against a hypothetical one.

What step 3 must **not** do is foreclose them. The one place that matters is slice A: widening the resume reason must not assume the only two resume sources are a gateway event and a clock.

### Why the four new gateway triggers are not in this step

§5.4's own text already says they "ship as a fan-out **after** the prompt block and event bus are stable", and §8 Q10 records that none is on the target journey's critical path. Message-posted additionally needs the channel *selector* vocabulary, which needs journey resource keys, which are step 5. Building it now means building it against a channel picker and rebuilding it in step 5.

**Channel selectors are therefore also out of step 3**, for the same reason: three of the five selector kinds §5.4 lists (journey resource key, any channel in a category, any ticket channel of a type) name things that do not exist until steps 4 and 5. The prompt block posts to *the run's current channel* or an explicitly picked one, which the existing `channelPicker` plus slice C of step 2 already cover.

### How much testing this step gets

**Around 90% is the target, and it is a ceiling as much as a floor.** Effort goes to the feature; tests cover it well enough to catch real breakage and no further. Stated here because slice A violated it and the violation was invisible from inside: 14 files changed, 9 of them tests, plus a review cycle and a sabotage run — to prove one type variant survives a function call, in a slice with no user-visible output.

That is the same failure as shipping two invisible steps, at a smaller scale. A 45-line test with a spy and a `finally` block, proving the engine passes an argument it was just typed to pass, is effort taken from the prompt block.

What this means concretely for the slices below:

- **Cover the branch, not the payload's journey.** One test per real behaviour. If a second test's assertions would be a superset of the first's, it is not a second test.
- **Do not spy on internals to observe a value in transit.** If the only way to see something is to mock the thing that receives it, `tsc` was already the proof.
- **Do not write a test for a capability nothing consumes yet.** The prompt block will exercise `choice` far better than any stand-in, and it is three commits away.
- **The four gates stay.** They are cheap, they run in seconds, and each has caught a real defect. This rule trims new bespoke tests, not the gates.
- **Sabotage-verification is for the racy guarantees only** — slice D's concurrency cases, where a passing test genuinely might prove nothing. Not for ordinary branches.

The deliberate consequence: some things will be uncovered, and a bug will occasionally reach slice E's live run instead of being caught by a unit test. That is the trade, taken on purpose.

### What each slice actually has to change

Grounded in the code as it stands at `b9e5381`, not from the PRD.

#### A — resume carries a choice

`FLOW_RESUME_REASONS` is `['event', 'timeout'] as const` with `FlowResumeReason` derived from it (`blocks/types.ts:15-17`, under a twelve-line doc comment at `:3-14` that explains why those two values are what they are). A prompt resumes by *which choice was pressed*, which is not one of them. This is the only interpreter-level widening step 3 requires, and it goes first and alone.

The shape to reach for is a discriminated object rather than a widened string union — roughly `{ kind: 'event' } | { kind: 'timeout' } | { kind: 'choice'; … }` — because a bare widened string leaves every existing `context.resume === 'timeout'` comparison compiling while meaning less than it did.

**One thing must be decided before this slice starts, not during B2:** is a choice identified by an **author-defined key** or a **positional index**? It determines the payload above, so getting it wrong means rewriting slice A — the exact cost that justifies A going first. It is decidable now, from the custom-id arithmetic alone: a `runId` UUID is 36 characters of the 100 available, and after a prefix and a node id an author's arbitrary label may not fit where a small integer always will. That argument points at the index and does not require resolving B2's manifest question.

This is wider than one file, and each of the following is why it is its own commit:

- **`FLOW_RESUME_REASONS` is built exactly like the frozen interpreter enums** this document protects below — a frozen `as const` array with the type derived from it, same as `FLOW_RUN_STATUSES` and `FLOW_STEP_OUTCOME_KINDS`. It is **not** one of them: those two are frozen because the *interpreter's own* state must not grow, whereas the resume reason names what happened outside the run, and a third external cause is a real new thing rather than interpreter creep. Recorded here so the growth is sanctioned rather than looking like the thing that rule exists to catch. The `:3-14` comment is decision-bearing and rewriting it belongs to this slice.
- **`conformance.ts:612-637` is the second consumer, and it is the one that bites.** `checkResumeTerminates` drives *every* block declaring `canSuspend` with *every* member of `FLOW_RESUME_REASONS` (`:623`) and asserts it does not re-park. Turning a flat array into a variant union means that loop has to synthesise a reason per variant — and for a `choice`, synthesise a key or index the block under test will actually recognise, or the prompt block fails its own conformance for a reason unrelated to correctness. There are currently two suspending blocks (`actionWaitForEvent`, `actionDelay/index.ts:59`), and both must come through unchanged.
- **`resumeFlowRun`'s `exit` is an inline literal union, not the alias** (`engine/flowRunResume.ts:286`, and again on `advanceClaimedRun` at `:316`); neither file even imports `FlowResumeReason`, and the prose at `:278-281` restates the two values a third time. So widening the alias produces **no error at either site** — the resume path keeps the old two-value vocabulary while the typecheck stays green, and the prompt block could never be handed a choice. Repoint both signatures at the type as part of A, or the widening is invisible exactly where it matters. `exit` also **defaults** to `'timeout'`, so a caller that forgets to say why a run woke gets an answer anyway; the default goes when the type widens.
- **Most of A's diff is in tests, and that is fine.** Both production sites already pass an explicit reason — `flowRunScheduler.ts:135` passes `'timeout'` directly, and `waitingRunDispatch.ts` passes `'event'` through a dependency seam typed `typeof resumeFlowRun`, so it tracks the signature automatically. Dropping the default therefore breaks no production caller. But there are **26 test call sites** across `durableRuns` (11), `parkedRunResume` (7), `parkedRunChannel` (5), `runVariables` (2), and `flowRunScheduler.test.ts` (1, an exact-argument assertion). If A changes the *shape* rather than just the union, every one of those literals changes. Budget for it rather than discovering it.
- **The reason is not persisted and must not become persisted.** It is supplied by whoever wakes the run. A pressed choice is known at press time, so it threads through the call, not the row. Adding it to `FlowRunContextSnapshot` would be the same mistake `actorId`'s absence already documents (`flowRunsSchema.ts:14-19`).
- **`engine/executor.ts:324-331`'s "woke onto nothing" failure** is written against a handle name and must keep firing for a choice handle with no wired branch. That is the difference between a prompt whose third button does nothing and a prompt that says why.

#### B1 — the list control

The deferral table in step 2 already named this and named its trigger: "List control (`fields`, string lists) — first non-scalar control in the repo; may force a `ControlChange` signature widening across all eight existing controls. **Pull in when: the embed block or pick-random actually needs it.**" The prompt block is that trigger, arriving earlier than predicted.

It is unavoidable either way — a prompt's choices are a list whichever handle design B2 picks, and slice C's `roles: [...]` gate is a list too. Doing it alone and first means the eight-control widening, if it happens, lands in a commit that contains nothing else.

**Note this is the one part of step 3 that is not "one new directory".** A block is: `blocks/registry.ts` scans the filesystem, so there is no array to append to. A ninth control is not, and the count is worth having before estimating: the arm in `blocks/manifest.ts`, `BLOCK_CONTROL_TYPES`, an entry in `CONFIG_FIELD_FIXTURES` (omit it and `FixturesAreExhaustive` in `nodeDescriptorDrift.test.ts:97-107` fails to compile), the `web/src/api/types.ts` mirror plus its `BLOCK_CONFIG_FIELD_KEYS` arm (the drift gate asserts this one `toBeDefined()`), a renderer under `web/src/flows/controls/` wired into `renderControl.tsx`, and `cardSummary.ts`. Six files, and the gates catch five of them loudly — which is the system working, but it is not one directory.

**Shipped as `textList`, and deliberately not as a generic list.** The two consumers this slice was justified by want different things: a prompt's choices are strings an author *types*, while slice C's role gate is ids an author *picks from a fetched set*. One control parameterised over an item control would be a framework whose only two instances differ in every respect that matters, so C's role list arrives as its own arm when C is built. The shared part — `ControlChange` accepting `string[]`, `defaultValue` moving off `BlockConfigFieldBase` onto each arm — is done and is what the next non-scalar control inherits.

Four things the slice turned up that the plan did not predict, all now fixed and all in the same class — *a declaration nothing was checking*:

- **`defaultValue` on `BlockConfigFieldBase` made a list default uninhabitable.** A base typed `string | number` intersects with an arm's `readonly string[]` to give `(string | number) & readonly string[]`, which nothing satisfies. Every arm already declared its own, so the base member was removed rather than widened.
- **`defaultDataFor` shared one array across every node.** The descriptor is fetched once per session; assigning its array by reference meant one node's edit would rewrite the declared default and every sibling. It copies now — shallowly, which is right while every list default is a list of strings, and is commented as the boundary it is.
- **`checkFieldMaxLength` silently checked nothing on a list.** Its probe is a bare string, which fails against any array schema, so it hit its own format-constrained escape hatch and returned no issues while the manifest claimed the limit was enforced. The probe is list-aware now.
- **A list's `minEntries`/`maxEntries` were declared and unchecked**, so a manifest could ask for more entries than its control would ever offer a way to add — a dead form that conformed. `checkFieldEntryBounds` holds them to each other and to the schema.

The last of those is worth reading before writing any further conformance probe, because the first attempt at it **introduced a false positive** and the fix is not obvious. A count check has to escape on a schema that constrains the entries themselves (`z.array(z.string().min(2))`, `z.array(z.enum([...]))`), which reject a probe of `'a'` at *every* length — and neither obvious single probe detects that. A one-entry list is rejected legitimately by any schema with a list `.min()`; an empty list is *accepted* by an entry-constrained schema precisely because it holds no entry to object to. What separates them is that a count constraint accepts a contiguous run of lengths and an entry constraint accepts none, so the escape is a sweep. Both the false positive and the fix were verified against real Zod rather than reasoned about.

#### B2 — handles from config

**This is step 3's real design problem, and it is a manifest-contract question, not a block question.**

Every existing block has a *static* `handles` array — `conditionHasRole` declares exactly `true`/`false`. A prompt's handles are one per authored choice. `BlockManifest.handles` is `readonly BlockOutputHandle[]`, a fixed array on the definition that is served to the browser and used by the executor's reachability check (`engine/executor.ts:293-299`) and by `resolveNextNode` (`:591-635`).

Two options, and this slice exists to pick one deliberately rather than by whichever hack compiles: either the manifest grows a way to derive handles from a node's config, or the prompt ships a fixed number of numbered choice handles that the author labels. The second is uglier and cheaper; the first is what G7 asks for.

**Decide it with the browser in front of you, not the drift gate.** `nodeDescriptorDrift` compares key *names* taken off the live registry plus seven closed vocabularies; only `BLOCK_HANDLE_TONES` touches handles at all, and a block whose `handles` were computed rather than literal changes no key name, so every assertion there passes either way. The gate will not inform this decision.

Choice identity — key versus index — is *not* settled here. It was decided before slice A, because it determined slice A's payload.

**Decided: the fixed numbered handles, with the card hiding the ones the author has not filled in.** The reasoning, because the constraint that decides it is not the one this plan first recorded.

What the plan expected to be binding was that the browser reads `descriptor.handles` off a statically fetched descriptor "with no access to a node's config". That is true as written and **misleading**: all seven readers of `.handles` already hold the node's config or reach it in one line — `FlowNodeCard.tsx:42` destructures it for the card summary, `graphValidation.ts:103` has the node, both `executor.ts` sites have the node, and both `styleEdge` call sites (`FlowBuilderPage.tsx:246`, `:311`) already `.find()` the source node and pass only its descriptor while discarding the config sitting next to it. Config availability was never the blocker.

The real blocker is **serialization**, at a site this plan did not count. `NodeDescriptor` is `Omit<BlockManifest, NonWireMember>` and `toDescriptor` is a *rest-destructure* (`nodeRoutes.ts:36`, `:51-54`) — deliberately a subtraction, so a new manifest member is served automatically rather than silently dropped. A `handlesFor(config)` function would therefore be picked up by that spread, typed as present on the descriptor, and then serialized to **nothing** by `JSON.stringify`, which drops function values. Not an error; a member the browser believes in and never receives. Adding it to `NON_WIRE_MEMBERS` fixes the typing (and `NonWireMembersAreWithheld` at `:70` forces the destructure to match, so that part is well guarded) — but it does not give the browser the handles, and the browser is what draws them.

That leaves two ways to get per-node handles across, and both are worse than the problem:

- **Server-computed.** `GET /api/nodes` is a *catalogue* route — `listBlockDefinitions()` is process-wide and has no nodes at all, so there is no config there to compute against. Handles would have to resolve on the graph load path instead, which means the descriptor stops carrying handles, every browser site stops reading `descriptor.handles`, and the shape the drift gate polices changes meaning.
- **Reimplemented in the browser.** A second copy of each block's derivation on the far side of the wire, held together by nothing — the drift gate compares key names and vocabularies, not function bodies. This is precisely the copy-that-rots that the manifest header and `nodeRoutes.ts:32` were written to prevent.

Against that, the numbered option is **one new block directory**: `handles` stays a static array, the wire format is untouched, the drift gate passes unmodified, and all seven readers work as written. `implementation-philosophy.md`'s "framework for one call site" is decisive — the derived option builds a general config→handles mechanism for exactly one block — and `elegance.md` does not dissent, because its "single-source derived state" rule argues *against* the browser reimplementation rather than for it.

It is also **forward-compatible by construction**: saved edges hold `sourceHandle: 'choice-3'`, and any later derivation that keeps index-based ids produces the same ids for a 4-choice prompt. `flowGraph.ts:49` types `sourceHandle` as `z.string().min(1).optional()` — unconstrained, no enum — so nothing at the storage layer locks either option in. The asymmetry is the argument: the numbered option is cheap and reversible, the derived one is expensive and paid at the contract boundary.

Three things checked rather than assumed, because each would have changed the answer:

- **A prompt with 3 of 5 handles wired still parks.** `executor.ts:299-302` is `.some()`, not `.every()` — one wired handle is enough. Early completion happens only at zero, which is the right behaviour anyway.
- **Save-time validation does not complain about unused handles.** `graphValidation.ts` walks `handleUseByNode`, built from the graph's *edges*; an unwired handle produces no edge and so no entry. The `:122` check fires only for edges on handles the block does not declare, and `choice-3` is declared.
- **`styleEdge` costs nothing** — it colours edges that exist, and a ghost handle has none.

**The honest cost, and who pays it for now.** Today's busiest block declares two handles; a five-handle prompt is the busiest card in the builder by some margin, and three of those five carry static labels for choices the author never wrote. `handlesAreLabelled` is `handles.length > 1` (`nodeMeta.ts:109`), so they all draw, stacked at `52 + index * 26`. The card is a small lie about the block, on the step's headline deliverable.

**B2 is therefore folded into B3 and ships no commit of its own**, by explicit decision rather than drift: once the wire format ruled out the derived option, everything left was either the prompt block's own declaration (B3's code) or a fix for those ghost handles. The ghosts ship as-is. That is a deliberate, visible debt, taken because the alternatives cost more than the wart does:

- Trimming the card properly needs the manifest to name which config field governs the count — a small data-only member that would serialize fine and that any future authored-handle block would reuse. **Still the right fix, and still available as one commit** if the ghosts prove intolerable when slice E puts them in front of someone.
- Special-casing the prompt block by type inside `FlowNodeCard` is the cheap version and is **rejected outright**: the manifest header's whole claim is that a block is one directory and "nothing outside that directory is edited to add it — no registry entry, no barrel line, and no file under `web/src/flows`". Buying a cosmetic fix by breaking that is a far worse trade than a busy card.
- Inferring the trim from a `choice-N` id pattern in the browser is a magic string that silently does nothing for the next block with a different scheme.

So: the block declares five handles, the card draws five, and an author with two choices sees three spare exits. The executor routes all five correctly and nothing about the contract moves. Revisit after E.

One risk this creates and B3 must honour: `executor.ts:330`'s `wokeOntoNothing` fails a run that wakes onto a handle with no wired branch. So the prompt must never post a button for a choice the author did not author — which falls out of building the buttons from the `textList`, but is worth stating because it is the failure mode of getting it wrong.

#### B3 — the prompt block

**Landed.** `blocks/actionPrompt/`, `engine/flowChoiceDispatch.ts`, the `flowc:` registration, and `__tests__/promptChoices.test.ts`. Three things below were planned one way and shipped another; each is corrected in place rather than left to mislead.

- **The prefix is `flowc:`, not `flowp:`.** `prompt` is in the vocabulary gate's `PROVEN_REJECTIONS` and `constants.ts` is gated, so `FLOW_PROMPT_*` would not compile past the gate. `choice` is already recognised vocabulary.
- **The prefix-safety reasoning below was wrong, and the correction matters more than the conclusion.** The claim was that the trailing colon is what keeps `flow:` and `flowc:` apart. It is not. With both registered with their colons the two prefix sets are *disjoint* (`'flowc:…'.startsWith('flow:')` is false), so nothing arbitrates between them and no dispatch rule is load-bearing. And registering `flow` **bare** still routes answers correctly, because `resolveDynamicHandler` keeps the **longest** match and `'flowc:'` is longer. A routing test was written, found to pass under both sabotages *and* with longest-prefix-wins inverted in the registry, and deleted as theatre; the reasoning is recorded at the top of `promptChoices.test.ts` so nobody writes it again. Keep both colons anyway — they guard the *next* prefix somebody adds (`flow` bare would match a future `flowsomething:`), which is a real reason where the stated one was not.
- **Run ids are minted up front.** A choice button must name its run, but `flowRunsRepo.create` used to mint the id *after* the executor returned a suspension. `executeFlow` now calls `randomUUID()` before the walk (`9261171`). The cost: a button can exist for a few milliseconds before its row does, so the dispatcher reports a missing row as *"may still be setting up — or it may be gone"* rather than promising a retry will help, because a deleted row lands on the same branch and retrying will never fix that one.

**Known debt taken here, on top of B2's ghost handles:** the posted question's buttons are never disabled. Nothing retains the sent `Message`, so a press after the answer, the timeout, or a restart costs a round-trip to be told the question is closed. That is **slice D's** work and it is already scoped there — D says plainly that the message edit is presentation and the claim is the authoritative guard, so the missing edit is the cosmetic half, not the correctness half. It needs the message id persisted on the suspension, which is a data change D can make once.

What the slice was planned to cover, kept for the reasoning:

- **Run-scoped custom id.** `parseFlowCustomId` returns `null` on anything but exactly three segments (`utils/customId.ts:25`), so the existing scheme cannot be extended in place — a fourth segment breaks every deployed trigger button. So a **second, separate prefix** (`flowp:`) with its own parser and handler: nothing about the trigger path changes. Be precise about why that is safe, because the obvious reason is wrong twice over. It is *not* "the strings differ" — `resolveDynamicHandler` matches by `startsWith` (`interactionsRegistry.ts:199`), so whether two prefixes collide depends on the exact registered strings, not on their being distinct. And it is *not* longest-prefix-wins either: `'flowp:x'.startsWith('flow:')` is **false**, so there is no contest to win. What actually saves it is the **trailing colon at the registration boundary** — `initFlows.ts:43` registers `` `${FLOW_CUSTOM_ID_PREFIX}:` `` while the constant itself is bare `'flow'` (`constants.ts:5`). Register either prefix without its colon and `flowp:` ids route straight into `handleFlowButtonInteraction`, which parses them to `null` and answers "Malformed flow button id" (`engine/flowTriggerDispatch.ts:23-24`) — a confusing user-facing error, not a crash, which is the worst kind to debug. `registerDynamic` throws only on an exact duplicate string (`:67-68`) and will not warn. So: register `'flowp:'` **with** the colon, and make it a registry test rather than an assumption.
- **Budget the 100 characters honestly.** A UUID `runId` is 36, which with a prefix and a node id leaves room for a choice identifier only if it is small — see the identity decision under slice A.
- **Settled: a prompt parks with no `waitKind`, and that closes both directions structurally.** `findWaiting` opens `.where('status','=','suspended').where('waitKind','is not',null)` (`flowRunsRepo.ts:256-261`), so a prompt-parked row is **never a candidate** for `resumeWaitingRunsForEvent` — a member pressing an ordinary trigger button cannot wake a run parked on a question, and the "woke onto nothing" hazard below cannot arise. In the other direction the choice dispatcher deliberately does not call `resumeWaitingRunsForEvent` at all: an answer is addressed to one run, and fanning it out would advance runs whose members pressed nothing. Both halves are properties of the park design, not guards that could be forgotten. The original framing follows.
- **Decide what a prompt press does to `resumeWaitingRunsForEvent`.** `engine/flowTriggerDispatch.ts:31-35` wakes parked runs on *every* flow button click, matching only `guildId` + `userId` + `eventKind: 'buttonClick'`, before the flow is even loaded. Two consequences, both currently undecided: a press on a `flowp:` button will not reach that path at all, so a run parked on a generic `buttonClick` wait no longer wakes when the user presses a prompt — an asymmetry someone should choose rather than inherit. And in the other direction, a user pressing an ordinary trigger button while parked on a prompt can have the prompt-parked run woken through that userId-only match with reason `'event'` instead of a choice, landing in `executor.ts:324-331`'s "woke onto nothing". That is a correctness question for D's one-winner guarantee, not a detail.
- **It must defer within 3 seconds** (§7). `engine/flowTriggerDispatch.ts:71-73` is the existing pattern.

#### C — audience gate

**Landed.** `engine/eligibility.ts`, the `eligibility` control arm across both trees, application in `flowTriggerDispatch` and `flowChoiceDispatch`, and `__tests__/eligibility.test.ts`. Four things below were planned one way and shipped another; each is corrected in place rather than left to mislead.

**It is called `eligibility` in the code, not `audience`.** Not drift: `audience` is a *proven rejection* in `engineVocabulary.test.ts` — "the audience for this welcome message" is exactly the use-case noun that gate exists to keep out of the interpreter — so admitting it would have blinded the check to that leak in order to buy one word. `eligibility` is §5.4's own term and carries no product meaning. The feature keeps the PRD's name; the module does not.

**One control, not a role-list control.** The plan called for "a role list" as the second non-scalar control. What shipped is a single `eligibility` control owning the whole `{ principal, ... }` object, because the extras are mutually exclusive and the field vocabulary cannot say "show this field only when that one is set" — three always-visible fields, two dead for any given choice, is the form that produces graphs holding a role list under a `subject` gate. The role list exists inside it.

**The gate can only *narrow* on the prompt surface.** `flowChoiceDispatch`'s ownership check runs first and is not authorable, so a rule there adds a second condition on the same member — it cannot let a moderator answer somebody else's question. That would need the ownership rule to become authorable, which changes what a `flowc:` button means and is not in this slice.

**The wake ordering was the slice's real hazard, and it took two attempts.** `resumeWaitingRunsForEvent` matches on guild, wait kind and member — never on *which* button was pressed. Placed above the gate, a refused press still advanced the presser's own parked runs, assigning roles and sending messages while reporting itself as a refusal that changed nothing. Moved below the gate but above the *flow-health* returns, because a deleted or disabled flow is not a refusal of that member and their run still needs waking. Both directions are now pinned by tests, and both were sabotage-verified.

Two halves, and the second is the one that earns the step text.

The **gate itself** is a principal list: `anyone`, `subject`, `actor`, a member reference to a run variable, `roles: [...]`, `discordPermission: [...]` (§5.4). Deliberately no "moderator" principal — §5.12 wants moderator roles promoted to a shared guild setting, that promotion is **not in this step**, and a `roles: [...]` gate already expresses "these roles" without the engine naming a subsystem. Evaluating it is a pure function over a `GuildMember` plus the run's variables, which is the testable shape; keep it out of the interaction handler.

**The gate must be authorable, or the step cannot demonstrate its own bar.** Dropping the "moderator" principal is only free if an author can actually set `roles: [...]`, and a role list is a non-scalar control — so slice C has a second, non-obvious dependency on B1 beyond the one B3 has. Without an authoring surface the step can finish with a correct evaluator nobody can configure, and slice E has no moderator press to demonstrate. Either C ships the authoring control, or it states plainly what E will be unable to show.

The **application** is the half that matters: §5.4 says "eligibility is a property of every trigger, not just buttons", and `flowTriggerDispatch.ts` has **no check at all** today — any member who can see a deployed flow button can run it. Gating only the new prompt block would leave the older, more exposed surface open while the step reports done. So slice C gates both, and the existing trigger buttons default to `anyone` so saved graphs keep working (the compatibility rule under "What stays load-bearing").

`memberJoin` eligibility and the "already completed" rule (§5.4's fifth bullet) are the part of that bullet that is **not** in slice C: an already-completed rule needs a durable per-member journey record that does not exist, and there is no journey until step 6. The audience *vocabulary* is built here; the join-time completion check is owned by step 6 and named here so it is not mistaken for done.

Refusal is ephemeral and changes nothing (§5.4's fourth bullet) — the failure mode it exists to prevent is a dead interaction, which Discord shows as an error to the user.

#### D — lifecycle

**Landed.** A new nullable `flow_runs.waitMessageId` and its migration, park-scoped claiming in `data/flowRunsRepo.ts`, `engine/waitMessageControls.ts`, the stale-press refusal in `engine/flowChoiceDispatch.ts`, five lifecycle cases in `parkedRunResume.test.ts`, and two dispatcher cases in `promptChoices.test.ts`. The plan's shape was right — two mechanisms, the claim authoritative and the edit cosmetic — but it was wrong about **what the claim had to be conditional on**, and that is the whole slice.

Once a choice is taken, the buttons must stop working. Note this is **two** mechanisms, not one: disabling the components on the message is cosmetic and racy, so the authoritative guard is that the run is no longer parked at that node. A second press after a first must land as a refusal, not a second advance, **even if the message edit failed** — so the check belongs on the claim, and the edit is presentation.

**The claim was not already sufficient, and the plan said it was.** This line originally read that `claimForResume` "already makes this a single conditional write with one winner", citing the timeout race it was built for. That is true and it is not enough: the claim's only guard was `status = 'suspended'`, which cannot distinguish one park from the next. A graph whose branch returns to its own question — "wrong answer, ask again", the obvious authored shape — advances, re-parks, and is once more `suspended` at the *same* `resumeNodeId`. Every condition a press was checked against then holds again, so a button from the previous asking advances the run a second time. The pre-existing "two resumers arrive together" test passes throughout, because both of its resumers contend for the *same* park; the hazard is two presses on *different* parks that are identical in every stored column.

**So a park had to become nameable.** `waitMessageId` is that name: each asking posts its own message, so it is the one value that differs between two parks at one node. `claimForResume(runId, claimedWaitMessageId?)` folds it into the same conditional UPDATE, and `resumeFlowRun` takes it from whoever is holding a control. It is optional because the poller and the event fan-out genuinely have no park to name — neither is holding a control, and neither is something a member can repeat at will.

**The timeout branch was already built, and the plan predicted work.** `PROMPT_TIMEOUT_HANDLE`, the `wakeAt`, and the `timeout` arm of `resumeOutcome` all shipped with the block in B3, and `findDue` never required a `waitKind` — so a prompt's timeout was wired end to end and nothing exercised it. Slice D added the coverage rather than the capability. Recorded because the reverse error (assuming a path works because it is written) is the one this programme keeps paying for.

**Cancel is structural, not reachable, and that is a friction report.** The acceptance text names three closers — choice, timeout, cancel — but `FlowRunsRepo.cancel` **has no production call site**; its only caller is a repo test. Nothing in the running bot cancels a run, because the operations view that would expose cancelling does not exist. Rather than invent an operator surface to satisfy the third closer, terminal transitions clear `waitMessageId` with the other resume fields, so a cancelled run's controls are refused by the claim the moment anything can cancel. What is *not* done is the message edit on that path: it lives in the resume path, which a cancellation does not go through. When the operations view lands, it calls `releaseWaitMessageControls` itself — that is one line, and it is named here so it is not rediscovered.

**A question parked before the column existed is exempt, deliberately.** Such a row has `waitMessageId` null while its buttons sit live in a channel. Claiming it against the message a press came from would match nothing and refuse that member *forever*, on a question that is genuinely open — the compatibility rule under "What stays load-bearing" broken by the very guard meant to tighten things. So the park name is withheld when the run has none, and such a run keeps precisely the guarantees it shipped with: the status and node checks, and the claim's own single winner. The hazard those rows still carry is the one they always had, and it expires as they do. This was found by probing the null case rather than by a test failing, which is worth recording: every suite was green with it broken.

**One lifecycle hole is left open, deliberately, and it is not slice D's to close.** A prompt node with *nothing* wired to any of its handles posts its message and buttons, and then `executeFlowSegment`'s reachability check (`engine/executor.ts:302-317`) discards the suspension and completes the run — so **no `flow_runs` row is ever written**. A press then finds no run and is told the question "may still be setting up", on a question that can never open. `graphValidation.ts` permits a prompt with zero outgoing edges, so this is reachable from the builder.

It is genuinely a hole and it is genuinely **not this slice's**: the check predates the prompt block and governs every suspending block, and the fix — running reachability *before* `definition.run` for `canSuspend` blocks — changes execution order for `action.delay` and `action.waitForEvent` as well. The prompt block only makes the consequence visible, because it is the first suspending block whose side effect is something a member can see and press. The honest fix is save-time: reject a `canSuspend` node with no reachable handle, the way fan-out is to be rejected (§5.1). Recorded here rather than folded in, because a change to when every block's `run` is called is not a thing to smuggle into a commit about stale buttons.

**Every way the run ends releases the controls, and getting that right took two review rounds.** Both misses were the same mistake in different places — treating "the segment ran and ended" as though it were "the run ended".

The first was the `finally`: `park`, `complete` and `fail` all go through `mustTransition`, which *throws* when no row moves, and the lifecycle already documents the case that reaches it — an operator cancels a `running` run, so the resumer's terminal write is rejected. Released after the branches rather than in a `finally`, that throw skipped the tidy-up. The release swallows its own failures and is idempotent, so running it with an exception in flight cannot mask the throw.

The second was worse, because it was the *common* case rather than the rare one: four guards in `advanceClaimedRun` fail the run **before** a segment ever runs — no `resumeNodeId`, visit budget spent, flow deleted, context unrebuildable — and each returned directly, past any `finally` around the segment. Two of those are the likeliest endings a real question has: the author deleted the flow, or the member left. They now go through a shared `failRun`, which resolves the channel itself rather than borrowing the rebuilt context, precisely because the guards that matter run before the rebuild exists. That resolve is deliberately **not** `rebuildResumeContext`: it fetches no member, and it answers `undefined` on any failure instead of throwing, because a run that has already been failed has nothing left to retry and a cleanup path must not be able to lose a terminal write.

**Two guards, and only the first is a guarantee.** The refusal holds whatever the client does; the disabling merely means most members never reach it. Discord greys the buttons out for anyone who loads the message afterwards, but a stale render can still send the press and an edit can fail outright — so `waitMessageControls.ts` swallows its own failures deliberately, which is sound *only* because it runs after the run has already moved on and the press it guards is refused regardless.

**This slice owns the concurrency tests, and slice E does not substitute for them** — it is the one place the 90% rule above buys nothing by economising. Two moderators pressing at once and a timeout firing as a press lands are guarantees a live-guild session is the *least* reliable way to exercise, and a passing test can genuinely prove nothing here, so these are worth checking actually fail when the guard is removed. Five cases went into `parkedRunResume.test.ts`, which already owns the claim-race shape, plus two dispatcher-level ones in `promptChoices.test.ts` — the stale-press refusal, and the pre-column exemption. The budget said "two or three"; everything past the third is a review or sabotage finding, each added because something showed a guard that nothing was checking. That overrun is within the rule rather than against it — §"How much testing this step gets" exempts exactly these racy guarantees — but it is worth naming, because four of the seven exist only because a guard was reverted and every suite stayed green.

Every guard was sabotage-verified — each reverted, a named test confirmed failing, then restored; ten in all, counting the three that arrived from review. Three were caught by **nothing** on the first pass: the dispatcher's stale-press refusal, the control release being wired into the resume path at all, and `setDisabled` itself, which no test reached because the harness posted an empty component list. Each of those tests exists because the sabotage run found the gap, which is the entire argument for doing it — and the last of them is the sharpest, since the release *was* being called and the assertion still proved nothing about what it did.

One thing worth knowing for the next slice: `blockConformance.test.ts`'s channel stub resolved `undefined` from `send`. `TextBasedChannel.send` always resolves a `Message`, so the harness was modelling a state that cannot occur, and the first block to read what it posted crashed against the fixture rather than against a defect. It resolves a message-shaped object now.

#### E — run it

**Done, 2026-09-15, driven by the operator against a real guild.** What it proved, so the claim is a list rather than a mood: a flow authored in the browser deployed a trigger button; pressing it posted a question; answering it advanced *that* run down the pressed choice's handle; a second press on the same message was refused rather than advancing again; the buttons were greyed after the answer; the prompt's timeout branch fired; and a run parked across a `Ctrl+C` and a `pnpm dev` restart still answered correctly afterwards. The three pending migrations applied cleanly against **SQLite** — so the postgres arm remains unexercised, as predicted below, and is recorded as hand-reviewed rather than covered.

The original text is kept below, because the sentence it opens with was true for three steps and is the thing this slice existed to make false.

Unchanged from step 2's slice D, and still not a formality. **Nothing in this engine has ever run against a live Discord guild or in a real browser.**

Three migrations are committed but have never been applied to a database (`2026-09-14-Add_Flow_Run_Variables`, `2026-09-15-Widen_Flow_Run_Context_Snapshot`, `2026-09-16-Add_Flow_Run_Wait_Message`), and the pre-flight for that is **not** "watch whether the bot boots". Nothing migrates at boot — `src/bot.ts` never invokes the migrator; migrations run from a separate CLI (`pnpm migrate:latest`), chained into the `dev` script only. The migrator reports per-migration results and sets a non-zero exit code on the first failure, so a **half-applied chain is reachable**: 09-14 lands, 09-15 fails, 09-16 never runs, and the bot afterwards starts perfectly well and fails later at query time. Watch the CLI's exit code, not the boot.

Two questions to settle before running, both asked during step 2 and unanswered:

- **Which database is dev pointed at?** SQLite leaves the postgres migration arm unexercised; record that honestly rather than claiming coverage.
- **Who drives the Discord interactions?** A live guild is outward-facing. Get explicit authorization before posting anything into it.

### Ordering constraints

Two of these are real dependencies. The others are preferences, and saying which is which matters more than the order itself.

1. **A before B3** — *a dependency.* The prompt block cannot name its exit until the resume reason can carry one. Building it first means building against `'event'` and rewriting.
2. **B1 before B3, and B1 before C** — *a dependency.* Both the choice list and the gate's role list are non-scalar controls.
3. **C before D** — *a dependency.* Refusal and "already answered" are the same ephemeral surface; the lifecycle guard first means building the refusal path twice.
4. **B3 before C** — **a preference, not a dependency**, and the one to revisit if anything slips. The reason is design quality: the gate becomes a shared vocabulary rather than a prompt-block private if it has two call sites when it is written. The cost is real, though — `flowTriggerDispatch.ts` has **no eligibility check at all today**, so this sequences an existing authorization hole behind the step's riskiest work. It stands because B1 comes first regardless, because the hole is gated behind a deployed button in a guild whose admin is the operator, and because a gate shaped by one caller is the failure this step is most likely to repeat from step 2. The escape hatch this clause reserved — invert the order if B2 turns out worse than expected — is **spent**: B2 resolved to a decision with no commit, so nothing is left to overrun. If B3 itself slips, invert then.

**Settled.** The order held, and the bet paid: the gate was written with two call sites in front of it and is a shared vocabulary rather than a prompt-block private. **The authorization hole named here is closed** — `flowTriggerDispatch` now refuses before it starts a run, and before it wakes anything.
5. **E last, and E is not optional.**

### Deliberately not in step 3

| Deferred | Why | Pull in when |
|---|---|---|
| **Custom events (all of §5.5)** | Not in §1.3's step text; needs cascade bounding on run *creation*, which is its own hard problem; has no emitter until tickets exist | **Step 4** — ticket lifecycle is the first real emitter and the first real correlation key |
| **The four new gateway triggers** (message posted, role gained, role lost, member left) | §5.4 and §8 Q10 both already schedule these as a post-prompt fan-out, off the critical path | After prompts and the event bus are stable |
| **Channel selectors** | Three of the five selector kinds name resources that do not exist until steps 4–5; building now means rebuilding in 5 | **Step 5**, with journey resource keys |
| **Watch scope bounding** | Exists only to bound message triggers, which are deferred | With message triggers |
| **Shared guild settings / moderator promotion (§5.12)** | `roles: [...]` expresses the gate without it. Promotion is a six-call-site convergence in the tickets feature (§5.12), not a flows change | **Step 4**, which is already in the tickets feature |
| **`memberJoin` already-completed rule** | Needs a durable per-member journey record; no journey exists yet | **Step 6** |
| **Operator run controls** (cancel / retry / advance) | §8 Q11 resolved this to read-only first, controls at M6 | Step 6 |
| **Rejecting `{{var.<name>}}` at save time** | The naming half is **done**: `BlockOutputDeclaration` now discriminates `fixed` from `authored`, `resolveOutputName` resolves either against a node, and the builder offers the variables in scope and warns about a name nothing upstream writes. What is left is reachability — "no upstream block produces this" has to quantify over paths, and a variable written on only one branch of a split is a real graph. An offer that is wrong costs a keystroke; a refusal that is wrong costs a save | When somebody decides which reading a rejection takes. See `checkCopyTokens` in `graphValidation.ts` |

### Carried from step 2

- **Slice D of step 2 is absorbed as slice E here**, deliberately. Running the infrastructure alone was low-value; running it with a prompt block on top is the same work with something to see.
- The **`unavailable` retry backoff** (Carried forward, below) becomes more pressing in this step: a prompt parks runs for as long as a moderator takes to answer, which is the longest park the engine will have seen.
- The **fan-out drop in three places** and **only-the-first-matching-trigger-fires** are both still open and both now have a second reason to care — a prompt with several choices makes handle-following the hot path.

## Step 4 — A flow can open and drive a ticket

The bar is PRD §1.3 exactly: *a verification ticket is opened by a flow, is distinguishable from a support ticket, and its channel is addressable by later blocks.*

**Done, and verified against a real guild by the operator on 2026-09-15** — the whole surface including the flow-block path. §1.3's bar is met: a verification ticket is opened by a flow, is distinguishable from a support ticket, and its channel is addressable by later blocks.

That verification is the part worth weighting. Every defect that mattered in this step was invisible to typecheck and to a green suite — the creation modal wrote no ticket row at all while both gates passed. A live run remains the only thing that closes a step here.

**Carried into step 5**: ticket triggers (opened/claimed/closed/deleted) are not built. The columns record the transitions; nothing emits them. The design question is the interesting half — the service must stay flows-free, so it cannot call the flow dispatcher directly.

What follows is the ground truth the step was built against, recorded when it arrived from the operator because it materially shrank §5.6.

### What has landed (2026-09-15, `ead2348`)

The foundation, verified against the real dev database rather than only the typechecker.

| Piece | File | Note |
|---|---|---|
| Durable record | `tickets` table + `data/ticketsSchema.ts` | `status` is `open`/`closed`/`deleted`, claimer in its own nullable column, `channelId` nullable |
| Migration | `migrations/2026-09-17-Create_Tickets_Table.ts` | Applied to dev SQLite; columns, nullability and all three indexes confirmed by `PRAGMA` |
| The deliverable | `ticketService.ts` | Discord-free and flows-free; every transition states what it refuses |
| Type vocabulary | `logic/ticketTypes.ts` | Permission model and name template **per type**, lifted to data |
| Discord effects | `logic/ticketChannelOps.ts` | Takes a `Guild`, not an interaction — the change that makes a flow able to open a ticket |
| Rendering | `logic/ticketPresentation.ts` | The embed is now a *rendering* of the row, with no hidden state field |
| Adapters | 3 blocks: `action.openTicket`, `action.closeTicket`, `condition.hasOpenTicket` | Blocks 16–18; they decide nothing |

**Three long-standing defects fixed as a by-product**, each because the new path had to state the intent anyway: numbering is atomic (the unused helper is now the only path), name templates are per type and actually honoured, and the permission model is declared once instead of re-derived at creation/close/reopen.

**Evidence, not assertion.** A live round-trip against the dev database confirmed the two properties the redesign exists for — claiming leaves `status` untouched, and a deleted ticket keeps its row while ceasing to resolve by channel — plus that the unique number index rejects a duplicate. The double-claim guard was sabotage-verified: removing it fails exactly one named test. Typecheck holds at the pre-existing 17 with none in touched paths; 852/853 tests pass, the single failure confirmed pre-existing on a clean stash.

### The cutover, completed (`a69f5e0`)

Decision 3 is now cashed out. The mod-facing surface runs on the service, and **the old system is deleted rather than bypassed**: `ticketState.ts`, `createTicketChannel.ts`, `buildTicketChannelName.ts`, `ticketChannelValidation.ts` and `ticketChannelUtils.ts` are gone, along with the dead close/reopen permission paths. The five button handlers share one `resolveTicketAction` gate instead of forty drifted lines each.

**A review caught one thing that would have broken on the first ticket**, and it is worth recording because it was invisible to every gate: the creation modal never called `openTicket`, so a mod-created ticket had a channel and no row — and every button on it would have refused. Worse, the modal still wrote the counter *absolutely*, which would have silently reverted the service's atomic increment and handed the next flow-opened ticket a duplicate number. Typecheck and tests were both green with that in place.

Five further defects fixed, all of the same character — correct-looking code with an invisible failure:

- **Check-then-act on every transition.** Two moderators racing Claim both passed the read and the second silently won. Close racing delete could produce a row that is `closed` while carrying `deletedAt`, which the status union says is impossible. Each guard is now a conditional `UPDATE`; zero rows back *is* the refusal.
- **Errors after `deferUpdate` were discarded by the registry**, so every refusal the new state machine produced was invisible — pressing Claim on a claimed ticket did nothing at all.
- **A deleted ticket routed its channel to the *open* category**, via a ternary chain with no case for it. Both status chains are exhaustive switches now.
- **`Number('')` is `0`** and passed the integer guard, so an unresolved token closed "ticket 0".
- **The sqlite `updatedAt` default was `CURRENT_TIMESTAMP`** — zoneless, parsed as local time, while every written value is UTC. Invisible on a UTC host. The dev table was empty, so it was rebuilt rather than patched.

**The test gap the review named was real and is closed.** The service tests mock the repo, so they could not see `returningAll`, date coercion, or the unique index — all three verified by hand once and pinned by nothing. There is now an in-memory integration test running the migration's own sqlite arm. Writing it caught a trap worth knowing: `SqlDatePlugin` matches camelCase keys, so it must run *after* `CamelCasePlugin` or every timestamp silently stays a string.

**Still open**: the postgres arm remains unexercised and hand-reviewed, recorded honestly rather than claimed as covered. Triggers (opened/claimed/closed/deleted) are not built — the columns that support them exist, but nothing emits them yet.

### A pattern in this feature: written, never wired

Found while writing the test plan, and worth stating because it has now bitten three times in the same directory:

- `ticketingRepo.incrementTicketNumber` — the atomic counter, written and never called, while the racy path ran in production.
- `ticketChannelValidation.ts` — three predicates with zero callers, sitting exactly where a backfill author would look.
- **`commands/ticketCommands.ts`** — a `/tickets` command with `config`, `create` and `add-user` subcommands that was **never registered**. `bot.ts` registers only `deploy-ticket-system`. Config is reached through a ⚙️ Configure button on the deployed panel. **Deleted in `87b542f`**, along with the deploy command's next-steps copy that told operators to run it.

The lesson is operational rather than architectural: **in this feature, an exported symbol is not evidence of a live path.** Grep for the call site before describing anything here as a user-facing surface — I described `/tickets config` as a test step and the operator caught it.

**A hazard recorded here on 2026-09-15 turned out not to exist, and the mistake is the more useful record.** This document claimed that saving ticket config resets `ticketNumberInc` to 0, making a mid-life re-save collide with the new unique index. It does not. `ticketConfigModal.ts:230` writes `ticketNumberInc: 0` only in the `else` branch — the first-time insert, where 0 is correct. The existing-config branch calls `ticketingRepo.update({ guildId, config })`, which sets only the columns present in that object, so the counter is untouched.

Verified against the dev database rather than re-read: three tickets, then a config re-save, counter still 3.

The error was reading `ticketNumberInc: 0` off a grep line and asserting a behaviour without checking which branch it sat in — the same shape as the `/tickets` mistake directly above, a symbol mistaken for a live path. Both happened in one session, in this feature, which is what makes the rule worth stating rather than the individual facts.

### Decisions taken (2026-09-15) — these override §5.6 where they conflict

Four operator decisions, in the order they were taken. Together they turn step 4 from a hazardous brownfield cutover into a greenfield build, and **each one retires requirements that §5.6 spends most of its length on**. Recorded before any code exists, because the research below was written under the old assumptions and parts of it are now moot.

**1. The table carries what a decision needs, not a pointer to it.** Detailed in the section below. The `tickets` table exists so a flow can decide without touching Discord.

**2. Existing tickets are abandoned in place, not migrated.** Moderators will close out the few open tickets by hand; the new system is never asked to manage them. This retires, entirely:

- the backfill out of Discord — no channel reads, no embed decoding, no idempotent-and-resumable migration against a rate-limited API;
- §5.6's *"the cutover is reversible until confirmed"*, *"cutover is planned, announced, and bounded"*, and *"no silent degradation at the seam"* — all three were priced for a migration that no longer happens;
- the entire "which store wins" question, and with it the dual-read period;
- the ticket-number collision risk, since **the table starts empty and every row in it is created by the new system**. Numbering can be correct from the first row rather than compatible with whatever is already in the wild.

The earlier research below — on `findTicketStateMessage`, the live-button hazard, the identification trap — is kept because it documents *why the old design could not be extended*, which is the justification for replacing it. It is no longer a migration plan.

**3. The old ticket system is replaced outright, not run alongside.** No coexistence period in code.

**The cost this carries, stated plainly:** open tickets lose their working claim/close/reopen/delete buttons the moment the old handlers go. "Finished manually" therefore means moderators renaming and moving those channels **without** working controls. The operator chose this knowing the alternative was to leave the old entry points running until the channels drained. It is recorded here rather than buried, because it is the one user-visible regression in step 4 and it should not come as a surprise on the day.

**4. Ticketing is a base capability of the bot. Flows are a consumer of it, not its owner.** This is the strongest constraint on the architecture and it inverts how §5.6 reads.

Tickets are **not** a flows feature. The ticket service is the deliverable; ticket *blocks* are a thin adapter over it. Concretely:

- The service is **Discord-interaction-free and flows-free** — it must not import anything under `src/features/flows/`. A dependency in that direction is the defect this decision exists to prevent.
- §5.6's *"tickets remain usable without flows"* stops being a compatibility promise to keep and becomes **the architecture**. A guild with zero flows configured has a fully working ticket system.
- The mod-facing surface (create, claim, close, reopen, delete, the panel) belongs to the ticket feature and is built there, not reached through a flow.
- Flow blocks, conditions and triggers are adapters **over** the service surface, in the direction flows → tickets only.

This also resolves an ambiguity §5.6 never states: the new system serves **support tickets too**. Support is simply the first ticket *type* and verification the second, rather than support staying on a legacy path. There is no second ticket implementation to maintain.

### The table is the decision surface, not an index into Discord

**Directed by the operator, and it sets the shape of the whole step.** The `tickets` table is not there to help find a channel faster. It is there so that **a flow can decide without touching Discord at all**, and it should carry whatever a decision needs — not merely a pointer to where the answer is rendered.

The difference is not academic. "Does this member have an open verification ticket?" today means: list channels, filter candidates, fetch pinned messages, decode a base64 blob, read `status`. Every step is a rate-limited API call that can fail or return stale cache. A condition block asking that on `memberJoin` pays it per member, and `findTicketStateMessage`'s three-tier fallback (cache → pinned → last ten messages) means the cost is unpredictable rather than merely high. With the row carrying subject, type and status, the same question is one indexed query, and the channel id is dereferenced **only when a flow actually posts something**.

Three consequences follow, and they are what make this a design principle rather than a schema note:

- **Denormalise deliberately.** Anything a *condition* needs is a column, even where Discord is nominally the owner — subject, opener, claimer, type, status, opened/closed timestamps. A condition that has to resolve a snowflake to answer has not been moved off Discord, it has just moved the call somewhere less obvious.
- **The channel id is an output, not an identity.** A ticket is a record that *has* a channel. That ordering is what lets a flow reason about a ticket whose channel was deleted, and it is the opposite of today's model, where the channel is the only handle and its embed is the only state.
- **A deleted channel must not destroy the record.** Today it does, completely and silently. Once the row is the decision surface, "the channel is gone" becomes a *fact about the ticket* rather than the erasure of one — which is also what makes §5.9's per-member journey state answerable at all.

This is the strongest argument yet for the full refactor over a parallel path: a second store that Discord can silently contradict is worse than either store alone, because a condition would read the fast one and be wrong.

**What the columns have to be, derived from consumers rather than guessed.** §5.6 names three groups that read this table, and between them they fix the shape:

| Consumer (§5.6) | What it must answer without a Discord call |
|---|---|
| *Conditions*: is of type, is claimed, subject has an open ticket of type X | `type`, `claimerId` (null = unclaimed), `subjectId`, `status` — all indexed, since "subject has an open ticket of type X" is the hot one and runs per member |
| *Triggers*: opened / claimed / closed / deleted, filterable by type | the same columns, plus the transition timestamps that say *when* — a trigger fires on a change, so the row must record changes rather than only current state |
| *Blocks*: open (outputs `ticketId`, `channelId`, `claimerId`), post, close, reopen, delete, assign | `channelId` as an output, and a stable `ticketId` that a later block can hold across a park |

Two things fall out of that, which a field list written from §5.6 alone would miss:

- **`status` cannot stay the current three-value set.** `TicketState.status` is `'active' | 'claimed' | 'closed'`, which conflates *claimed* — a fact about who owns it — with *open/closed*, a fact about lifecycle. §5.6 wants "is claimed" and "has an open ticket" as **separate** conditions, and they are not separable from a single enum where claiming moves you out of `active`. Claimer belongs in its own nullable column and `status` reduces to the lifecycle. This is the one place the existing shape should *not* be transcribed, and it is the reason the table is a redesign rather than a copy.
- **`deleted` is a status, not a row deletion.** §5.6 lists a delete *trigger*, which cannot fire on a row that no longer exists. It also means the record survives to answer "did this member ever have a verification ticket?", which §5.9's per-member journey state needs.

**Flows-side schema freedom applies here.** Per the ground truth below, nothing is using flows, so the flows half of this can be designed correctly rather than compatibly. The tickets half cannot — it has live data — which is exactly the seam the cutover runs along.

### Ground truth, from the operator (2026-09-15)

Four facts. Each removes work the PRD assumes, and the first two are the reason this step is smaller than §5.6 reads.

- **Flow data needs no migration care. Nobody is using flows.** Every `flow_runs` row is test data from development. A flows migration that fails, or one that drops a column, costs a re-run and nothing else. **So flows-side schema changes are free** — design the table that is right, not the table that is reachable from the current one by a safe migration. This is the last step at which that will be true, so anything wanting an awkward schema change should take it now.
- ~~**Tickets are live and must not break.**~~ **Withdrawn by decision 3.** This was the hardest constraint on step 4 as originally stated — every control on an open ticket keeping working exactly as today. The operator withdrew it on 2026-09-15 in favour of replacing the old system outright and finishing the open tickets by hand. Struck rather than deleted because it shaped every piece of research above it, and because the *reason* it was dropped matters: it was not decided that breaking them is acceptable in general, but that a handful of support tickets a moderator can close manually is a smaller cost than a coexistence period.
- **Every existing ticket is a support ticket**, using the support feature in its entirety. There is no second kind in the wild, so there is no per-type variation in production data to preserve — a migration has exactly one shape to handle, and "distinguishable from a support ticket" can be satisfied by *adding* a type rather than by reclassifying anything.
- **There are no onboarding tickets and no onboarding data to carry.** Onboarding runs on a different bot entirely. So step 4 builds the verification ticket type **greenfield** — nothing to import, nothing to reconcile, no dual-read period against an existing onboarding corpus.

### What this changes about §5.6

The decisions above retire most of what §5.6 spends its length on. What survives, and what does not:

**Retired outright** — every one was priced for a migration that no longer happens: *"the cutover is reversible until confirmed"*, *"cutover is planned, announced, and bounded"*, *"no silent degradation at the seam"*, and Q3's *"accept losing claim/status history"*. There is no cutover, no seam, and no history to lose, because the table starts empty.

**Promoted from requirement to architecture**: *"tickets remain usable without flows"*. Decision 4 makes this structural rather than a promise to keep — the service cannot import flows, so the property holds by construction rather than by testing for it.

**Still fully in scope, and now the actual work**: ticket types with their own category, name template, permission model and controls; durable ticket records; the Discord-free service surface; ticket blocks, conditions and triggers; atomic numbering; categories referenced by id rather than name; and the layout rule for flow-owned buttons inside a ticket. These were always the substance. Removing the migration removes the risk, not the requirements.

**Newly cheap, because the table starts empty**: atomic numbering and id-not-name category references were both framed as fixes to existing damage. They are now simply *how it is built the first time*, with nothing to correct.

### What is no longer risky, and the one cost that remains

**The migration risk is gone.** The earlier research below identified the live in-ticket controls as step 4's sharpest hazard: buttons posted by old code, sitting in channels, that a refactor had to keep answering. Decision 3 removes the problem by not trying — those buttons stop working when the old handlers go, and the tickets they belong to are finished by hand.

**What remains is not a risk but a stated cost** (decision 3): moderators close out the open tickets without working controls. There is no technical mitigation because none is wanted; the alternative was keeping the old entry points alive, and that was declined.

**So step 4 now has no live-data hazard at all.** Every remaining hard part is ordinary greenfield design — the permission model, the type vocabulary, the service boundary — rather than anything that can damage something already in use. That is a materially different step from the one §5.6 describes.

### How the old system worked, and why it was replaced rather than extended

> **Post-mortem, not a plan.** Written while a migration was still expected; kept because it is the evidence for decisions 2 and 3. The sentences about what "the cutover" or "the backfill" must do describe work that is no longer happening.

A ticket today **is its embed**. The message carries the state as base64 JSON in a field named `🔧 Internal Data`, the buttons hang off that same message, and a press makes the ticket read its own data back off itself before acting. The database holds almost nothing: `data/ticketingSchema.ts` has only `ticketing_config` — per-guild settings and a `ticketNumberInc` counter. **There is no `tickets` table.** The embed is not a rendering of a record, as §5.6 wants it to become; it *is* the record.

The full chain on a press is therefore:

> press → `interaction.channel` → find the message carrying the state embed → decode the blob → act.

Verified in `components/ticketClaimButton.ts`: the handler receives no ticket identity at all, takes `interaction.channel`, and calls `findTicketStateMessage`.

Two consequences, and they pull in opposite directions.

**The good one: live buttons cannot be invalidated.** The custom ids are static string constants with no per-ticket payload — `ticket_claim_button`, `ticket_close_button`, and so on (`logic/ticketButtonConfigs.ts`). A live button names an *action*, not a state. The migration does not have to preserve an id format, and there is no fourth-segment problem like the one that forced step 3's prompt block onto a separate `flowc:` prefix. Any button in any channel keeps working so long as something can still resolve a ticket from that channel.

**The sharp one: the state message is the only copy, so the cutover must not damage it.** Because the embed *is* the record, rewriting it is not a cosmetic refresh — it is a write to the sole store. `updateTicketState` already does a read-modify-write of it on every claim/close/reopen (`ticketState.ts:295-336`, unguarded). During cutover the rule is therefore **backfill by reading, and leave the embeds intact**: that keeps the rollback path §5.6 worries about losing, at no cost, since nothing needs the field's space back. The failure to avoid is a migration that "tidies" the `🔧 Internal Data` field away and takes the only copy with it.

The resolution exposure is nameable and mostly pre-existing: `findTicketStateMessage` tries a 48-hour in-memory cache, then **pinned messages**, then **the last 10 messages**. A ticket whose state message was unpinned, deleted, or pushed beyond 10 messages is **already unresolvable today** — its buttons are already dead. So the backfill's job is to read each open channel once and write a row, and any channel it cannot read was broken before step 4 touched it. Worth establishing before the cutover, because it means such a failure is a pre-existing fault being surfaced rather than migration damage, and the two would otherwise look identical on the day.

One further thing that makes the corpus easy, from the current code rather than the PRD: **the `TicketState` shape is already explicit** (`ticketState.ts:21-31`) — id, target, creator, title, reason, status, claimedBy, timestamps. That is very close to the durable record §5.6 asks for, so the table's columns are largely a transcription rather than a design.

Because there is no table to alter, the "migration" is a **backfill out of Discord**: read each open ticket channel, decode its embed, insert a row. That is unusual enough to name — it means the migration's input is a live API subject to rate limits and partial failure, not a table it can transactionally read, so it must be **idempotent and resumable** rather than a single pass assumed to succeed.

This is still the part to design first and verify against the live guild, and it is still the reason this step ends in a live run. It is just a smaller, better-understood risk than "a hazardous cutover".

### Two defects in the creation path, confirmed against the code

§5.6 names both. Both are real, and the first is worse than it reads there.

**Ticket numbering is not merely racy — it is read-modify-write across an `await` boundary, and the atomic helper that exists is dead code.** `createModTicketModal.ts` does `configEntity.ticketNumberInc += 1` in memory (`:93`), creates the channel, and only then persists the counter (`:118-121`). So the window is not a few instructions: it spans a **channel-creation round trip to Discord**. Two moderators filing tickets within that window both read the same number, both name a channel with it, and the second write silently overwrites the first. Meanwhile `ticketingRepo.incrementTicketNumber` — a single atomic `UPDATE … SET x = x + 1 RETURNING` — **has no call site anywhere in `src/`**; it was written and never wired up.

That matters for step 4 beyond tidiness: ticket *number* is the natural human-facing key, and a durable `tickets` table wants it unique. Backfilling a table from channels whose numbers may already collide is a different job from backfilling one where they cannot. **Check the live channels for duplicate numbers before designing the key**, rather than discovering a unique-constraint violation during the cutover.

**The channel-name template is configurable in the UI and thrown away on save.** `ticketConfigModal.ts:214` writes `ticketChannelNameTemplate: SUPPORT_TICKET_NAME_TEMPLATE` with the comment `// Non-configurable`, overwriting whatever the operator typed — while `:69` pre-fills the field with their previous value, so the form presents itself as editable. `buildTicketChannelName` ignores the stored config entirely and uses the hardcoded constant. Per-type name templates are a step 4 requirement, so this is on the critical path rather than a wart: the field, the storage, and the UI all already exist and are merely disconnected.

### How a ticket channel is identified today — and the trap in it

> **Superseded by decision 2: there is no backfill.** Kept because it is evidence for decision 3 — the identification scheme below is one of the reasons the old design could not be extended to a second ticket type. Read it as a post-mortem, not as instructions.

The backfill's first question was "which channels are tickets?", and the code answers it twice, inconsistently. **Neither answer was usable.**

`logic/ticketChannelValidation.ts` exports `isTicketChannel`, `isActiveTicketChannel` and `isClosedTicketChannel`, which look exactly like what a backfill wants. They identify a ticket by **regex on the channel name** (`/^s\d+-[^-]+-.*$/`) **plus its category name**. Both halves are unsound:

- The name pattern hardcodes the `S####-user-creator` shape, so it recognises only tickets built from today's one template. Per-type name templates are a step 4 requirement, and the moment a verification ticket is named anything else this predicate stops seeing it.
- It matches the **category by name**, which §5.6 already flags as fragile — renaming a category in Discord silently breaks it.
- `isActiveTicketChannel` requires the parent to be `supportTicketCategoryName`, but **`createTicketChannel` puts every new ticket in `claimedTicketCategoryName`** (`:44`, because a mod-created ticket auto-claims). So a freshly created, genuinely active ticket fails `isActiveTicketChannel`.

**All three functions have zero callers.** That is what makes this a note rather than a defect: `grep` across `src/` finds no use outside their own file, so nothing is currently broken by them. They are a stale identification scheme sitting in the obvious place a backfill author would look, describing rules the live code does not follow.

The **actual** way a ticket is recognised at runtime is `findTicketStateMessage` — the presence of a decodable state embed in the channel. That is the sound one, because it keys on the thing that makes a channel a ticket rather than on a name convention. **The backfill should use that and delete the dead predicates**, rather than inherit a naming rule that a second ticket type immediately invalidates.

### The permission model is per-instance, which is the thing §5.6 forbids

§5.6's first requirement is that a type's permission model is not overridable per instance. Today there is no type, and the overwrites are written inline at creation (`createTicketChannel.ts:68-99`): deny `@everyone`, allow target, allow creator, allow bot, then a loop adding each mod role. `closeTicketChannel` and `reopenTicketChannel` re-derive a *different* arrangement on each transition.

So the permission intent exists only as three separate code paths that happen to agree. A verification type needs a different arrangement (subject-plus-staff, per §5.10), and adding it by branching inside those three paths is how the "type's model is enforced by the type" requirement gets quietly lost. **The intent wants lifting to data before a second type exists, not after.**

One live consequence worth noting while the code is open: `reopenTicketChannel` restores `@everyone` to `null` — inherit from category — while `createTicketChannel` explicitly denies it. A reopened ticket therefore has a *more permissive* `@everyone` rule than the same ticket had when new, and whether it is actually visible depends on the category it is reopened into. Not a step 4 blocker, but the kind of drift that a declared permission model would make impossible to express.

### Postgres, priced correctly

Recorded because this document previously over-weighted it. Dev runs SQLite, so every migration's postgres arm is unexecuted code that ships as though tested, and the migrator's non-zero exit on first failure makes a **half-applied chain** reachable — one migration lands, the next fails, the rest never run, and the bot boots fine and fails later at query time.

That is a real hazard with a **narrow blast radius**: for flows it breaks a feature with no users, which is an inconvenience.

**Decision 2 narrows it further.** The ticket-side migration is now a `CREATE TABLE` against an empty table, not a data migration — so the worst case on production postgres is that the create fails, the ticket feature does not work, and the fix is to correct the migration and re-run. No data can be damaged, because there is none to damage. Postgres is therefore **not a gate on step 4 either**; it is something to check when the new ticket system first runs against production, like any other new table.

The arm remains unexercised and is still recorded honestly rather than claimed as covered.

## Step 5A — A journey can build its own home

The bar is PRD §1.3 exactly: *installing a journey on an empty guild creates its categories, channels, and roles with correct visibility.*

### Closed 2026-09-21 — what a live guild actually proved

Two runs against Douglas's server. The first (2026-09-20) declared a journey with
resources, installed it, and unpublished it; the dev database afterwards held the
journey row with **zero** `resource_bindings`, which is the signature of a clean
install followed by a clean teardown — no orphaned `intended` rows, no bindings
pointing at deleted objects, so the record-intent-before-mutating ordering held
in practice and not just in tests.

The second (2026-09-21) targeted the guard whose failure is unrecoverable:
a created category with a hand-made channel added to it afterwards. Unpublish
**refused the category** rather than cascading the delete into a channel nobody
asked it to touch. Discord's real child-listing behaves as `survivorsOf` assumed.

**Not covered by either run, and carried forward rather than claimed:**

| Path | Status |
|---|---|
| Capability preflight | Only exercised when the bot *lacks* a permission or sits too low in the hierarchy. Refuses rather than destroys, so the downside is a blocked install, not a damaged guild |
| Adopted-binding refusal | Sabotage-verified against a mock (two named tests). Shares its enforcement point with the cascade refusal, which is now live-proven |
| Deploy | Rewritten in `f4b6cb5` after the first live run; `flow_button_messages` was still empty at that point. A failure here orphans a message, which is recoverable |

These are the honest residue of "done". None of them blocks 5B, which builds on
the apply path rather than on these three.

### Ground truth, established 2026-09-18

Searched before planning, because step 4's lesson was that an exported symbol is not a live path. This time the opposite risk applied — assuming prior art exists.

**Provisioning is a genuine blank slate.** No journey concept, no resource key, no binding table, no plan/apply pattern, no install route, no UI surface. `journey` appears in `src/` only in comments and — pointedly — in `engineVocabulary.test.ts:286`, which asserts the engine does **not** name it.

The only guild-mutating code in the repository is ticket-specific:

| Site | What it does | Reusable? |
|---|---|---|
| `ticketChannelPermissions.ts:18` `findOrCreateModeratorCategory` | Finds a category **by name**, else creates it | No — name is the identity, permission model hardcoded |
| `ticketChannelOps.ts:110` `createTicketChannelForTicket` | Creates a ticket channel with overwrites in one call | No — depends on `TicketEntity`, `TicketType`, ticket config |
| `ticketChannelOps.ts:39` `buildOverwrites` | Builds overwrites | No — module-private; vocabulary is subject/opener/staff |
| `ticketTypes.ts:115` `toPermissionOverwrite` | Maps a permission model to an overwrite | **Shape** is transferable; input type is ticket-specific |

**There is no `roles.create` anywhere in the repo.** Role creation is entirely new code, and it is the part with the hierarchy hazard.

Two pre-flight checks at `ticketChannelOps.ts:136-142` are the only prior art for capability checking, and they are inline rather than a mechanism.

### `BLOCK_CAPABILITIES` is the fourth written-never-wired symbol

`manifest.ts:550` declares `['manageRoles', 'sendMessages', 'embedLinks', 'manageChannels']`. All 18 blocks declare a capabilities array; `conformance.ts:196` spell-checks the strings against the union; the field is serialised to the browser and guarded by `nodeDescriptorDrift.test.ts`.

**Nothing reads it at runtime, and the browser never renders it.** The manifest's own comment admits this (`manifest.ts:542-548`).

This follows `incrementTicketNumber`, `ticketChannelValidation`, and `ticketCommands.ts`. Recorded because §5.7's capability preflight is the first plausible consumer, and it must be understood as **building from vocabulary only** — not extending a half-built mechanism.

### Decision: install writes snowflakes in (operator, 2026-09-18)

Seven blocks bind channels and roles through `channelPicker`/`rolePicker`, storing a raw snowflake: `actionAssignRole`, `actionRemoveRole`, `actionPostEmbed`, `actionSendMessage`, `conditionHasRole`, `conditionInChannel`, `triggerReactionAdd`.

§5.7 wants node configs to bind to *resource keys* so a journey is portable. That conflicts with every saved graph.

**Chosen: provisioning creates the resource, then writes the resulting snowflake into the journey's node configs.** Blocks are unchanged, the executor is unchanged, no saved graph migrates. Portability comes from re-running install on the next guild rather than from run-time resolution.

The cost, stated plainly: a journey is not *self-describingly* portable — its graph still holds guild-specific ids, and moving it means an install, not a copy. Run-time key resolution (§5.7 as literally written) remains available in 5B or step 6, and nothing here forecloses it, because the binding table is the same either way.

### The 28 requirements, sorted

All 29 §5.7 and §5.8 requirements are placed — 10 in 5A, 19 in 5B. Nothing is dropped silently. (§5.7's teardown policy and §5.8's uninstall share one 5B row; they are the same work stated twice.)

**In 5A — cheap now, expensive to retrofit**

| Requirement | Why it cannot wait |
|---|---|
| Declarative resources, journey-owned (§5.7) | The data shape everything else hangs off |
| Resource bindings are persisted (§5.7) | The table; `(guildId, resourceKey) → discordId` with provenance |
| Plan → preview → apply (§5.7) | The apply path's structure. Retrofitting a plan phase means rewriting it |
| Permission intent as `audience × access` (§5.7) | A grid, not named presets. Presets would have to be unpicked later |
| Permission intent, not raw overwrites (§5.7) | Same decision, stated twice in the PRD |
| Forward-only (§5.7) | A constraint, free to honour now |
| Crash mid-apply cannot orphan a resource (§5.7) | **Intent recorded before mutation** — ordering + schema, not a feature |
| Capability preflight (§5.7) | Role hierarchy failures must surface in the plan. Also the first real consumer of `BLOCK_CAPABILITIES` |
| Exactly one journey per flow, implicit (§5.8) | Determines whether `flows` grows a column or a table appears. Cheap now, a migration later |
| Journey bundle (§5.8) | The unit that owns resources; 5A needs the noun to exist |

**In 5B — genuinely additive**

| Requirement | Why it waits |
|---|---|
| ~~Drift detection and repair (§5.7)~~ | **Done 2026-09-24** — engine in 5B.2 slices A–C, operator surface in slice F. Reachable from the flows page group header |
| ~~Explicit teardown policy / uninstall (§5.7, §5.8)~~ | **Done 2026-09-24** — 5B.2 slice D. Most of it already existed; the gap was orphans and an unwritten policy |
| Rate-limit-aware application, resumable (§5.7) | Pacing layer over a working apply. Real, but our guild is small |
| ~~A resource may be bound by more than one journey (§5.7)~~ | **Cut 2026-09-24 — a decided non-requirement, not a deferral.** See below |
| Subsystem configuration is a declarable resource (§5.7) | Blocked on issue #22 — ticket categories are name-keyed, not id-keyed |
| ~~Verify, don't overwrite (§5.7)~~ | **Done 2026-09-24** — this *is* the drift machinery, and the adoption promise is what "don't overwrite" names: an adopted resource is compared and reported, never repaired |
| Ambiguous names disambiguate explicitly (§5.7) | 5A's plan lists candidates; ranked-suggestion UI is builder work |
| Suggestions are ranked, never auto-applied (§5.7) | Same — UI affordance over the same binding call |
| Provisioning opt-in per resource (§5.7) | "Bind to one I made by hand" is adoption, which 5A has; the per-resource *decline* toggle is UI |
| Resource binding is one autocomplete field (§5.7) | Explicitly a builder-surface requirement |
| Journey install is idempotent (§5.8) | 5A must not duplicate; full converge-after-partial-failure needs resume |
| A flow may hold many triggers (§5.8) | Independent of provisioning |
| Every trigger in a flow fires (§5.8) | Independent — already in *Carried forward* as a known defect |
| Trigger buttons deploy per destination (§5.8) | Independent of provisioning |
| Disconnected subgraphs are legible (§5.8) | Builder work |
| Cross-path sequencing uses existing mechanisms (§5.8) | A constraint on authors, not code |
| ~~Install wizard (§5.8)~~ | **Cut 2026-09-24 by the operator** — 5A's plan → confirm → apply already installs, and the flows page hands off to it. See below |
| Onboarding journey template ships (§5.8) | That is step 6 |

### Two things cut from 5B, 2026-09-24

Both by the operator, and neither is a deferral — they are removed from the
requirement set. Recorded here rather than deleted silently, because a requirement
that vanishes without a reason gets rebuilt by the next person who reads §5.7.

**A resource bound by more than one journey is a non-requirement.** The row above
deferred it on volume ("matters at two journeys; we will have one"), which was the
wrong reason and would have brought it back the moment a second journey existed. The
real reason is that the case does not arise from the design:

> *A journey is the unit that encompasses many flows. If someone wants a resource that
> crosses journeys, they add the flow to that journey instead.*

That is the definition doing its job. §5.8's decision 1 already says a journey is the
scope in which a resource key is visible, and 5B.1 made adding a flow to an existing
journey a drag on the flows page — so the workaround for a cross-journey resource is
cheaper than the feature, and produces a more accurate model besides. Two journeys
needing one channel are one journey that was split by mistake.

What this does **not** change: `sharedJourneyGuard.ts` stays exactly as it is. It
guards several *flows* sharing one journey, which is supported and is 5B.1's whole
product. Nothing there is about resources spanning journeys.

**"In-app onboarding install" was a misreading, and the PRD already said so.**
Onboarding was the operator's *example* of a journey somebody might build, and it was
promoted into the schedule as a deliverable. §1.4 has held the correct reading the
whole time:

> *The onboarding journey in §6.2 is an **example that motivates capabilities**, never
> a specification of behaviour the engine encodes.*

So there is no "onboarding install" feature to build. This is the same failure the top
of this document describes — detail spent on a target nobody had yet examined —
reappearing in the *target* rather than in the schedule, which is why it survived
several readings. Step 6's bar still names onboarding, and that is fine: it is the
proof, not the spec.

**The install wizard goes with it**, by the operator in the same breath: *"I don't think
we need an install wizard on the flows page."* The capability already exists and was
never the missing part — `GET .../install-plan` + `POST .../install` shipped in 5A
(`cee325d`), and §5.8's own flows-page requirement says a row's install chip *"hands off
to the builder's existing install wizard rather than introducing a second install
path."* A separate §5.8 "wizard" deliverable would have been that second path.

Recorded because this row survived one editing pass after the decision: the onboarding
half was cut and the wizard row left standing, then read back to the operator as open
work. The row's old justification — "5A ships plan → confirm → apply; the wizard is its
UI" — was already describing something that exists.

### Ordering constraints

1. The binding table and its migration land before anything mutates a guild — crash-safety is an ordering property, so it cannot be added after the apply path exists.
2. Permission intent compiles to overwrites **before** the first channel is created, or creation hardcodes a model the way tickets did.
3. Capability preflight lands with apply, not after. A hierarchy failure discovered as a runtime exception is the outcome the requirement names.
4. Snowflake write-back is last; it depends on apply having produced ids.

### What has landed (2026-09-18, `fce4ea2` + `87ef4f5`)

| Piece | File | Note |
|---|---|---|
| Declaration | `logic/resourceDeclaration.ts` | Keys, kinds, parents; validated before anything mutates |
| Permission grid | `logic/permissionIntent.ts` | `audience × access`; refuses rather than degrading |
| The plan | `logic/installPlan.ts` | create / adopt / reuse / blocked + capability preflight |
| The apply | `logic/applyInstallPlan.ts` | intent → mutate → settle, in that order |
| Bindings | `data/resourceBindings*` + `migrations/2026-09-18-Create_Resource_Bindings.ts` | Applied to dev SQLite; DDL confirmed by dump |
| Surface | `provisioningService.ts` | `previewInstall`, `installJourney`, `resolveJourneyResources` |
| Operator surface | `commands/installJourneyCommand.ts` + `commands/applyJourneyButton.ts` | Plan and apply are two interactions on purpose |
| First declaration | `journeys/onboardingJourney.ts` | Category, read-only `#rules`, `#welcome`, `Member` role |
| Write-back | `flows/logic/bindResourcesToGraph.ts` | In **flows**, consuming the provisioning barrel — never the reverse |

**Evidence**: 79 tests including real-SQL integration against the migration's own sqlite arm. Three sabotage verifications, each failing exactly the named test — the name-collision guard, the intent-before-mutation ordering, and the apply-time applicability re-check. Typecheck holds at the pre-existing 17; 952/954 suite with only the two documented pre-existing failures.

**The review earned its cost again.** It found a Critical that both gates missed: a binding pointing at a *deleted* channel short-circuited the recreate path, so an install reported success while the binding resolved to a dead snowflake — which is exactly what write-back would then have written into a node config. Reproduced with a failing test before fixing.

**Three reviewers filed the same false positive** — that apply mutates without an applicability guard. It is at `applyInstallPlan.ts:61` and is tested. They were reading the button handler in isolation. This is the second step running where reviewers produced confident false Criticals from a partial view; verify before acting remains the rule.

**`BLOCK_CAPABILITIES` is still dead.** The capability preflight checks `guild.members.me.permissions` directly rather than reading block declarations, because a journey is not a flow — it has no blocks to read capabilities from. The manifest field remains vocabulary with no runtime consumer.

### The gap this step shipped with, found by the operator 2026-09-19

**A journey cannot be created by anyone.** It is a `const` in a source file, registered into an in-memory `Map` at boot. There is no table, no API, no UI. `resource_bindings.journey_key` is a text column pointing at something that exists only in TypeScript.

This contradicts the stated intent of the whole programme — *a system an operator uses to build their own structure, which takes no position on what that structure is*. It also contradicts this document, one column up: "Journey bundle — the unit that owns resources; **5A needs the noun to exist**", and the row above it noting that this "determines whether `flows` grows a column or a table appears". The question was recorded and then answered by accident, in the direction that required no schema.

**Why the neutrality work did not catch it.** `6384019` moved the example out of the engine, added a gate rejecting example vocabulary in engine code, and tested that a journey unlike the example installs identically. All true, and all of it proves the *weak* property — "the engine has no opinion about which hardcoded journey ships" — while the claim made was the strong one, "an operator can create a journey". A gate that greps for the word `onboarding` cannot see that the only way to have a journey at all is to write code.

**What is actually missing**, and it is a third of the feature rather than a missing page:

| Layer | State |
|---|---|
| Resource declarations as a typed, validated shape | Built |
| Plan / apply / bindings, with crash safety | Built |
| **Journeys as durable records an operator authors** | **Absent** |
| HTTP API | Absent |
| Builder UI | Absent |

`JourneyDeclaration` survives as the shape. It has to be loaded from a table a person writes to, not imported from a module.

**The slash command was the wrong surface**, and for a revealing reason: "install wizard" was sorted into 5B as *builder-surface work*, which treats the UI as decoration over a Discord command. That is inverted. Flows are authored in a web builder; a journey owns flows; provisioning is how a journey becomes real. The UI is the surface, and `/install-journey` is the anomaly.

### Decisions taken 2026-09-19, after the gap was found

1. **A journey is a scope, not a folder.** It defines which resource keys a flow can see. Flows in one journey share declarations; flows in different journeys cannot collide. This is the answer to "what does grouping enable" — and it means the single-flow and multi-flow cases are one mechanism, not two designs.
2. **A declared resource is selectable before it exists.** Declare `qa-channel`, and pickers in that journey's flows offer it beside real channels. Building a flow no longer requires creating its channels by hand first, which is the capability the whole step is for.
3. **Config values carry a key *and* a cached snowflake.** The key is canonical; the id is a cached resolution. Install still writes ids in — "install writes snowflakes" and "resource keys" were never actually in conflict. Keeping the key is what makes a deleted-and-recreated channel repairable by re-installing rather than by editing every flow, and what lets a graph move to a second guild.
4. **Journeys are created implicitly with a flow.** No journeys page. ~~Grouping several flows under one journey is **deferred**~~ — **Done 2026-09-22**: grouping shipped as an organisational element on the flows page, exactly as §5.8 required. Drag a flow onto another to group them; a journey holding two or more flows renders as a band over its members with its name editable in place; a journey of one stays invisible. A journeys page was built first, in breach of this line, and has been deleted. See `docs/plans/5B1-a-journey-can-hold-many-flows.md` §"Slice C was built wrong, and rebuilt".
5. **The dashboard is the surface.** `/install-journey` goes away rather than becoming a second way to do the same thing. — **Done 2026-09-20**: the command and its Apply button are deleted; see open item 7 below.

### Still open in 5A

Closed on 2026-09-19 (`d6c564c`, `78c965c`, `a2daa4d`, `2ff6bc0`):

1. ~~**Journey authoring does not exist.**~~ Journeys are rows in a `journeys` table, authored per guild through `/api/guilds/:guildId/journeys` and a Resources panel in the flow builder. The in-memory registry and the bundled onboarding example are deleted — a fresh install has zero journeys until an operator creates one.
2. ~~**Write-back has no caller.**~~ `applyResourcesToFlows` resolves a journey's bindings and writes the ids into the node configs that picked them, run after a successful install. (Called by the Apply button when this was written; by `runInstall` since, which is the one sequence every install surface goes through.)
3. ~~**`resolveJourneyResources` has no caller.**~~ Called by the above, and its `stale` half is what separates "re-run install" from "never installed".

Closed on 2026-09-20:

7. ~~**`/install-journey` still exists.**~~ The dashboard can install (`GET .../install-plan` + `POST .../install`, `cee325d`), so the command and its Apply button were deleted along with `initProvisioning`, which had nothing left to wire. Provisioning now has **no Discord surface at all**: the dashboard is the only way to provision or tear down guild resources, which teardown already was.

   Three things are worth recording about the deletion:

   - **No capability was lost.** The command's `staff-role` options were the only thing it supplied that the plan could not derive, and guild settings now hold staff roles (§5.12) — which is where they belonged, since which roles are staff is a guild fact, not a per-install one.
   - **The 100-character `custom_id` smuggling is gone with it.** `buildApplyCustomId` packed the journey key and staff role ids into the Apply button and returned `undefined` rather than truncate, so an operator with too many staff roles was refused an install the dashboard has no trouble with. That constraint was never about provisioning; it was Discord's, and it left with the surface that had it.
   - **Global registration needs no de-registration step.** `registerCommandsWithDiscord` does a bulk `PUT` to `Routes.applicationCommands`, which is a full overwrite — a command absent from the next boot's payload is dropped by Discord. Nothing has to actively delete it.

Still open:

4. **Nothing has ever run against Discord.** No channel, role, or overwrite has been created. Every test uses a fake guild.
5. **The Resources panel has never been rendered in a browser.** Vite compiles it; nobody has looked at it. A layout or empty-state fault would not show up in any test written so far.
6. **The live run**, which is what actually closes the step.

#### What the three closed items changed structurally

- **The flow↔journey association lives on `journeys`, not on `flows`.** `flows.journey_key` was drafted and rejected by the engine-vocabulary gate, which then rejected `resource_scope_key` for `resource` and `scope`. The gate is right: the interpreter has no concept of any of them — it executes a graph whose configs already hold ids. The column is `journeys.created_for_flow_id`.
- **A picked resource is a sidecar key, not a structured value.** `roleId` keeps holding a snowflake because the block hands it to `roles.add()` unchanged; `roleIdKey` records the declaration. A structured value would have cost seven block schemas, every executor read, and a graph migration, to say what a sibling key already says.
- **Provisioning reaches write-back through a registered callback.** A direct import was written first and was wrong — the call site lives inside `features/provisioning`, so it inherits the barrel's no-flows rule. A test now enforces the boundary. (The call site was the Apply button at the time; it is `runInstall` since that command was deleted, and the rule is unchanged.)

### How this step ends

**A live install on the real guild**, as every step since 3 has. The suite is not evidence here: step 4 passed typecheck and 852 tests while the creation modal wrote no ticket row. Provisioning has the same shape of failure — plausible code that mutates the wrong thing or nothing.

Specifically: install a journey declaring at least one category, two channels with different visibility, and one role, onto a guild where **one of those already exists** — so create and adopt are both exercised in a single run.

## Step 5A.1 — The provisioning surface is usable

Written 2026-09-19, after the operator opened the Resources panel and found three faults. 5A proved a journey can be authored and installed; it did not make that worth doing. This is the smallest work that closes the gap between "the data model supports permissions" and "an operator can express one".

### What is wrong

1. **The panel is tabbed with the inspector, which breaks the inspector.** Selecting a block while the Resources tab is open shows no block details — the right-hand column is for the selected thing's configuration, and a flow-wide concern was put in a place reserved for a per-node one. This is a placement error, not a styling one.
2. **Resource kind is not obvious.** A small badge does not read at a glance, and picking the wrong kind is silent until install.
3. **Almost nothing is configurable.** A resource is a name, a key, and an optional parent. The declaration type already carries `permissions: PermissionIntent[]` and the panel never writes one — so the compiler, the applier, and the tests all support permissions that no operator can set. The named case: *"this channel is visible only to this role, and this role is one the journey creates"* — an `in-approval` role scoped to a journey.

The third is the substantive one. 1 and 2 are corrections; 3 is the missing half of the feature.

### The slice

**Not** an emulation of Discord's permission surface. The grid that exists — `audience × access`, four audiences, three access levels — is already enough to express the named case, and it was built in 5A for exactly this. The work is to *surface* it, not to extend it.

| # | Change | Why it is in this slice |
|---|---|---|
| 1 | Move resources out of the right column onto a toolbar button opening a modal | Fixes the inspector regression. Follows the existing Deploy button + modal pattern rather than inventing a third layout |
| 2 | Kind chosen explicitly and shown unmistakably — icon + colour, distinct rows per kind | A wrong kind is only discovered at install today |
| 3 | Per-resource permission editor over the existing `audience × access` grid | The missing half. No new model |
| 4 | Role reference to a **declared** role, not just an existing one | What makes "visible only to the role this journey creates" expressible. Needs `PermissionIntent.roleIds` to accept a resource key |
| 5 | Parent category selectable at creation, not only after | Currently a second step on a row that already exists |

**Item 4 is the only one touching the engine**, and it carries a defect that must be fixed with it.

`roleIds` holds snowflakes today; a declared role has none until install. Either it grows a parallel `roleKeys`, or the applier resolves keys from bindings before compiling intents — the second is likely right, since the binding is the canonical resolution either way.

**But the ordering it would depend on does not exist.** `orderResourcesForApply` (`resourceDeclaration.ts:159`) topologically sorts on `parentKey` **only** — verified by reading it, not assumed. A channel whose permissions name a declared role has no ordering edge to that role, so it can be created first, and compiling its intents would then resolve a role that is not there yet. `compilePermissionIntents` throws `PermissionIntentError` on a missing role rather than degrading, so the failure is loud — but it lands mid-apply, with channels already created, which is the half-applied state crash-safety exists to avoid.

So item 4 is two changes, not one:
- `orderResourcesForApply` must add an edge for permission role references, not just parents.
- `validateJourneyDeclaration` must reject a permission naming a resource key the journey does not declare, the same way it already rejects an unknown `parentKey`.

Sabotage check for this one: declare a channel that references a declared role, list the channel *first*, and assert the role is still created first. Reverting the ordering edge must fail that test.

### Ordering

1 and 2 are independent of 3–5 and can land first as a self-contained UX fix. 3 depends on nothing new. **4 is the risky one** and should land last, with its own sabotage check on the create-order guarantee. 5 is trivial and rides along with 2.

### What this is not

- Not per-permission-bit editing. The three access levels stay coarse until a real case needs a fourth.
- Not a journeys management page. Grouping remains deferred (PRD item 39).
- Not synchronisation of existing channel permissions — that is 5B's *verify, don't overwrite*.

### Can this run concurrently with 5B?

**Partly, and the split is not where the build order's headings suggest.** 5B's list contains two different kinds of work:

**Overlaps — must not run concurrently with 5A.1.** Drift detection, uninstall, verify-don't-overwrite, idempotence/resume, multi-journey binding, per-resource opt-in, and ranked disambiguation all read or write `resource_bindings`, `installPlan.ts`, or `resourceDeclaration.ts`. 5A.1 item 4 changes `resourceDeclaration.ts` and the applier. Two agents in those files will conflict, and the conflicts would be semantic rather than textual — the worse kind.

**Genuinely independent — safe to run in parallel.** These touch the flow engine and builder canvas and never open a provisioning file:

- A flow may hold many triggers (§5.8)
- Every trigger in a flow fires (§5.8) — already a known defect in *Carried forward*
- Trigger buttons deploy per destination (§5.8)
- Disconnected subgraphs are legible (§5.8)

The build order already marks the first three "Independent of provisioning". They are filed under 5B by position, not by subject.

One in-slice caveat: 5A.1's own items are **not** parallelisable against each other. 3, 4 and 5 all edit the same panel and the same declaration type.

## What stays load-bearing

These survive the trim because they are cheap, mechanical, and have already caught real defects.

- **The four vitest gates** — `engineVocabulary`, `blockTypeBranching`, `nodeDescriptorDrift`, `parkedRunResume`. Slice A's FR13 regression was found by a gate, not by review. If a gate fires, the first hypothesis is that the design is wrong.
- **The frozen interpreter enums** — `FLOW_RUN_STATUSES` and `FLOW_STEP_OUTCOME_KINDS`. A need to grow one is a friction report, not a deliverable.
- **No silent fallbacks** — an unmatched token, an over-limit render, an unresolvable binding each fail nameably (`.claude/rules/root-cause-over-workarounds.md`).
- **Graph compatibility** — graphs saved before a slice still load, validate, and execute. Every new config key optional.
- **The reviewer orchestrator** after `src/` TypeScript changes, iterating to no Critical or High.
- **Dual-dialect persistence** with a dated migration, registered on the `Database` interface *and* the per-dialect plugin lists. Nothing but `.ts` files under `migrations/` — the loader has no filter.
- **Where new tests go**, which is a local convention that is easy to violate in good faith: engine and block tests are **centralised** in `src/features/flows/__tests__/` (`blockConformance.test.ts`, `newNodes.test.ts`, `durableRuns.test.ts`) — *not* per-block, since every one of the 13 block directories contains only `index.ts`. Browser-side pure functions go in `web/src/flows/__tests__/`, which the root runner already collects.

## Model tier

**Everything is Opus.** Fable is reserved for work that is genuinely a complex state machine with intertwining variables that must be right the first time.

Slice C mutates durable data, which reads like the strategy's "irreversible" clause — but the parked-runs table holds single-digit rows in practice, and the fixture-before-migration ordering is a better control than a raised tier because it is mechanical and persists after the slice ends. Use the fixture, not the tier.

## Known baseline facts

- **17 pre-existing `tsc` errors** outside the flows path, plus `github-plan-cli/__tests__/ciBranchProductDiff.test.ts`. Claim "no new errors", never "clean".
- **`birthdayAnnouncementService.test.ts`** depends on the wall clock and fails at night.
- **Block discovery is re-run per test file, and the fix recorded here was wrong.** Eighteen test files (not ten) call `ensureBlocksDiscovered`, against 18 blocks as of `ead2348` (13 when this was first written, then 15), and each does a filesystem scan plus a dynamic import per block directory. The count grows with every block, so the collect cost below is a floor rather than a fixed number. Slice B raised `testTimeout` to 20s because the work is genuinely slow rather than hung. **This entry used to say the real fix was "caching discovery once per process" — that is already implemented** (`registry.ts` memoizes into a module-level promise) **and does not help**, because Vitest gives each test file its own module registry. A full run spends ~114s collecting against ~60s testing. The two things that would actually work — a shared import graph (`singleThread`/shared setup) or a generated manifest — cost test isolation and step 1's no-build-step guarantee respectively, so neither is free and neither is chosen. Symptom is worst on a **cold filesystem cache**, so it reproduces on a fresh clone, on CI, and after a reboot rather than at random; it cost one red first-run on 2026-09-15 that passed on every re-run. Costs re-runs, not correctness. Full reasoning is in `vitest.config.ts`'s comment.
- **`web/` has no *own* test runner, but its tests do run.** This was recorded wrongly here for several steps: the root `vitest.config.ts` include glob is repo-wide and excludes only `node_modules`, `dist`, and `*.live.test.ts`, so `pnpm test` collects **23 tests** under `web/src/flows/__tests__/` and `web/src/flows/controls/__tests__/` (`cardSummary`, `defaultDataFor`, `duration`). Browser-side **pure functions are testable and have an established home**; React components are not. Corrected 2026-09-14 by running `npx vitest list`.
- **There is no CI, and this is broader than the test suite.** `pnpm build` is `tsc --noEmit`, but nothing invokes it: the three `.github/workflows/` files are Jarvis issue/PR automation, the `Dockerfile` runs only `build:web`, and there is no ESLint, Biome, or git hook. So the vitest gates, the typecheck, *and* the compile-time guards (`_SnapshotShapesAgree` in `flowRunsRepo.ts`, `FixturesAreExhaustive` in `nodeDescriptorDrift.test.ts`) all fire only for whoever runs them locally. The 17 standing `tsc` errors are the evidence: nothing has been enforcing a typecheck for long enough that they accumulated.

## Open, to be answered by running it

Not blockers. Each has a default, and slice D is what replaces the guess with evidence.

| Question | Default if evidence is silent |
|---|---|
| Are `{{var.*}}` tokens sufficient for wiring, or is the picker needed? | Tokens. Revisit after authoring a real flow |
| Does SQLite have JSON1 available for the snapshot rewrite? | Fall back to select-transform-update in TypeScript — the table holds single-digit rows |
| Can the postgres migration arm be exercised at all? (test support builds SQLite only) | Record it as hand-reviewed and unexercised rather than claiming coverage it does not have |
| Does unknown-token rejection need the declared-output vocabulary? | Reject non-variable tokens at save; validate `{{var.*}}` against what blocks declare once outputs are real |

## Carried forward

Real findings from earlier work, owned but not scheduled. Not requirements.

- **Fan-out is silently dropped in three places**, not one — `executor.ts:348` (plain edges), `:344` (condition handles), `resolveWaitExit` `:251`/`:253`. A fix scoped to one line leaves the requirement violated while appearing done.
- **A stale graph save is silently applied** — nothing carries a read-version through the flow update route, so two browser tabs mean last-write-wins and a canvas of work vanishes with no error.
- **Graphs stored before M1 can carry an edge on a handle its block never declares**, and such a run ends reporting success having skipped a branch.
- **Only the first matching trigger fires**, so a second trigger of the same kind on one canvas is silently dead.
- **`action.sendDM` fails the whole run** when a member has DMs closed; the failure taxonomy that would classify it does not exist.
- **`reclaimAbandonedClaims` hands back every outstanding claim with no age filter** — correct only because it runs once at startup in a single-process bot. The claim must become identifying before any sweep goes periodic or a second instance points at one database.
- **The block-kind vocabulary is declared three times** — the engine union, the runs repo's validation schema, and the web copy.
- **A trigger that needs something it does not supply cannot be expressed.** `requires` has a dual reading on triggers; conformance enforces that every trigger declares `actor`, so the dangerous instance is closed. Split `requires` into two members at the first non-member-caused trigger.
- **PRD staleness**: §5.1's context-requirement set, §5.13's `pending`/`running` description, §5.3's "needs no new control type", and §9 criterion 10 (unreachable until step 3 exists).
- ~~**`triggerReactionAdd` declares `requires: ['channel']` but can supply `undefined`.**~~ **Closed during slice C — the premise was wrong.** The claim conflated a partial *message* with an uncached *channel*. `MessageReactionAdd.handle` resolves the channel through `Action.getChannel`, which without `Partials.Channel` reads `client.channels.cache.get(id)` and returns `false` from `handle` on a miss — and `src/discordClient.ts` enables only `Message` and `Reaction`. The event is therefore dropped upstream and the dispatcher never runs with an unresolvable channel; a partial message still carries a cached, text-based channel as a precondition of the event firing at all. Fetching the partial would not have changed the narrowing, and a `channels.fetch` fallback is unreachable code on a path that runs for every reaction in the guild. The remaining `asGuildTextChannel` call still earns its place — it rejects DMs and forum parents. **If reactions on uncached channels ever need to work, the owner is `Partials.Channel` in `discordClient.ts`, not a fetch in the dispatcher.**
- **The parked-run snapshot's shape is declared twice** — the `FlowRunContextSnapshot` interface in `flowRunsSchema.ts` and `contextSnapshotSchema` in `flowRunsRepo.ts`, hand-synchronised with nothing holding them together. Adding `channelId` in slice C cost two edits in two files. The dangerous direction is adding a key to the interface only: `z.object` strips what it does not declare, so the reader silently drops it while `tsc` says nothing. Slice C added a **compile-time guard** (`_SnapshotShapesAgree` in `flowRunsRepo.ts`) so drift in either direction now fails to compile. Worth knowing why it is a type-level `Equals` rather than the obvious thing: a pair of mutual assignments (`const a: Interface = {} as Schema` and its inverse) was written first and **does not work** — `{a}` and `{a, b?}` are assignable both ways, so an *optional* key on one side alone compiles clean, and optional is exactly the shape `channelId` established for this field. It was measured against a hypothetical `messageId?` and passed while the drift went through. Still a guard, not the fix — derive the type (`z.infer`) at the next field addition, in its own commit, because moving the schema means moving decision-bearing docs on both sides.
- **A run whose channel lookup keeps failing retries forever.** `resolveSnapshotChannel`'s `unavailable` arm throws so the claim is released and the run stays parked — but `releaseClaim` writes only `claimedAt: null`, leaving `wakeAt` untouched, so the run is due again on the very next poll. `visitsUsed` does not increment on this path either (the segment never runs), so `FLOW_MAX_NODE_VISITS` cannot fire. Slice C removed the realistic trigger by classifying revoked access and wrong-guild ids as permanent, but any *genuinely* durable REST fault still produces a run that never completes, never fails, and is invisible because `findDue` keeps reporting it as ordinary due work. The fix is to push `wakeAt` forward by a backoff on the `unavailable` release, which means giving `releaseClaim` a retry-delay — a change to the claim/release contract the fan-out and startup sweep also use, so it wants its own commit rather than a slice's tail end.
- **`condition.inChannel` after a park is no longer guarded against a trigger that declares `channel` but supplies `undefined`.** Removing the `afterParking` message from `CHECKED_REQUIREMENTS.channel` was correct for the reason it was removed — a parked run can now resolve its channel — but that message was also, accidentally, rejecting graphs where a declaring trigger narrows to `undefined` through `asGuildTextChannel` (a DM or a forum parent). Validation treats a declaring trigger as a supplier unconditionally, so the post-park instance is now reachable. Narrow in practice; the real owner is the `requires` dual-reading entry above.
- **`deployFlowButtons.ts:102` sends a flow name with no `allowedMentions`** — a flow named `@everyone` pings the guild on deploy. Gated behind `ManageGuild`, so only a user who could already mass-ping can trigger it, and it predates slice B. It is the one send path in the feature that falsifies the invariant the other three assert.
