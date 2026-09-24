# 5B.2 — Installed structure stays healthy

> **Status**: Planned, 2026-09-24
> **Owner**: Douglas
> **Step**: 5B (PRD §5.7)
> **Predecessor**: [5B1-a-journey-can-hold-many-flows.md](5B1-a-journey-can-hold-many-flows.md) — slice E still open there
> **Product intent**: [flow-engine-v2-journeys-and-provisioning.md](../prds/flow-engine-v2-journeys-and-provisioning.md) §5.7

## The bar

Step 5B's outcome sentence, from PRD §1.3: *drift is detected and repairable, installs
resume after interruption, and uninstall is safe.*

This plan takes **drift** and **uninstall**. Resume-after-interruption is the
rate-limit/resumable-apply row and stays deferred — our guild is small and the apply
already records intent before mutating, which is the half that could not be retrofitted.

## Why drift is the next slice

Because install is currently lying, and the lie is one line.

`installPlan.ts:279-282` decides whether to reuse an existing binding:

```ts
const stillThere =
    resource.kind === 'role'
        ? guild.roles.cache.has(existing.discordId)
        : guild.channels.cache.has(existing.discordId);
```

That asks **does an object with this id still exist**. It does not ask whether the
object is still the one that was declared. Rename `#welcome` to `#lobby`, drag it out
of its category, strip the overwrites that made it staff-only — and install reports
`reuse`, changes nothing, and tells the operator everything is fine.

The permission case is the one that matters. A journey's whole value proposition is
*"this channel is visible only to this role"*; 5A.1 exists because that was the missing
half of the feature. A silent divergence there is a **privacy failure**, not an
untidiness: a channel that should be staff-only can go public and the install path will
keep certifying it.

So this is not an additive nicety. It is the difference between a provisioning system
and a create-once script.

## What already exists — read before building

The roadmap says teardown "needs an install to exist before it can be undone", which is
stale. A great deal is already built, and this plan is small *because* of that.

| Piece | File | State |
|---|---|---|
| Teardown plan | `logic/unpublishPlan.ts` | Built — delete/forget/refuse, adoption promise, category cascade, permission + role-hierarchy preflight |
| Teardown apply | `logic/applyUnpublishPlan.ts` | Built — object first then row, with a TOCTOU re-check of `survivorsOf` before each category delete |
| Shared-journey guard | `logic/sharedJourneyGuard.ts` | Built — refuses an operation that would damage another flow's journey, naming each flow |
| Permission compiler | `logic/permissionIntent.ts` | Built, **pure, and re-runnable** — `compilePermissionIntents` is what makes permission drift detectable at all |
| Kind-and-existence probe | `installPlan.ts:108` `existsInGuildAs` | Built — already checks *type*, not just existence. Drift's `kind` case is nearly free |
| Journey teardown routes + dialog | `src/web/api/journeyRoutes.ts`, `web/src/flows/JourneyResourcesDialog.tsx` | Built 2026-09-22 |
| Install state summary | `logic/journeyInstallState.ts` | Built — `summariseJourneyInstall`, used by the flows page chips |

**The gap is narrow and specific**: nothing ever compares a live object against the
declaration it came from. Every piece needed to do that comparison exists.

## Decisions taken before building (operator, 2026-09-24)

1. **Four drift kinds**: renamed, moved out of its parent, permission overwrites
   changed, wrong type. Orphaned bindings (a binding whose key the journey no longer
   declares) is **out** — it is a different question, answered by teardown rather than
   by repair.
2. **Repair reconciles to the declaration.** The declaration is the source of truth: put
   the name back, move it back, reapply the overwrites. Always previewed and confirmed;
   never automatic. Adopting drift into the declaration ("they renamed it on purpose,
   keep it") is **not** built — it is a second direction with its own confirm surface,
   and the asymmetry is deliberate: a declaration the guild can silently edit is not a
   declaration.
3. **Cross-journey resources are a non-requirement**, not a deferral. Recorded in the
   build order.
4. **"In-app onboarding install" was a misreading** and is dropped. Recorded in the
   build order.

## The shape

Drift is **a third question about a binding**, alongside the two that already exist.
Install asks *does it exist* and teardown asks *may I delete it*. Drift asks *is it
still what we said it was*.

That framing decides the file layout. It is not a new subsystem — it is a comparison
function plus the two surfaces that consume it.

```
logic/resourceDrift.ts        compare one binding against one declaration  (pure)
logic/journeyDriftPlan.ts     fan that across a journey's bindings          (reads guild)
logic/applyDriftRepair.ts     carry out an approved repair                  (mutates)
```

The pure/reads/mutates split is the same one `resourceDeclaration` → `installPlan` →
`applyInstallPlan` already uses, and for the same reason: the comparison is where every
interesting decision lives, and it must be testable without a guild.

### Why the comparison is pure, and what that costs

`detectResourceDrift` takes **a declaration, a binding, and a snapshot of the live
object** — not a `Guild`. The caller reads Discord; the comparison does not.

This matters because permission drift is a set-comparison over bitfields with
non-obvious rules (see below), and every one of those rules wants a test that can state
its case in four lines rather than building a fake guild. `unpublishPlan.ts` takes a
`Guild` and is harder to test in exactly this way.

The cost is one extra type — a `LiveResourceSnapshot` the plan builder fills in — and
that is worth paying.

## Slices

| Slice | Content | Visible after it |
|---|---|---|
| **A** | `resourceDrift.ts` — the pure comparison and its four kinds. No caller | Nothing |
| **B** | `journeyDriftPlan.ts` — read the guild, build a drift report for a journey; wire it into the existing install-plan route so a plan *shows* drift | An operator previewing an install sees "3 resources have drifted" with each difference named |
| **C** | `applyDriftRepair.ts` + a repair route — reconcile approved items | **Drift is repairable.** The slice's product |
| **D** | Teardown policy — close the gaps below in `unpublishPlan` / the routes | Uninstall states its policy rather than implying it |
| **E** | Run it against the live guild | The bar, proven |

A is invisible and is one commit — the smallest available prefix, consistent with the
lesson this programme keeps relearning. The visible deliverable is **C**, with B
building toward it.

### A — the comparison

Four kinds. Each is a discriminated variant carrying what it needs to render and to
repair, because a repair that has to re-derive what it is fixing can disagree with what
the operator was shown.

```ts
type ResourceDriftKind =
    | { kind: 'renamed';      declared: string; actual: string }
    | { kind: 'reparented';   declaredParentId: string | null; actualParentId: string | null }
    | { kind: 'wrongType';    declared: ResourceKind; actual: string }
    | { kind: 'permissions';  differences: readonly PermissionDifference[] };
```

**`wrongType` short-circuits the rest.** If the id now resolves to a text channel where
a category was declared, the name and parent comparisons are meaningless and the repair
is not a rename — it is a re-bind or a recreate, which is a decision for the operator.
Report it alone.

**`reparented` compares ids, never names.** The declared parent is resolved through the
*binding* for `parentKey`, so a category that has itself been renamed does not read as a
child having moved. A resource with no `parentKey` declares nothing about its parent and
is never reparented — an operator dragging a top-level channel into some category of
their own is not drift, because the declaration never had an opinion.

**`permissions` is the substantive one.** The rules, each of which is a test:

- Compile the declaration with `compilePermissionIntents`, then compare against the
  live `permissionOverwrites`. Compiling rather than storing is what keeps drift honest
  — there is no second copy of the intent to go stale.
- **Compare only ids the declaration mentions.** An operator granting one extra person
  access to a channel is their business; the declaration says what must be true, not
  what must be absent. Reporting every hand-added overwrite as drift would make the
  report unreadable on a real guild and would train the operator to ignore it.
- **The bot's own overwrite is excluded.** `compilePermissionIntents` appends it
  unconditionally (`permissionIntent.ts:215`), so it is not an authored intent, and a
  repair must not report it as a difference it is about to "fix".
- **Compare bit sets, not the serialised bitfield.** Discord returns allow/deny as
  bitfields that include bits we never set; equality on the raw number would report
  drift on every channel forever. The comparison is: *for each bit the declaration
  allows, is it allowed live; for each bit it denies, is it denied live.*
- A `subject` audience cannot be compiled outside a run (`permissionIntent.ts:167`
  throws). A resource whose intents name `subject` is **skipped for permission drift**
  with that stated as the reason, rather than reported as broken.

### B — the journey report

`buildJourneyDriftPlan(guild, journey, bindings)` → `JourneyDriftPlan`.

Reads the guild once, builds a `LiveResourceSnapshot` per binding, calls the pure
comparison, collects. A binding whose object is **gone** is not drift — that is the
recreate case install already handles, and reporting it twice in two vocabularies is how
an operator ends up with two buttons that do the same thing.

Wire it into the existing install-plan route rather than adding a second route. The
operator asking "what will installing do" and "has anything drifted" is asking one
question, and `InstallPlan` already has a `reuse` item per resource — drift belongs
*on* that item.

### C — repair

`applyDriftRepair(guild, plan, approvedKeys)`. Per item, in declaration order:

- `renamed` → `setName`
- `reparented` → `setParent`
- `permissions` → re-apply the compiled overwrites for the declared ids only
- `wrongType` → **never repaired automatically.** Refused with an explanation; the
  operator re-binds or recreates.

Mirrors `applyUnpublishPlan`'s outcome union (`repaired` / `refused` / `failed`) rather
than inventing a third vocabulary for the same three things.

**Re-check before mutating.** `applyUnpublishPlan` re-runs `survivorsOf` immediately
before each category delete because containment can change while the operator reads the
preview. The same hazard applies here and the same answer is taken: re-read the live
object and re-compare before repairing it. An operator who fixed the rename by hand
while looking at the report must not have it "repaired" to the same value.

### D — teardown policy

What is genuinely missing, having read the code:

1. **`unpublishPlan` never consults the declaration.** It works from bindings alone,
   which is right for the case it was built for (a journey row deleted, bindings
   outliving it) but means a resource *removed from the panel* while its Discord object
   still exists is invisible to every surface. That is the orphan case cut from drift —
   it belongs here, as a teardown question: *these three objects are no longer declared;
   delete them, or forget them?*
2. **No stated policy on what uninstall means for a journey with attached flows.**
   `sharedJourneyGuard` refuses, which is correct for *destroying*, but the journey
   teardown route deliberately omits the 409 for unpublish. That asymmetry is
   load-bearing and currently lives only in a code comment. It needs to be stated as
   policy in the PRD, because it is the kind of thing a later change silently
   "corrects".
3. **Partial teardown leaves no record.** `applyUnpublishPlan` returns per-item
   outcomes, and nothing persists them. An operator who tears down, gets three refusals,
   and comes back tomorrow has no way to see what was left behind except by re-running.

(1) and (3) are the work. (2) is a paragraph in the PRD.

## What must not break

- **The adoption promise.** `state === 'adopted'` means the operator told us the object
  predates us. Drift **detects** on an adopted resource — knowing a staff-only channel
  went public matters regardless of who made it — but repair must refuse by default,
  for the same reason teardown refuses to delete it. A promise that holds for deletion
  and not for a rename is not a promise.
- **Graph compatibility.** Every drift field optional; a journey saved before this slice
  plans and installs identically.
- **The engine vocabulary gate.** `drift` is not currently in `PROVEN_REJECTIONS`, but
  this code lives in `features/provisioning` regardless, which is outside the gate.
- **The dependency direction.** Provisioning must not import flows.
  `dependencyDirection.test.ts` enforces it.
- **No silent fallbacks.** A resource whose permission intents cannot be compiled is
  reported as skipped-and-why, never as clean.

## Testing

Per the 90% rule, and weighted toward the comparison because that is where the
decisions are:

- `resourceDrift.test.ts` — the four kinds, and specifically: extra live overwrites are
  not drift; the bot's own overwrite is not drift; a bitfield containing unrelated bits
  is not drift; `subject` intents skip rather than fail; `wrongType` suppresses the
  others; a renamed *parent* is not a reparent.
- `journeyDriftPlan.test.ts` — a missing object is not drift; an adopted resource drifts
  but does not repair.
- `applyDriftRepair.test.ts` — the re-check catches a hand-fix; `wrongType` refuses.

**Sabotage-verify three**: the extra-overwrites rule (it is the one whose failure makes
the report useless rather than wrong), the adopted-resource repair refusal, and the
apply-time re-check. Each has the property that a passing test might prove nothing.

## What A–D actually found — corrections to this plan

Recorded as they landed, because a plan that only says what was intended is worth less
later than one that says where it was wrong.

**The permission comparison was typed against the wrong thing, and `tsc` caught it.**
Slice A first typed `compiledOverwrites` as `discord.js`'s `OverwriteResolvable`,
reasoning that this is what `compilePermissionIntents` returns. It is not: that type is
what `discord.js` accepts on the way *in*, and it permits a `Role` or a `GuildMember`,
so the module claimed to handle shapes it cannot compare and cannot repair. The
compiler in fact returns plain ids with `bigint` arrays, which is now its own named
type. A change to the compiler's output breaks at compile time instead of producing a
silently empty diff.

**The two `discord.js` write paths disagree about vocabulary**, and the plan assumed
one. `permissionOverwrites.set` and `channels.create` take bit arrays; `edit` takes a
map of permission *names*. Slice C was written against bits and would have failed only
against a live guild. `PermissionsBitField.toArray()` does the translation rather than
a hand-written table, which would be one release from being silently wrong about a flag
nothing tests.

**`setParent` needed a flag the plan did not mention, and it is load-bearing.**
Discord's default on a move is to *sync* the channel's overwrites to its new category —
so repairing a reparent would have destroyed the permission model this feature exists to
protect. `lockPermissions: false`.

**The three-way outcome in slice B was a hole, found by asking what a weak test was
worth.** A resource whose permissions could not be compiled landed in `cleanKeys` with
its reason discarded, so the plan reported it clean and the operator was never told it
had gone unexamined — the exact false-clean the module header argues against. `unchecked`
is now a third answer. Related: the two questions are asked *independently* rather than
as an if/else chain, because a resource can both drift and go unchecked, and a chain
drops whichever it tests second.

**`resourceBindingsRepo` had no way to update a cached name.** `settle` accepts only
`intended` rows and `rebind` exists to point a row at a *different* object; a rename
repair changes nothing about identity. Slice C added `renameBinding`, guarded on the
snowflake rather than the row id, because the caller is holding a live object and that
is the fact worth checking.

**A test helper silently discarded its overrides.** `binding()` in slice A's tests
accepted a `Partial` and never spread it, so two tests passed against a fixture that
ignored what they set. The `as ResourceBindingEntity` cast is what hid it from `tsc`.
Worth recording because it is the same false-pass class this repo has shipped before,
and because it was found by a test failing for the *right* reason rather than by
review.

**Slice D was smaller than planned, for the reason the plan predicted.** Teardown was
already built — plan/confirm, the adoption promise, the category cascade, permission and
hierarchy preflight, and a TOCTOU re-check. The two real gaps were orphans (a resource
removed from the panel whose object survives, previously on no screen at all) and a
policy that existed only in a route comment. Both are now closed; the third item the
plan listed — persisting per-item teardown outcomes — is **not** done and is carried
below.

**The adoption promise was guarded by a boolean that travelled.** `applyDriftRepair`
read `repairable` off the plan it was handed, which is fine while the only caller is
this process and becomes a client's *claim* the moment a route exists. Found by asking
who supplies the plan rather than by a test failing. `withAdoptionReasserted` now
recomputes it from the binding rows, and can only ever take repairability away — it
cannot loosen a plan that was already cautious. Pinned while it cost four lines rather
than after a route made it silent.

**The review earned its cost, and the highest-value finding was one no test could
reach.** Four sub-reviewers ran against slices A–D; three independently found the same
two defects, which is the signal worth weighting. Seven were real and all are fixed
(`5035992`). The one worth reading:

> **Adoption recorded the declared name, so every adopted resource reported a rename
> that never happened.** `applyInstallPlan` settles an `adopt` with `name: item.name`
> while `requireAdoptable` deliberately never renames the object.

Two things kept it invisible. My own test asserted the phantom drift *as correct
behaviour* — "detects drift on an adopted resource" passed **because of** the bug. And
the install harness's fake `settle` silently dropped `name`, so no test on that side
could have seen it either. A fixture that ignores the field under test is the same
false-pass class as a helper that discards its overrides, one layer up.

The other six: `renameBinding` unscoped on a non-unique column; permission repair
writing the whole compiled model rather than the drifted ids; a missing model throwing
*after* a rename landed; `resource:` role references never resolved in the drift path
(so the most security-sensitive shape went unchecked behind a misleading reason);
permissions repairable on a resource whose permissions were never checked; and an
`intended` row with a live object reported as "already gone".

**Sabotage runs: eighteen in all**, each failing exactly its named test and nothing
else.
The three that were most worth doing: the extra-overwrites rule (its failure makes the
report useless rather than wrong), the adoption refusals in both detection and repair,
and the apply-time re-check. Two sabotages in slice C caught the *mutation* via a spy
rather than a return value, which is the stronger evidence.

## Still open

- **Per-item teardown outcomes are not persisted.** An operator who tears down, gets
  three refusals, and returns tomorrow has no record of what was left behind except by
  re-running. Named in slice D's scope and deliberately not built — it wants a table,
  and the question of how long such a record should live is not one to answer in a
  tail-end commit.
- **No surface.** Slices A–D are engine and service only. Nothing in the dashboard
  shows a drift report or offers a repair, so none of this is reachable by an operator
  yet.
- **Slice E has not run.** Everything here is test-verified only, which is the condition
  every step in this programme has ended by making false.

## Ordering

1. **A before B** — dependency.
2. **B before C** — dependency; repair acts on a plan.
3. **D is independent** and can land any time; it is sequenced last only because drift
   is the more valuable half.
4. **E last, and E is not optional.**

## What this is not

- Not resumable/rate-limited apply. Still deferred, still for the stated reason.
- Not the install wizard.
- Not subsystem configuration as a declarable resource — blocked on issue #22, which is
  a ticketing-side migration from category *names* to *ids*.
- Not a second direction for repair (adopt-the-drift). Deliberate; see decisions.
