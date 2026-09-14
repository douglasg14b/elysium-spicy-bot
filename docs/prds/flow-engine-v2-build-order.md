# Flow Engine v2 — Build Order

> **Status**: Active — replaces milestone-by-milestone planning
> **Owner**: Douglas
> **Last updated**: 2026-09-13
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
| **3** | **A run can ask a human a question** | A moderator presses a button in a channel and *that* parked run advances; non-moderators are refused | **Planned — next** |
| **4** | A flow can open and drive a ticket | A verification ticket is opened by a flow, is distinguishable from a support ticket, and its channel is addressable by later blocks | Not started |
| **5** | A journey can build its own home | Installing a journey on an empty guild creates its categories, channels, and roles with correct visibility | Not started |
| **6** | The real journey runs on it | Our onboarding and verification runs end-to-end on the engine with no bespoke code | Not started |

**Only the current step is planned.** Steps 3–6 have PRD sketches (§5.4–§5.9) that are starting material, not requirements.

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
| **Full embed authoring** | Consumer of the spine. Flat scalars (URL, author, footer, timestamp, image, thumbnail) need no new control; only `fields` does | Reproducing the verification embeds is on the critical path |
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

**It came in one commit shorter than planned.** B2 was budgeted as a third invisible commit and resolved into a decision with no code of its own, so the prefix is A and B1, and B3 is next.

Consequently the fan-outs §5.4 itself defers — the four new gateway triggers — stay deferred, and §5.5's custom events are **not in this step at all**. Reasoning below.

### What ships

| Slice | Content | Visible after it |
|---|---|---|
| **A** | Resume carries a **choice**, not a boolean — widen `FlowResumeReason`, thread it through `engine/flowRunResume.ts`, `engine/executor.ts`, and `blocks/conformance.ts` | Nothing. Interpreter-level, and wider than it looks — see below. **Done** (`1b58846`) |
| **B1** | **List control** — the first non-scalar control, and whatever `ControlChange` widening it forces across the eight existing controls | Authors can edit a list of things. No block uses it yet. **Done** (`db98870`), shipped as `textList` |
| **B2** | **Handles from config** — whichever resolution the manifest contract gets for a block whose handle count is authored, not declared | **Decided, no commit.** Fixed numbered handles won; everything left is B3's own declaration. Folded into B3 — see below |
| **B3** | **The prompt block** — posts a message with one button per choice, parks, resumes by the pressed choice's handle. Run-scoped custom id, new `flowp:` prefix handler | **A run asks a question in Discord and a press advances it.** This is the step's product |
| **C** | **Audience gate** — a principal list evaluated against the clicker; ephemeral refusal; applied to the prompt block *and* to the existing trigger buttons, which today check nothing | Non-moderators are refused. This completes §1.3's step text |
| **D** | **Lifecycle** — a second press refuses rather than advancing; buttons disabled on choice, timeout, and cancel; the prompt's timeout branch | A stale prompt cannot be pressed twice |
| **E** | **Run it against the real guild** — carried over from step 2, now with something worth running | Everything above, proven |

Each row is a commit. E is not a commit; it is the thing that makes the previous ones true.

**B was split into three, and landed as two.** It was one row in the first draft of this plan, and that was wrong: it bundled a control-signature widening across eight controls, a manifest-contract change, and the block itself — two of which are individually larger than slice A, which got its own commit precisely because it touches a documented contract. A commit containing all three could not be reviewed or reverted as a unit, and the thing that stalls if it goes wrong is the one visible deliverable in the step.

That split was right for B1, which shipped alone (`db98870`) and turned up four unchecked declarations on its way through. It turned out **not** to be right for B2: splitting it assumed a manifest-contract change that the wire format then ruled out, leaving a slice whose entire content was the prompt block's own declaration. So B2 is a decision rather than a commit, and B is two commits in the end — see B2 below for why, and for what was given up.

The visible capability therefore lands at the end of **B3**, which is now the next commit. That is still before C, D, and E — the sequencing property this step exists to have, and one commit sooner than planned.

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

One new directory under `blocks/`, per step 1's whole point. What remains once B1 and B2 have landed:

- **Run-scoped custom id.** `parseFlowCustomId` returns `null` on anything but exactly three segments (`utils/customId.ts:25`), so the existing scheme cannot be extended in place — a fourth segment breaks every deployed trigger button. So a **second, separate prefix** (`flowp:`) with its own parser and handler: nothing about the trigger path changes. Be precise about why that is safe, because the obvious reason is wrong twice over. It is *not* "the strings differ" — `resolveDynamicHandler` matches by `startsWith` (`interactionsRegistry.ts:199`), so whether two prefixes collide depends on the exact registered strings, not on their being distinct. And it is *not* longest-prefix-wins either: `'flowp:x'.startsWith('flow:')` is **false**, so there is no contest to win. What actually saves it is the **trailing colon at the registration boundary** — `initFlows.ts:43` registers `` `${FLOW_CUSTOM_ID_PREFIX}:` `` while the constant itself is bare `'flow'` (`constants.ts:5`). Register either prefix without its colon and `flowp:` ids route straight into `handleFlowButtonInteraction`, which parses them to `null` and answers "Malformed flow button id" (`engine/flowTriggerDispatch.ts:23-24`) — a confusing user-facing error, not a crash, which is the worst kind to debug. `registerDynamic` throws only on an exact duplicate string (`:67-68`) and will not warn. So: register `'flowp:'` **with** the colon, and make it a registry test rather than an assumption.
- **Budget the 100 characters honestly.** A UUID `runId` is 36, which with a prefix and a node id leaves room for a choice identifier only if it is small — see the identity decision under slice A.
- **Decide what a prompt press does to `resumeWaitingRunsForEvent`.** `engine/flowTriggerDispatch.ts:31-35` wakes parked runs on *every* flow button click, matching only `guildId` + `userId` + `eventKind: 'buttonClick'`, before the flow is even loaded. Two consequences, both currently undecided: a press on a `flowp:` button will not reach that path at all, so a run parked on a generic `buttonClick` wait no longer wakes when the user presses a prompt — an asymmetry someone should choose rather than inherit. And in the other direction, a user pressing an ordinary trigger button while parked on a prompt can have the prompt-parked run woken through that userId-only match with reason `'event'` instead of a choice, landing in `executor.ts:324-331`'s "woke onto nothing". That is a correctness question for D's one-winner guarantee, not a detail.
- **It must defer within 3 seconds** (§7). `engine/flowTriggerDispatch.ts:71-73` is the existing pattern.

#### C — audience gate

Two halves, and the second is the one that earns the step text.

The **gate itself** is a principal list: `anyone`, `subject`, `actor`, a member reference to a run variable, `roles: [...]`, `discordPermission: [...]` (§5.4). Deliberately no "moderator" principal — §5.12 wants moderator roles promoted to a shared guild setting, that promotion is **not in this step**, and a `roles: [...]` gate already expresses "these roles" without the engine naming a subsystem. Evaluating it is a pure function over a `GuildMember` plus the run's variables, which is the testable shape; keep it out of the interaction handler.

**The gate must be authorable, or the step cannot demonstrate its own bar.** Dropping the "moderator" principal is only free if an author can actually set `roles: [...]`, and a role list is a non-scalar control — so slice C has a second, non-obvious dependency on B1 beyond the one B3 has. Without an authoring surface the step can finish with a correct evaluator nobody can configure, and slice E has no moderator press to demonstrate. Either C ships the authoring control, or it states plainly what E will be unable to show.

The **application** is the half that matters: §5.4 says "eligibility is a property of every trigger, not just buttons", and `flowTriggerDispatch.ts` has **no check at all** today — any member who can see a deployed flow button can run it. Gating only the new prompt block would leave the older, more exposed surface open while the step reports done. So slice C gates both, and the existing trigger buttons default to `anyone` so saved graphs keep working (the compatibility rule under "What stays load-bearing").

`memberJoin` eligibility and the "already completed" rule (§5.4's fifth bullet) are the part of that bullet that is **not** in slice C: an already-completed rule needs a durable per-member journey record that does not exist, and there is no journey until step 6. The audience *vocabulary* is built here; the join-time completion check is owned by step 6 and named here so it is not mistaken for done.

Refusal is ephemeral and changes nothing (§5.4's fourth bullet) — the failure mode it exists to prevent is a dead interaction, which Discord shows as an error to the user.

#### D — lifecycle

Once a choice is taken, the buttons must stop working. Note this is **two** mechanisms, not one: disabling the components on the message is cosmetic and racy, so the authoritative guard is that the run is no longer parked at that node. `claimForResume` already makes this a single conditional write with one winner (`data/flowRunsRepo.ts:288`, and the comment at `engine/flowRunResume.ts:270-276` describes exactly this race for the timeout case). A second press after a first must land as a refusal, not a second advance, **even if the message edit failed** — so the check belongs on the claim, and the edit is presentation.

The timeout branch is the prompt declaring a `wakeAt` and its own timeout handle, which `actionWaitForEvent` already demonstrates end to end (`blocks/actionWaitForEvent/index.ts:77-99`).

**This slice owns the concurrency tests, and slice E does not substitute for them** — it is the one place the 90% rule above buys nothing by economising. Two moderators pressing at once and a timeout firing as a press lands are guarantees a live-guild session is the *least* reliable way to exercise, and a passing test can genuinely prove nothing here, so these are worth checking actually fail when the guard is removed. Extend `parkedRunResume.test.ts`, which already owns the claim-race shape. Two or three cases, not a matrix.

#### E — run it

Unchanged from step 2's slice D, and still not a formality. **Nothing in this engine has ever run against a live Discord guild or in a real browser.**

Two migrations are committed but have never been applied to a database (`2026-09-14-Add_Flow_Run_Variables`, `2026-09-15-Widen_Flow_Run_Context_Snapshot`), and the pre-flight for that is **not** "watch whether the bot boots". Nothing migrates at boot — `src/bot.ts` never invokes the migrator; migrations run from a separate CLI (`pnpm migrate:latest`), chained into the `dev` script only. The migrator reports per-migration results and sets a non-zero exit code on the first failure, so a **half-applied pair is reachable**: 09-14 lands, 09-15 fails, and the bot afterwards starts perfectly well and fails later at query time. Watch the CLI's exit code, not the boot.

Two questions to settle before running, both asked during step 2 and unanswered:

- **Which database is dev pointed at?** SQLite leaves the postgres migration arm unexercised; record that honestly rather than claiming coverage.
- **Who drives the Discord interactions?** A live guild is outward-facing. Get explicit authorization before posting anything into it.

### Ordering constraints

Two of these are real dependencies. The others are preferences, and saying which is which matters more than the order itself.

1. **A before B3** — *a dependency.* The prompt block cannot name its exit until the resume reason can carry one. Building it first means building against `'event'` and rewriting.
2. **B1 before B3, and B1 before C** — *a dependency.* Both the choice list and the gate's role list are non-scalar controls.
3. **C before D** — *a dependency.* Refusal and "already answered" are the same ephemeral surface; the lifecycle guard first means building the refusal path twice.
4. **B3 before C** — **a preference, not a dependency**, and the one to revisit if anything slips. The reason is design quality: the gate becomes a shared vocabulary rather than a prompt-block private if it has two call sites when it is written. The cost is real, though — `flowTriggerDispatch.ts` has **no eligibility check at all today**, so this sequences an existing authorization hole behind the step's riskiest work. It stands because B1 comes first regardless, because the hole is gated behind a deployed button in a guild whose admin is the operator, and because a gate shaped by one caller is the failure this step is most likely to repeat from step 2. The escape hatch this clause reserved — invert the order if B2 turns out worse than expected — is **spent**: B2 resolved to a decision with no commit, so nothing is left to overrun. If B3 itself slips, invert then.
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

### Carried from step 2

- **Slice D of step 2 is absorbed as slice E here**, deliberately. Running the infrastructure alone was low-value; running it with a prompt block on top is the same work with something to see.
- The **`unavailable` retry backoff** (Carried forward, below) becomes more pressing in this step: a prompt parks runs for as long as a moderator takes to answer, which is the longest park the engine will have seen.
- The **fan-out drop in three places** and **only-the-first-matching-trigger-fires** are both still open and both now have a second reason to care — a prompt with several choices makes handle-following the hot path.

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
- **Block discovery is re-run per test file.** Ten test files each call `ensureBlocksDiscovered`, and each does a filesystem scan plus a dynamic import per block directory (~2–3.5s on Windows). Slice B raised `testTimeout` to 20s because the work is genuinely slow rather than hung — but the real fix is caching discovery once per process. Worth doing when something else touches `blocks/registry.ts`.
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
