# 5B.3 — An install converges after it is interrupted

> **Status**: Planned, 2026-09-27
> **Owner**: Douglas
> **Step**: 5B (PRD §5.7, §5.8)
> **Predecessor**: [5B2-drift-detection-and-teardown-policy.md](5B2-drift-detection-and-teardown-policy.md) — done and live-verified
> **Product intent**: [flow-engine-v2-journeys-and-provisioning.md](../prds/flow-engine-v2-journeys-and-provisioning.md) §5.7, §5.8

## The bar

Step 5B's outcome sentence, from PRD §1.3: *drift is detected and repairable, **installs
resume after interruption**, and uninstall is safe.* 5B.2 closed the first and last
clauses. This plan closes the middle one, and with it three PRD rows:

| PRD row | What it asks |
|---|---|
| §5.7 *A crash mid-apply cannot orphan a resource* | On resume, reconcile recorded intents against the guild — adopt what is found or report an orphan — before creating anything |
| §5.7 *Rate-limit-aware application* | Mutations are paced; a partial apply is resumable and reports exactly what succeeded |
| §5.8 *Journey install is idempotent* | Re-running after a partial failure converges rather than duplicating |

## Most of this already exists — read before building

The build order describes this row as "a pacing layer over a working apply", which
undersells what the apply already does.

| Property | Where | State |
|---|---|---|
| Intent recorded before the guild is mutated | `applyInstallPlan.ts:116`, `resourceBindingsRepo.recordIntent` | Built in 5A |
| A partial apply keeps and reports what it made | `ApplyInstallPlanResult.failure`, the install route's 200-with-failure | Built |
| Re-running reuses what is bound and live | `installPlan.ts:283-306` → `reuse` | Built |
| A binding whose object was deleted is recreated, and the plan says so | `installPlan.ts:297-305` | Built |
| A failed create discards its own intent row | `applyInstallPlan.ts:178-190` | Built |
| Two installs racing to settle one key cannot both win | `settle` guarded on `state = 'intended'` | Built — but it reports the duplicate *after* creating it (see slice B) |
| Rate limits are waited out | `@discordjs/rest` queues per bucket and sleeps on a 429; `rejectOnRateLimit` is unset | Built into the transport, **unverified by any test** |

So "resumable" already holds for every interruption that returns control to the apply —
a refused create, a permission error, a bad parent. Re-press install and it picks up
where it stopped. **Two cases are not covered.**

## The gap: an intent written, a guild mutated, a binding never settled

The schema promises more than the code delivers. `resourceBindingsSchema.ts:8-12` says
that on the next install *"the reconciler sees an `intended` row with no `discordId`,
looks for what it was about to create, and adopts or reports it."* **No such reconciler
exists.** The PRD row is still marked *Not done*, correctly — 5A built the half that
could not be retrofitted (writing intent first) and not the half that reads it back.

What actually happens if the process dies after `guild.channels.create` returns and
before `settle` runs:

1. The row is left `intended`, `discordId` null. The channel exists in Discord.
2. The next plan skips the row — `installPlan.ts:286` treats `intended` as no binding at all.
3. It falls through to the name match, finds the channel the crashed install made, and
   plans **`blocked`**: *"A channel named `welcome` already exists. Choose whether to
   adopt it or create a new one."*
4. If the operator adopts it, it settles as **`adopted`**.

Step 4 is the damage. Provenance is the only thing teardown reads, and an adopted
resource is never deleted — so **a channel the bot made is permanently reclassified as
one the operator made**, and uninstall leaves it behind forever. The duplicate the PRD
warns about is avoided only because the name match happens to block; the orphan is not.

### How to tell it is ours: the snowflake's clock

A Discord id encodes the millisecond the object was created. The intent row records the
moment *before* the create was sent. So:

> A guild object of the intent's **kind**, carrying the intent's **name**, **created
> after the intent was written**, and **not bound to anything else**, is the object the
> interrupted install made.

No audit-log read (which needs `ViewAuditLog` and is paginated), no extra column, no
marker in the channel topic. Every input is already stored.

Outcomes:

| Candidates | Plan item | Why |
|---|---|---|
| Exactly one | **`recover`**, with its id | Settle the existing `intended` row as **`created`** — the provenance it always had |
| None | `create`, as today | The crash landed before the create reached Discord. The existing intent row is reused by `recordIntent` and settled normally |
| More than one | `blocked`, naming them | Two same-named objects made since the intent is not something to guess about |

A small, named allowance for clock skew between this host and Discord goes on the
comparison. Its failure direction is safe either way: too tight and a genuine recovery
falls back to today's name-collision block; too loose and a hand-made channel created
seconds before a crash could be recovered, which requires a crash to be vanishingly
likely to matter.

**Known and accepted:** if someone renames the object between the crash and the next
install, nothing matches and install creates a second one. The window is a crash plus a
human rename before the retry; the duplicate is visible and named in the plan as a create.

## Slices

| # | Change | Proof |
|---|---|---|
| **A** | **Recover interrupted creates.** `recover` joins `PLAN_ACTIONS`; `buildInstallPlan` checks an `intended` row for its object before falling through to the name match; `applyInstallPlan` settles the row as `created` (the existing `settle`, already guarded on `intended`, is exactly the write needed). Mirror the action into `web/src/api/types.ts` and the install summary copy — *"`#welcome` was created by an install that was interrupted; this records it."* | TestDiscord integration: write an intent row, create the channel server-side afterwards, run install → one channel, binding `created`, id matches, and **unpublish then deletes it**. Second case: a same-named channel created *before* the intent is not recovered and still blocks. Sabotage: remove the recover branch, watch the first case fail |
| **B** | **One mutating operation per journey at a time.** An in-process lock keyed `(guildId, journeyKey)`, taken by install, drift repair, and unpublish. A second press is **refused with a 409**, not queued — a queued apply would run a plan approved before the first one changed the guild. In-process is correct for a single-process bot; the limit is stated beside it, the same way `reclaimAbandonedClaims` states its own | Two concurrent installs of one journey → one 409, one channel. Sabotage: drop the lock, watch the duplicate appear |
| **C** | **Rate limits: verify, don't build.** Operator decision 2026-09-27 — rely on `@discordjs/rest`. TestDiscord learns to answer a chosen route with one 429 and a short `retry_after`; install must complete with exactly one of each resource. The harness models this as a **test-injected fault**, not as Discord's real limits, and its docs say so | The test. If discord.js does not retry against the injected `makeRequest`, this slice becomes the finding |
| **D** | **Docs.** Tick the three PRD rows. Correct `resourceBindingsSchema.ts:8-12` to describe the reconciler that now exists. Build order: 5B's status row, and strike "Trigger buttons deploy per destination" (done 2026-09-20, still unstruck in the 5B table) | — |
| **E** | **Live run.** Install a multi-resource journey on the real guild; re-press install and see `reuse` throughout; press twice quickly and see the refusal. The crash window itself is milliseconds wide and is not reproducible by hand — say so rather than claim it; slice A's TestDiscord case is the evidence for it | Operator |

A before B: B's refusal is simpler to reason about once `recover` exists, and A is the
slice that closes the PRD row. C and D are independent.

## What this is not

- **Not a background job.** Install stays inside the web request. Revisit only if a real
  journey's install outlasts a browser's patience.
- **Not a pacing layer.** No batching or scheduling of our own on top of the transport.
- **Not cross-process locking.** One bot process; if that changes, B's lock is the first
  thing to replace, and it says so.

## Observed, not in scope

Drift repair **renames** channels, and Discord's channel-rename sublimit is two per ten
minutes per channel. discord.js waits that out silently, so a repair that renames the
same channel twice in quick succession can hold its HTTP request open for minutes. Not
reachable by install. Recorded so it is recognised if a repair ever appears to hang.

## Next: issue #22, decided but not yet planned

Planned as its own step once this lands (one step at a time). Decisions already taken by
the operator on 2026-09-27, recorded here so they are not re-asked:

1. **Ticket config stores three category ids**, replacing the three `*CategoryName`
   strings. Nothing finds a category by name any more.
2. **Backfill by re-picking.** The migration clears the names; the dashboard's ticket
   settings flag the missing categories and ticket actions refuse until they are chosen.
   No name-guessing path, in the migration or at runtime.
3. **A saved category that has been deleted is recreated and its new id saved.** Safe
   now in a way it was not before: under id binding this fires only when the object is
   genuinely gone, never on a rename, so it cannot produce the duplicates #22 describes.
   Logged when it happens.
4. **The Discord setup modal loses its category fields.** The dashboard is the only
   place categories are chosen, with a category picker.

That step unblocks *Subsystem configuration is a declarable resource* (§5.7), which is
planned after it.
