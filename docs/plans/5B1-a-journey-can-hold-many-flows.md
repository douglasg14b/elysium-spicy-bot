# 5B.1 — A journey can hold many flows

> **Status**: Planned
> **Owner**: Douglas
> **Written**: 2026-09-21, after 5A closed on a live guild
> **Parent**: [flow-engine-v2-build-order.md](../prds/flow-engine-v2-build-order.md) step 5B

## The bar

**An operator can create a journey, attach more than one flow to it, and install it
once — and every attached flow gets the ids.**

One sentence, one demonstrable outcome, the same shape as every step bar before it.

## Why this is the first 5B slice

5B's roadmap list was stale in three places, found by reading the code rather than
the plan:

- **Uninstall is done.** `unpublishPlan.ts`, `/unpublish`, `/undeploy`, and the
  standalone `InstalledResourcesDialog` all shipped and were live-verified
  2026-09-21. The roadmap row is closeable without writing anything.
- **Install wizard is done.** 5A shipped plan → confirm → apply.
- **Provisioning opt-in per resource is done.** Adoption covers it.

And one row is **dropped by operator decision**: *a resource bound by more than one
journey*. Resources are scoped to exactly one journey. It was only ever justified as
"matters at two journeys", and it now never matters.

What remains is drift detection, verify-don't-overwrite, resume/idempotence,
rate-limit pacing, ranked suggestions, and the autocomplete binding field. All of
those are additive and nothing is broken without them.

**This slice is first because it is the only 5B item where the operator is currently
blocked.** There is no way to attach a second flow to a journey, and the reason is
not a missing screen.

## What is actually wrong — and it is not UI-only

My first read said this was a UI gap over an API that already worked. That was
wrong, and the correction is the whole slice.

**`journeyKey` *is* the flow id.** `journeyRoutes.ts:224` writes
`journeyKey: flowId` on first save, and every consumer looks the journey up by the
flow's own id:

| Site | Call |
|---|---|
| `flowRoutes.ts:88` | `journeysRepo.getByKey(guildId, flowId)` — preview |
| `flowRoutes.ts:211` | `getByKey(guildId, flowId)` — `flowJourney()`, install ownership |
| `flowRoutes.ts:619` | `getByKey(guild.id, flowId)` — unpublish |
| `journeyRoutes.ts:177` | `getByKey(guildId, flowId)` — read a flow's resources |
| `journeyRoutes.ts:218` | `getByKey(guildId, flowId)` — update-or-create |

So a second flow attached to an existing journey looks up a journey keyed by *its
own* id, finds nothing, and is told it declares no resources. The identity runs down
into `resource_bindings`, whose unique index is
`(guildId, journeyKey, resourceKey)`.

`createdForFlowId` is already nullable and its schema comment already names the
shared case as deferred — so the *column* anticipated this. The *key* did not.

### What already supports many flows

Two things, and they are why this is a slice rather than a step:

- **`applyResourcesToFlows`** walks every flow in the guild and binds each one's
  targets. Its comment says outright that it refuses to assume `journeyKey` is a
  flow id *"because a journey shared by several flows is the deferred grouping
  case, and writing only to the flow whose id matched would silently skip the
  others the day it lands."* That day is this slice. **No change needed.**
- **The standalone journey routes** — `POST/PUT/DELETE /journeys` — exist, are
  guild-scoped, and take an operator-supplied key. `web/src/api/journeys.ts`
  already wraps all of them.

So the write-back half and the CRUD half are built. What is missing is the
*association*, and a surface for it.

## The shape

**A flow points at a journey; a journey does not list its flows.**

The association already lives on the journey side as `createdForFlowId`, which is
singular and therefore cannot express this. Rather than widen it to a JSON array —
which makes the journey row the owner of a list that no constraint protects — the
reference inverts: **`flows` grows a nullable `journeyKey`**.

Three reasons this direction and not the other:

1. **One flow has at most one journey** (the build order already settled this:
   *"Exactly one journey per flow, implicit (§5.8)"*). A scalar column expresses
   that exactly; a JSON list on the journey cannot, and would admit a flow
   appearing twice or in two journeys.
2. **The database can enforce it.** A unique index on `(guildId, flowId)` says
   "one flow, at most one journey" in the schema rather than in prose; a JSON array
   on the journey row takes no constraint at all and would admit a flow appearing
   twice, or in two journeys.
3. **Every read is "what does this flow install?"** — the five call sites above are
   all flow-first. A column turns each into a one-step lookup rather than a scan.

### The vocabulary gate decides the shape — settled, by reading the gate

**Not an open question.** Checked directly rather than left for the implementer:

- `GATED_PATHS` includes `{ path: join(FLOWS_DIR, 'data'), recursive: true }`
  (`engineVocabulary.test.ts:75`), so `flowsSchema.ts` is scanned.
- `PROVEN_REJECTIONS` is
  `['onboarding', 'journey', 'welcome', 'rules', 'verification', 'ticket', 'audience', 'prompt', 'application']`
  (`:285-288`).

So a `journeyKey` column on `flows` **cannot compile past the gate**, and neither
can a `scope`-flavoured euphemism for it — renaming the concept to slip past a gate
is precisely the leak the gate exists to catch, and the file's own header says a
local was already renamed once rather than the allowlist widened.

**Therefore: a third table, `flow_journey_links (guildId, flowId, journeyKey)`, in
`src/features/provisioning/data/`.**

This is the gate working, and the result is better than the column on every axis
that matters here:

- The noun stays entirely on the provisioning side, which is where it belongs. The
  flow engine keeps having no concept of a journey.
- It respects the dependency direction this repo now actually enforces
  (`dependencyDirection.test.ts`, `c5c79dd`): provisioning may read flows; flows may
  never read provisioning.
- It matches the precedent already set by `journeysSchema.ts:37-49`, whose comment
  explains that `createdForFlowId` lives on the journey side *for this exact
  reason*.

Cost: one join on a lookup that was already doing one. Take it.

## Slices

Each row is a commit.

| # | Content | Visible after it |
|---|---|---|
| **A** | `flow_journey_links`, its dated migration, and the repo that reads it. Backfill every existing flow-owned journey so today's implicit links become explicit rows | Nothing. The five call sites still resolve by flow id, and every existing flow behaves identically |
| **B** | Repoint the five lookups through the link, falling back to the implicit `journeyKey === flowId` when no link row exists | Nothing yet — but a flow can now *be* attached to a journey whose key is not its id |
| **C** | A journeys page: list, create, rename, delete, and see which flows are attached | An operator can see and manage journeys as first-class things |
| **D** | Attach and detach a flow from the builder, and from the journeys page | **A second flow can join a journey.** This is the slice's product |
| **E** | Install once, from the journey, and watch every attached flow get its ids | The bar, proven on the live guild |

### Slice E's checklist, written while it was still fresh

E is not only a live run. It deletes the fallback, and these go with it:

- `resolveFlowJourney.ts:65-68` — the `journeyKey === flowId` branch and its
  `console.warn`. The warn exists so "every row resolved" is *checkable* before E
  rather than assumed: run the guild, watch the log, and if it never fires the
  fallback is provably dead.
- `ResolvedFlowJourney.attached` and both `!resolved.attached` guards
  (`flowRoutes.ts:238`, `:650`). Once every resolution comes from a link row,
  `attached` is permanently true and those branches are dead.
- **Wrap the attach and clear pairs in a transaction *before* deleting the
  fallback.** Today a failure between `journeysRepo.create` and `attach` leaves an
  unlinked journey that the fallback silently repairs. Without the fallback that
  state is permanent and invisible, with live channels and nothing able to resolve
  them. This is a prerequisite, not a tidy-up.

**A and B are the invisible prefix, and it is two commits — deliberately the
smallest available.** The lesson this programme keeps relearning (steps 1 and 2
shipped nothing visible between them) says put the visible deliverable in the middle
and harden after. Here the visible thing is **D**, with E proving it.

### Ordering constraints

Two are real dependencies; the rest is preference.

1. **A before B** — *a dependency.* The lookups cannot go through a link table that
   does not exist.
2. **B before D** — *a dependency.* Attaching a flow to a foreign-keyed journey is
   meaningless while install still resolves by flow id; the attach would save and
   change nothing, which is the worst failure shape.
3. **C before D** — *a preference.* D needs somewhere to pick a journey *from*, and
   a page is the obvious source. If C slips, D can ship with a key-entry field and
   C becomes cosmetic.
4. **E last, and E is not optional.** Same rule as every step here.

## The backfill, and why it is in slice A

Every existing journey has `journeyKey = flowId` and
`createdForFlowId = flowId`. Slice A writes a link row for each, so the implicit
convention becomes explicit data *before* anything reads through the new path.

Do it in the migration, not at boot. Doing it lazily means two resolution rules live
concurrently and the fallback in slice B becomes permanent — exactly the
"indistinguishable from the real design" bridge that
`root-cause-over-workarounds.md` forbids.

**The fallback in B is still needed** for a journey created between the migration
and the deploy, and it is explicitly temporary: it carries a comment saying so and
is deleted in E once the live guild confirms every row resolved.

## What must not break

- **`flowJourney()`'s positive ownership check** (`flowRoutes.ts:193-205`). Its
  comment explains at length why ownership is checked positively rather than by
  ruling out a conflicting owner: a flow id is a UUID, which satisfies the
  resource-key pattern, so an operator can *type* a key that collides with a real
  flow's id. Install creates channels and roles; attributing those to a flow that
  never declared them is the failure this guard exists for.

  **The link table makes this stricter, not looser** — attachment becomes explicit
  data rather than a key convention. Do not let that be an excuse to relax the
  check; a link row is exactly the positive evidence the comment asks for.

- **`/unpublish`'s weaker check** stays weaker, for the reason already recorded: the
  operator is shown the exact list before anything is destroyed, and the objects
  were ones we created. Do not "fix" it to match install.

- **Deleting a journey with attached flows.** Today `DELETE /journeys/:key` removes
  the row unconditionally. With links, that orphans them. It must refuse, naming the
  attached flows — the same shape as the category-cascade refusal the operator just
  live-verified, and consistent with `dialog-copy-density-over-prose`.

- **Graph compatibility.** Every existing flow keeps working with no link row, via
  B's fallback, until E confirms otherwise.

## Testing

**~90%, and the ceiling applies.** Effort goes to the feature.

Worth testing:

- The backfill produces exactly one link per existing flow-owned journey, and none
  for a standalone one.
- A flow with no link row still resolves its journey (B's fallback).
- Two flows attached to one journey both receive ids from a single install — this is
  the bar, and `applyResourcesToFlows` is the unit that proves it.
- Deleting a journey with attachments is refused and names them.

**Sabotage-verify the delete refusal and the backfill count.** Both are guards where
a passing test can prove nothing: the refusal because an unconditional delete also
leaves a green suite, and the backfill because a migration that writes zero rows
looks identical to one whose assertions are vacuous. This repo has produced a false
pass in exactly that second shape before — see
`sabotage-verify-before-claiming-a-guard`.

Not worth testing: that the journeys page renders. `web/` has no jsdom and no React
Testing Library; pure logic goes in `web/src/flows/__tests__/` as usual.

## What A and B actually found — corrections to this plan

Recorded because the plan was wrong in two places and a reviewer caught both.

**There were six lookup sites, not five.** `publishedFlowState.ts:100` also called
`previewUnpublish(guild, flowId)`. Left alone, the unpublish *preview dialog* would
have planned against a different key than the POST that tears down — a preview lying
about the operation it previews, which is the exact failure `flowJourney()`'s comment
says the shared-lookup shape exists to prevent.

**The "What must not break" list was incomplete.** It named the delete-with-attachments
case but not `/unpublish` itself: a journey holding two flows, unpublished from one,
destroys channels the other still declares. The route's defence of its weaker check
("the objects were ones we created") held only while a journey had one flow — this
slice invalidates that premise, and the plan did not say so.

A third hazard was found that the plan had not considered at all: **`PUT
/flows/:flowId/resources` replaces `resources` wholesale**, so a second flow saving
its panel would silently delete the first's declarations. The empty-list branch had a
guard; the ordinary save path did not. Both now ask the link table.

**Coverage gap closed after review:** every test in the install-ownership block ran
with no link row, so all four proved only the *fallback* arm while the
`!resolved.attached` short-circuit — slice B's most consequential line — had none.
Sabotage-verified: removing it fails exactly one named test, *"installs a journey
owned by another flow when this flow is attached to it"*, and the other four stay
green, which is what proves they were never covering it.

## What this is not

- **Not drift detection.** Separate 5B slice, additive, nothing broken without it.
- **Not resources shared between journeys.** Dropped by operator decision; a
  resource belongs to exactly one journey.
- **Not a rewrite of the implicit case.** A flow that declares its own resources and
  never joins a journey keeps working exactly as it does today, with a link row
  pointing at its own key.
