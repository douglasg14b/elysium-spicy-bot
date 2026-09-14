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
| **2** | **Blocks compose** | A block can consume a value another block produced, and copy can address the subject | **In progress** |
| **3** | A run can ask a human a question | A moderator presses a button in a channel and *that* parked run advances; non-moderators are refused | Not started |
| **4** | A flow can open and drive a ticket | A verification ticket is opened by a flow, is distinguishable from a support ticket, and its channel is addressable by later blocks | Not started |
| **5** | A journey can build its own home | Installing a journey on an empty guild creates its categories, channels, and roles with correct visibility | Not started |
| **6** | The real journey runs on it | Our onboarding and verification runs end-to-end on the engine with no bespoke code | Not started |

**Only the current step is planned.** Steps 3–6 have PRD sketches (§5.4–§5.9) that are starting material, not requirements.

## Step 2 — Blocks compose

The bar is PRD §1.3 exactly: *a block can consume a value another block produced, and copy can address the subject.*

### What ships

| Slice | Content | Status |
|---|---|---|
| **A** | Context split — `subject` / `actor` / `channel` / `variables` on `FlowRunContext`, requirements declared and validated | **Done**, uncommitted |
| **B** | Variables flow — `context.setOutput` writes, the bag rides `FlowSuspension`, one shared token renderer expands `{{subject.mention}}`, `{{actor.mention}}`, `{{guild.name}}`, `{{var.<name>}}` | Next |
| **C** | Persist it — `flow_runs.contextSnapshot` carries subject, channel, and variables across a park | After B |
| **D** | **Run it against the real guild** | After C |

Slice D is not optional and not a formality. **Nothing in this engine has ever been exercised against a live Discord guild or in a real browser** — M1 was verified structurally only. Every deferred decision below is a guess until D happens.

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

## What stays load-bearing

These survive the trim because they are cheap, mechanical, and have already caught real defects.

- **The four vitest gates** — `engineVocabulary`, `blockTypeBranching`, `nodeDescriptorDrift`, `parkedRunResume`. Slice A's FR13 regression was found by a gate, not by review. If a gate fires, the first hypothesis is that the design is wrong.
- **The frozen interpreter enums** — `FLOW_RUN_STATUSES` and `FLOW_STEP_OUTCOME_KINDS`. A need to grow one is a friction report, not a deliverable.
- **No silent fallbacks** — an unmatched token, an over-limit render, an unresolvable binding each fail nameably (`.claude/rules/root-cause-over-workarounds.md`).
- **Graph compatibility** — graphs saved before a slice still load, validate, and execute. Every new config key optional.
- **The reviewer orchestrator** after `src/` TypeScript changes, iterating to no Critical or High.
- **Dual-dialect persistence** with a dated migration, registered on the `Database` interface *and* the per-dialect plugin lists. Nothing but `.ts` files under `migrations/` — the loader has no filter.

## Model tier

**Everything is Opus.** Fable is reserved for work that is genuinely a complex state machine with intertwining variables that must be right the first time.

Slice C mutates durable data, which reads like the strategy's "irreversible" clause — but the parked-runs table holds single-digit rows in practice, and the fixture-before-migration ordering is a better control than a raised tier because it is mechanical and persists after the slice ends. Use the fixture, not the tier.

## Known baseline facts

- **17 pre-existing `tsc` errors** outside the flows path, plus `github-plan-cli/__tests__/ciBranchProductDiff.test.ts`. Claim "no new errors", never "clean".
- **`birthdayAnnouncementService.test.ts`** depends on the wall clock and fails at night.
- **Block discovery is re-run per test file.** Ten test files each call `ensureBlocksDiscovered`, and each does a filesystem scan plus a dynamic import per block directory (~2–3.5s on Windows). Slice B raised `testTimeout` to 20s because the work is genuinely slow rather than hung — but the real fix is caching discovery once per process. Worth doing when something else touches `blocks/registry.ts`.
- **`web/` has no test runner**, so browser-side claims are proven by compile-time guards, the drift gate, or node-side unit tests over pure functions.
- **There is no CI.** Every gate runs only for whoever runs the suite.

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
