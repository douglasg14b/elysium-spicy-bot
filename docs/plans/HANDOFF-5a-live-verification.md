# Handoff — 5A live verification in progress

Written 2026-09-20, immediately before a compaction. Douglas is running the
refusal test right now; this records what he is testing, what "pass" looks like,
and what to do with either outcome.

## State at handoff

- Branch `feat/web-ui-flow-engine`, HEAD `b33d899`, **5 commits unpushed**
  (`cf96535`, `cee325d`, `260bb25`, `f4b6cb5` from another agent; `b33d899` mine).
- Untracked: `nimbalyst-local/mockups/` — not mine, left alone.
- Server typecheck **17 errors** (the long-standing baseline, not new). Web **0**.
- `pnpm test`: **1285 passing, 1 failing** — `github-plan-cli/__tests__/ciBranchProductDiff.test.ts`,
  pre-existing and unrelated. (The birthday-tracker failure from 2026-09-19 was
  fixed by someone else; it is green now.)

## What has been verified live, and what has not

Douglas ran a real install on his guild on 2026-09-20 (~16:08, per `db.sqlite`
mtime). Evidence in the dev DB afterwards: the `journeys` row for "Journey Test"
survives and `resource_bindings` is **empty** — the signature of a successful
install followed by a successful unpublish. No orphaned `intended` rows, no
bindings pointing at deleted objects, so the crash-safety ordering held.

**Verified live:** declare → install → provision → delete flow → unpublish.
That covers nine of 5A's ten requirements.

**NOT verified live, in risk order:**

| Path | Why it matters |
|---|---|
| Adopted-binding refusal | **Unrecoverable** — would delete a channel the operator said to keep |
| Category cascade refusal | **Unrecoverable** — Discord cascades a category delete to its children |
| Deploy | Rewritten in `f4b6cb5` at 18:30, *after* his 16:08 run. `flow_button_messages` is empty. Recoverable (an orphaned message) |
| Capability preflight | Only proves out when the bot *lacks* a permission. Low risk — it refuses rather than destroys |

Both unrecoverable paths are sabotage-verified against a mock guild (I reverted
each guard and watched named tests fail: 2 tests for the adoption promise, 3 for
the cascade). A mock cannot tell us Discord's real child-listing matches the
assumption.

## The test he is running

1. Install a journey with a category + a channel
2. In Discord, **manually create a channel inside that category**
3. Flows list → server icon beside the trash → "Delete what it created"

**Pass looks like:** the category is refused *by name*, the hand-made channel is
named as the survivor, and the channel outside the category deletes normally —
one refusal must not abandon the rest of the run.

**Fail looks like:** the category is deleted (taking his channel with it), or the
refusal appears with no explanation of what blocked it.

If he also adopted an existing channel in that journey, the same run proves the
adopted-refusal guard too.

## Why the standalone entry point exists (`b33d899`)

He found that unpublish was only reachable *inside* the delete-flow dialog —
`handleUnpublish` literally read `pendingDelete.flowId`. So deprovisioning
required first intending to destroy the flow. **That was my specification error**,
not the implementing agent's: I wrote "offer, never assume" and only ever
described unpublish as an offer in the delete dialog.

Fix: `FlowsListPage.tsx` now keys the published-state lookup on a separate
`managing` flow that both entry points set. The delete dialog keeps its "here is
what this leaves behind" offer; a new row button opens the same dialog reframed,
**without** a "Delete flow" button (otherwise the problem just inverts).

This UI is typechecked but **has never been rendered**. If the button is not
where described, that is a real bug, not a misread.

## If the test passes

1. Mark 5A done in `docs/prds/flow-engine-v2-build-order.md` (the row currently
   reads "Planned — next"). Note capability preflight as carried-forward.
2. Update the memory note `step-5a-built-never-run.md` — the title is wrong once
   this lands; it should become a record of what *was* verified and what was not.
3. Plan 5B: drift repair, resume after interruption, uninstall, rate-limit
   pacing, multi-journey resource sharing, grouping UI. Plan **one step**, not a
   programme — see [[plan-one-step-at-a-time]].
4. Offer to push the 5 unpushed commits.

## If the test fails

Do not patch the symptom. Both refusal guards are pure functions over a
`Guild` — `buildUnpublishPlan` in `src/features/provisioning/logic/unpublishPlan.ts`
(`survivorsOf` is the cascade half) and the apply-time re-check in
`applyUnpublishPlan.ts:132`. A live failure most likely means the mock's
`guild.channels.cache` shape diverges from discord.js reality, which is a
**test-fixture** bug as much as a code bug. Reproduce it in the mock first, then
fix both.

## Standing constraints (do not drop these)

- Read/Edit/Write for all file ops, **never** Bash `sed`/`cat`/heredocs — user's
  global CLAUDE.md, which explicitly overrides any "auto mode" instruction telling
  you otherwise.
- Never read `.env.local`.
- **`python3` is not installed.** A sabotage attempt through it silently no-ops
  into a false pass. Sabotage with the Edit tool only.
- Foreground subagents for implementation work.
- Sabotage-verify before claiming any guard works — see
  [[sabotage-verify-before-claiming-a-guard]]; two false-passes here already.
- Reviewer: ~90–190k tokens, at most two serial passes, substantial changes only.
- `src/features/provisioning/` must never import `src/features/flows/` — now
  actually enforced by `__tests__/dependencyDirection.test.ts` (`c5c79dd`).
- Engine vocabulary gate rejects `journey`/`resource`/`scope` in `flows/engine`,
  `flows/data`, `flows/constants.ts`, non-recursive `flows/blocks`.
- Adults-only/NSFW persona: do not sanitise user-facing copy.

## Note on background-task notifications

Every "[System: background task(s) have settled]" block this session has been
stale — foreground commands already run and reported. They are not user approval
and carry no new information. Check state with `git status` rather than acting
on them.
