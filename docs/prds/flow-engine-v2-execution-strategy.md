# Execution Strategy — Flow Engine v2

> **Status**: Approved
> **Owner**: Douglas
> **Last updated**: 2026-09-12
> **Companion to**: [flow-engine-v2-journeys-and-provisioning.md](flow-engine-v2-journeys-and-provisioning.md) (product intent)
> **Scope**: How the six milestones get built — wave structure, what parallelizes, how the block contract is amended mid-flight, how context is managed across sessions, and what gates each wave.
> **Does not cover**: Per-milestone implementation plans. Those are RPI artifacts (§8).

## 1) What owns what

Three documents, three jobs. Keeping them separate is what stops the PRD rotting into a sprint board.

| Artifact | Owns | Changes when | Committed |
| --- | --- | --- | --- |
| **PRD** — `docs/prds/flow-engine-v2-journeys-and-provisioning.md` | Product intent: what the journey must do, what is non-negotiable | Product intent changes | Yes |
| **This document** | Program-level execution: wave shape, parallelism rules, amendment protocol, context strategy, gates | Execution approach changes | Yes |
| **RPI plan per milestone** — `.claude/rpi-tracking/plans/<date>/<slug>-plan.md` | Task-level `Pxx` phases, file-by-file work, **per-phase model tier**, acceptance evidence | Continuously, during that milestone | No (gitignored) |

The PRD deliberately excludes this content: a PRD is product intent, not a plan. The PRD-builder session state is also the wrong home — it is local, gitignored scratch that exists only to resume PRD authoring.

RPI plans one task through phases. This initiative is six milestones, so it is **six RPI lifecycles**, not one. This document is the layer above them that RPI does not have.

## 2) State machines — three kinds, only one of them ours

PRD §5.13 sets the taxonomy; this is the internal shape. The distinction matters more than any individual machine:

- **Kind B — the authored machine** is what the product is *for*. A flow graph is a state machine: nodes are states, edges and handles are transitions, a run's position plus variables is the current state. There are unboundedly many and we will never see most of them. We build an **interpreter**, not a machine.
- **Kind A — the interpreter's own machinery** is exactly two things, and they must never grow.
- **Kind C — subsystem lifecycles** belong to their features. They are ordinary domain state machines that happen to be reachable from blocks. They are *not* flow-engine machinery.

### Kind A — the interpreter (ours, fixed, must not grow)

| # | Machine | States | Notes |
| --- | --- | --- | --- |
| **A1** | **Run lifecycle** | `pending` → `running` → `suspended` \| `completed` \| `failed` \| `cancelled` | Today only `pending`/`completed`/`failed`/`cancelled` are reachable — **`running` is declared and never written** ([`flowRunsSchema.ts:5`](../../src/features/flows/data/flowRunsSchema.ts)), and rows exist only for parked runs, so `pending` is not actually ambiguous in the data. `running` becomes real via the resume claim (below) or is removed; `suspended` becomes distinct; `cancelled` becomes operator-reachable. **All of this lands in wave 1.1**, because the freeze baseline is the end of M1. |
| **A2** | **Step outcome** | `continue(handle?)` \| `suspend(suspension)` \| `fail(error)` | **The keystone.** Today implicit in executor branching with two block types special-cased by string literal ([`executor.ts:158`](../../src/features/flows/engine/executor.ts), `:180`). Making it an explicit union every block returns is what deletes that special-casing. Build first; most of M1 falls out of it. |

**Both enums reach final shape in wave 1.1 and may not gain a member after that.** That is the anti-overfit tripwire: if a later feature seems to need a new interpreter state, the block contract is wrong. Treat it as a friction report (§5), not as a quick enum addition.

Two decisions must therefore be made in wave 1.1 rather than discovered later, because both are known pressures on a frozen enum (PRD §5.13):

- **Deliberate termination.** A graph needs a way to end a run as neither success nor error, with an author-supplied reason. Either A2 gains a `halt(terminal, reason)` member now, or `cancelled` is declared operator-only and abandonment resolves to `completed` with a named reason. Leaving it undecided behind a freeze is the one unacceptable option.
- **Transient failure.** A 429 or 5xx must not be terminal. Resolve as a `retry` marker on the suspension payload with its own bounded budget — not a new A2 member, and not sharing `FLOW_MAX_NODE_VISITS`.

**Amending a frozen enum is a fourth outcome of §5's protocol**, distinct from extending the block contract: it reopens the PRD §5.13 claim and cannot be decided inside a milestone. Expensive and visible beats forbidden and therefore hidden — a forbidden-but-needed state gets smuggled in as a magic value in the suspension payload, which is the hack this whole protocol exists to prevent.

The interpreter's whole job is then small and total: given a graph, a position, and a serialized run state, produce an A2 outcome and a next position — for *any* graph, including shapes nobody designed for.

### Kind C — subsystem lifecycles (owned by their features)

| # | Machine | Owner | States |
| --- | --- | --- | --- |
| **C1** | Ticket lifecycle | tickets feature | `open` → `claimed` ⇄ `open` → `closed` ⇄ `open` → `deleted` |
| **C2** | Resource binding | provisioning | `declared` → `planned` → `bound(created\|adopted)` → `drifted` → `unmanaged` |
| **C3** | Journey install | provisioning | `draft` → `planned` → `applying` → `installed` \| `partially-applied` |

C1 exists whether or not flows do — it is currently derived from a base64 blob in an embed field with button enablement recomputed inline ([`ticketState.ts:161-178`](../../src/features/tickets/logic/ticketState.ts)) and becomes a real machine over a real row. C3's `partially-applied` must be resumable; Discord rate limits guarantee we hit it.

The engine touches C1–C3 only through blocks, services, and events. It never reads or writes their states directly, and their states never appear in a run row.

### Discipline applied to all of them

- One owning module per machine. Transitions are a total function over `(state, event)`; no transition logic outside it.
- Illegal transitions are unrepresentable in the type or throw loudly — never a silent no-op (`.claude/rules/root-cause-over-workarounds.md`).
- Each machine is exhaustively unit-tested with no Discord client and no database.
- Persisted state names match the machine's state names exactly. No translation layer between what the code calls it and what the column says.
- A run's complete state is `{position, context(subject, actor, channel), variables, parked-on, visit budget, log}` and is fully serializable. Any in-memory-only run state silently breaks resume for some graph an author will eventually draw.

## 3) The wave pattern

Every milestone runs the same four-step shape. This is the core of the answer to "what can be parallel".

```
  Spike  ──►  Exemplar  ──►  Fan-out  ──►  Integrate
(serial)     (serial)      (parallel)      (serial)
 contract    2-3 reference   the formulaic   wire, gate,
 + gate      implementations  remainder      review
```

1. **Spike** *(serial, foreground)* — define the contract, interfaces, and state machine for this wave. Compiles; changes no behavior. This is a design act and must not be delegated to parallel agents.
2. **Exemplar** *(serial, foreground)* — implement 2–3 reference cases against the fresh contract. This is where the contract gets found to be wrong, cheaply, before it has twenty dependents. Deliberately includes the *hardest* case in the category, not the easiest.
3. **Fan-out** *(parallel subagents)* — the formulaic remainder, one agent per unit, each confined to its own directory.
4. **Integrate** *(serial, foreground)* — wire up, run the gates (§7), review, commit as a reviewable slice.

**The governing rule: serialize the novel, parallelize the formulaic.** Corollary: *the first block of any new kind is always foreground; the second through Nth fan out.*

## 4) What parallelizes — and what must not

### Preconditions for any fan-out

Fan-out is viable only when all three hold. If any is missing, parallelism is a net loss — review cost exceeds authoring cost.

1. **No shared-file contention.** N agents editing one registry array produce N conflicting edits to one line range. This is why PRD §5.1 requires blocks to be **self-registering by directory**. That requirement was written for maintainability, but it is *load-bearing for this execution model* — without it, block authoring cannot be parallelized at all. It must land in the very first spike.
2. **The contract compiles and is exemplified.** Agents are excellent at "do this again, differently" and poor at "invent the pattern". Two worked examples beat any amount of prose specification.
3. **A mechanical gate the agent can run.** The conformance suite (PRD §5.1) must be runnable by the subagent itself. Without it, every block needs full human review and the parallelism is illusory.

### Must stay serial

- **All of M1's builder rewrite.** Sweeping cross-cutting refactor of the executor, registry, API, and six frontend files. Parallel agents would collide continuously.
- **The first prompt block.** It *defines* audience gating and run-scoped interaction identity. Design, not authoring.
- **The ticket service surface and the cutover.** Regression-sensitive, single coherent boundary.
- **The provisioning reconciler.** One state machine, one author.
- **The journey template.** A single coherent authored artifact.

### Fannable inventory (rough)

| Wave | Fannable units | Notes |
| --- | --- | --- |
| M1 | ~10 | Migrating the existing 12 blocks, after 2 exemplars |
| M2 | ~3 | Embed composer, pick-random, singleton guard |
| M3 | ~4 | New Discord triggers, once channel selectors exist |
| M4 | ~10 | Ticket blocks, conditions, triggers — after the service lands |
| M5 | ~4 | Permission intents |
| M6 | 0 | Single authored journey |

So roughly **30 of ~50 units are fannable**, but each batch is gated behind serial design work. Expect the calendar to be dominated by the serial spikes, not the fan-outs.

### Model tier — assigned per phase, policy owned here

Tier is an **execution** concern, so the rule lives in this document and the per-`Pxx` assignment lives in the RPI phase details. It does **not** belong in the PRD: product intent does not change when the model lineup does.

Tier by **(design-bearing OR irreversible)**, not by size:

| Tier | When | Wave-pattern mapping |
| --- | --- | --- |
| **Fable** | Work that *defines* a contract, a state machine, or a vocabulary — where a defect propagates to every dependent — **or** work that mutates live data or a live guild, where the cost of being wrong is not rework | **Spike** and **Exemplar** in every wave. Plus, regardless of complexity: M4's cutover (4.2, 4.4) and M5's apply path (5.1, 5.2, 5.4) |
| **Opus** | Work that *conforms* to a contract already proven by two exemplars, and is mechanically gated by the conformance suite | **Fan-out** in every wave, and **Integrate** where nothing regression-sensitive is in the slice |

Two corollaries worth stating, because they are where the rule gets misapplied:

- **Small does not mean cheap.** M4's handler migration (4.2) is mechanically simple and irreversible-adjacent — it is Fable work. Conversely M1's ten block migrations (1.3) are individually substantial and formulaic — Opus.
- **The first of a kind is always Fable, the rest are Opus.** This is the same boundary as serial-vs-parallel (§3), so tier falls out of the wave structure rather than being a second axis to track.

Escalate a fan-out unit to Fable if it files a contract friction report (§5) — by definition it has stopped conforming and started designing.

### Subagent dispatch contract

Fan-out uses this repo's **`generic-implementer`** agent. Every task gets exactly this, and nothing more:

- The contract file path and the two exemplar paths.
- One target directory it may write to. **No other write access.**
- The conformance command to run, and the requirement that it passes.
- A required return field: **contract friction report** (§5), defaulting to `none`.
- Its tier, per the table above (fan-out is Opus by default).

Do not fan out more than ~6 at once — review throughput, not agent capacity, is the bottleneck.

**Review is mandatory, not discretionary.** `.claude/rules/run-reviewer-after-src-changes.md` requires the **`reviewer`** orchestrator after any `src/` TypeScript change, iterating until no Critical or High findings remain. That applies to every wave, and it is the main reason concurrency is capped at ~6: each fanned-out unit generates a review cycle. Plans themselves go through **`planner-reviewer`** before implementation starts.

## 5) The contract amendment protocol

This is the part you flagged: *"problems we run into are going to have to be solved in a clean manner, even if existing code already exists that uses the way that is now high friction."*

The failure mode is specific and predictable. **An agent's incentive is to complete its task.** Given a contract that cannot express what it needs, it will invent a local workaround and report success — and that workaround is exactly the "hack" you said you do not want. So escalation must be the *cheap* path, and workarounds must be *mechanically* hard.

### Protocol

1. **Stop, do not work around.** A block author who cannot express something within the contract halts that unit.
2. **File a friction report** — what was needed, what the contract offers, why the workaround would be bad. This is a required return field on every fan-out task, defaulting to `none`, so filing one is easier than hiding one.
3. **The contract owner decides** (foreground, never the subagent):
   - **Extend** the vocabulary — the normal answer.
   - **Reject** the need — the block is asking for the wrong thing; redesign the block.
   - **Scoped exception** — rare, must be logged in §9 with a removal condition. Per `.claude/rules/root-cause-over-workarounds.md`, it must be obvious in code, not indistinguishable from the real design.
4. **An extension lands as one commit** that changes the contract, **migrates every existing block**, and updates the conformance test. Two mechanisms for the same fact never coexist, per `.claude/rules/implementation-philosophy.md` ("unify inconsistencies").
5. **Log it in the amendment ledger** (§9), so the contract's evolution is visible rather than archaeological.

### Why this is affordable

The conformance suite is what makes step 4 cheap: it fails loudly on every unmigrated block, so a partial migration cannot ship. The suite is not merely a quality gate — it is the thing that makes amending the contract a routine operation instead of a dreaded one. Build it in the very first spike, before any block is migrated.

### Calibration

Expect **3–6 amendments across M1–M6**. Zero means the contract is too loose to be doing any work. Twenty means the contract was wrong and needs a rethink rather than continued patching. Track the count as a health signal.

## 6) Context strategy

**Do not compact this session — replace it.** Compaction preserves an arbitrary slice of a conversation. What implementation needs is a session whose *entire* context is the right artifacts.

Current session context is PRD-authoring dialogue. Implementation needs the PRD, this document, a per-milestone design doc, and fresh reads of the actual code. Almost none of the conversation carries forward.

What was in my head and is now durable: the PRD carries every code finding with file:line references; this document carries the state machines, wave shape, and amendment protocol. Once this file is committed, **this session is safely discardable**.

Recommended rhythm:

- **One fresh session per milestone.** Seeded with: the PRD, this document, and that milestone's RPI plan.
- **One fresh session per fan-out batch** if the batch is large — the parent only needs the contract, the exemplars, and the friction reports coming back.
- **Re-read code, do not remember it.** File:line references in the PRD will drift as we refactor. Treat them as pointers to *where to look*, not as facts.
- Between milestones, the durable artifacts are the handoff. If a fresh session cannot pick up from them, the artifacts are inadequate — fix them rather than preserving the chat.

## 7) Verification gates

Every wave must pass all of these before its slice is committed. They are cheap, mechanical, and non-negotiable.

| Gate | Check |
| --- | --- |
| **Typecheck** | `tsc` clean, strict, no new `any` |
| **Existing tests** | Full suite green — currently 61 flow tests plus the rest |
| **Conformance** | Every registered block passes the manifest conformance suite |
| **No type-branching** | Grep proves no builder code branches on a specific block `type` string, and the executor names no block type by literal |
| **Graph compatibility** | A flow saved before the wave still loads, validates, and executes |
| **Milestone criteria** | The PRD §9 acceptance criteria assigned to that milestone |
| **State machines** | Any machine touched this wave has a Discord-free test driving all its transitions, and an illegal transition raises rather than no-ops (PRD §5.13) |
| **Interpreter did not grow** | The A1 and A2 enums have the same members as at the end of M1. A wave that needs a new one files a friction report and reopens PRD §5.13 |
| **No use-case leakage** | **Allowlist, not denylist.** Flow-engine modules may name only: run, node, block, edge, handle, variable, output, trigger, event, suspension, guild, member, channel, role, actor, subject. Anything else — including `ticket` — appears only inside `blocks/<name>/` adapters or template data. A denylist of this journey's four nouns would pass the leakage that already exists |
| **Reviewer clean** | The `reviewer` orchestrator has run on the wave's `src/` changes and reports no Critical or High findings — mandatory per `.claude/rules/run-reviewer-after-src-changes.md`, iterate until clean |
| **Persona** | User-facing copy has not been sanitized (`.claude/rules/product-persona-and-audience.md`) |

The "no type-branching" grep is worth automating as a test rather than a habit — it is the single check that keeps M1's benefit from eroding.

## 8) Milestone execution map

One RPI lifecycle per milestone. `/rpi-plan` produces the `Pxx` phases; this table sets the wave boundaries it should respect.

**M1 — Block contract v2**

| Wave | Mode | Content |
| --- | --- | --- |
| 1.1 | serial | A2 step-outcome union, **A1 final shape + migration** (settle `suspended`, `running`, deliberate termination, retry marker — see §2), block manifest, **directory auto-discovery**, conformance harness |
| 1.2 | serial | Two exemplars — one trigger, and `action.waitForEvent` (the hardest case; it proves suspension without special-casing) |
| 1.3 | **parallel ×10** | Migrate the remaining existing blocks |
| 1.4 | serial → parallel ×3 | Control-type library (serial), then palette / card / inspector on separate files |
| 1.5 | serial | Widen `/api/nodes`, delete `nodeMeta.ts` catalogues and the `NodeInspector` switch, gates |

**M2 — Run data flow**

| Wave | Mode | Content |
| --- | --- | --- |
| 2.1 | serial | Subject/actor split, channel context, variables, run-snapshot migration, token renderer |
| 2.2 | serial | Declared outputs + reference-binding control |
| 2.3 | **parallel ×3** | Embed composer, pick-random block, per-trigger singleton guard |

**M3 — Interaction & events**

| Wave | Mode | Content |
| --- | --- | --- |
| 3.0 | serial | **Shared guild settings** (§5.12): moderator roles promoted out of tickets, six duplicated call sites converged. Everything below reads it |
| 3.1 | serial | Prompt block, run-scoped custom IDs, **atomic run claim**, audience-rule vocabulary — *the hardest design chunk in the programme* |
| 3.2 | serial | Custom event bus + correlation |
| 3.3 | serial | Channel selector vocabulary (the ticket blocks need it regardless) |
| 3.2b | serial | Event-cascade bound (causation chain + run-creation cap) — ships with the bus, not after it |
| 3.4 | serial | Observability views + **run cancel** (retry/advance stay in M6) |

**M4 — Tickets** *(full refactor; see PRD §8 Q4)*

| Wave | Mode | Content |
| --- | --- | --- |
| 4.1 | serial | `tickets` table, C1, ticket service surface, ticket types |
| 4.2 | serial | Move existing handlers onto the service — regression-sensitive, keep the slice small |
| 4.3 | **parallel ×7** | Ticket blocks, conditions, triggers (tags cut) |
| 4.3b | **parallel ×4** | The four Discord gateway triggers, deferred out of M3 (PRD §5.4). Independent of tickets — can run alongside 4.1/4.2 if review capacity allows |
| 4.4 | serial | Announced cutover + in-flight ticket migration, **non-destructive to embed state until confirmed**, with a written abort/revert procedure and the "equivalent to today" baseline captured first |

**M5 — Provisioning**

| Wave | Mode | Content |
| --- | --- | --- |
| 5.1 | serial | Resource model, binding table, C2 reconciler |
| 5.2 | serial | Plan/preview/apply, capability + role-hierarchy preflight, rate-limit pacing |
| 5.3 | **parallel ×4** | Permission intents; resource-binding combobox UI |
| 5.4 | serial | Drift detection, teardown policy, C3 install resumability |

**M6 — The journey**

| Wave | Mode | Content |
| --- | --- | --- |
| 6.1 | serial | Journey bundle + install wizard (M5 built the resource engine; this is the operator-facing install) |
| 6.2 | serial | Author the onboarding journey template |
| 6.3 | serial | Fresh-guild install test, then live cutover |
| 6.4 | serial | Operator run controls, deferred here from M3 (PRD §8 Q11) |

## 9) Amendment ledger

Every contract amendment, in order. Empty until M1 starts.

| # | Date | Milestone | Friction | Decision | Blocks migrated |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — |

Scoped exceptions (each needs a removal condition):

| # | Exception | Why | Removed when |
| --- | --- | --- | --- |
| — | — | — | — |

## 10) Execution risks

- ⚠️ **M5 is the highest-risk milestone in the programme, and it is not close.** Three unrelated hard things in one wave set: a new backend subsystem (reconciler, C2/C3, binding table, permission-intent compiler), a genuinely fiddly frontend surface (ranked autocomplete, duplicate-name disambiguation, plan preview), and **the only irreversible mutation of a live Discord guild anywhere in this programme**. Its parallelisable ratio is the worst of any non-M6 milestone — ~4 fannable units against 18 requirements — so the wave pattern buys almost nothing here and it is nearly all serial.
  - **Containment**: build and prove the whole reconcile → plan → apply loop against a **throwaway test guild** before it is ever pointed at the live server. The fixture-journey acceptance criteria (PRD §9, 21–26c) exist precisely so M5 can be signed off without the onboarding journey.
  - **The two failure modes that actually hurt** are silent misbinding (a journey wired into the wrong existing channel) and a crash mid-apply leaving untracked resources. Both now have requirements; both deserve explicit test cases before the first live apply.
  - **If M5 slips, it slips alone.** M6 depends on it, but M1–M4 are complete and useful without it — a journey can be stood up with hand-created resources bound by the operator (PRD §5.7 makes provisioning opt-in per resource). That is the escape hatch; do not let M5 block shipping the rest.
- **Overfitting to the onboarding journey is the quietest risk.** Every milestone is justified by one concrete use case, so the pull toward encoding that use case in the engine is constant and will not announce itself. The two mechanical defences are the frozen A1/A2 enums and the grep gate; neither is optional, and both belong in the first wave's CI rather than being applied retrospectively.
- **M1 has no user-visible output and touches everything.** The milestone most likely to feel like it is dragging. The conformance suite is what makes it *verifiably* done rather than perpetually almost-done. If M1 slips badly, the fallback is not "skip it" — it is to narrow the block catalogue, not the contract.
- **Fan-out review is the real bottleneck.** Ten parallel agents produce ten diffs needing review. Cap concurrent fan-out at ~6 and treat review throughput as the scheduling constraint.
- **Agents will hide friction.** Mitigated by the required-field friction report (§5), but assume some leakage: the conformance suite must be strict enough that a workaround *fails* rather than quietly passes.
- **M4's cutover is the only user-visible disruption.** Bounded and announced by decision (PRD §8 Q4), but it is the one wave where a rollback story is worth having before starting.
- **File:line references decay.** Everything cited in the PRD moves during M1. Re-read before relying on any pointer.
- **Rules have relocated to `.claude/rules/*.md`** and citations in both documents are updated. The `.cursor/rules/*.mdc` copies still exist and their *internal* cross-references still point at the old paths — worth reconciling to one authority, per `.claude/rules/implementation-philosophy.md` ("unify inconsistencies"), before agents start reading them.
