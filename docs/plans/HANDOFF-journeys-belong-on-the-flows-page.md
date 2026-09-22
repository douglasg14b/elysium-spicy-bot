# Handoff — journeys belong on the flows page, not a page of their own

> **Written**: 2026-09-21
> **Why this exists**: the previous session built a dedicated journeys page. That is
> the wrong design, it was already recorded as wrong in the PRD, and it has to be
> replaced before anything else proceeds.
> **Read first**: this file, then `docs/plans/5B1-a-journey-can-hold-many-flows.md`,
> then PRD §5.8.

## 1. What we are fixing right now

**Delete the dedicated journeys page and redesign journey grouping as an
organisational element on the flows page.**

Commit `359e426` shipped `web/src/pages/JourneysListPage.tsx` (617 lines), a
`/journeys` route in `web/src/App.tsx:106`, and a nav entry in
`web/src/layout/DashboardLayout.tsx:50`. All of that is the wrong surface.

This was not a judgement call that went the other way. **The PRD says so
explicitly, in three places, dated 2026-09-19** — and the plan document that
authorised the work quoted the prohibition and then contradicted it:

- `flow-engine-v2-journeys-and-provisioning.md:311` — *"Grouping flows under a
  shared journey — with the journey appearing as an organisational element on the
  flows page, editable in place, and flows with a journey of their own not nested
  under one — is wanted but is not being designed now. **No dedicated journeys
  page.**"*
- `flow-engine-v2-journeys-and-provisioning.md:325` — PRD item 39, same wording,
  *"not a dedicated journeys page"*.
- `flow-engine-v2-build-order.md:787` — *"Journeys are created implicitly with a
  flow. **No journeys page.**"*
- `docs/plans/5B1-a-journey-can-hold-many-flows.md:869`-ish, under *"What this is
  not"* — quoted the prohibition, then listed slice C as "a journeys page".

Do not treat the existing page as a starting point to refactor. It is the wrong
shape; the layout question should be answered fresh against the constraints in §2.

## 2. What the operator wants, in their own framing

Stated 2026-09-21, and it matches PRD §5.8 almost word for word.

**A journey is not a folder and not a destination. It is a resource-definition
scope and an organisational unit around flows.** It has no page because it is not
a thing you go and manage; it is a property of how flows relate.

### The two use cases, and why the design must serve both

**Case A — one flow, resources, no journey concept visible.**
Someone creates a flow and wants resources it provisions. A journey exists
underneath holding exactly that one flow. **The operator must never see that
complexity.** The resources panel says "resources", the flow is not nested under
anything, and the word "journey" does not appear.

**Case B — several flows grouped, journey visible and editable.**
Someone creates multiple flows and groups them into one journey with resources
shared across them. Now:

- The flows are **grouped under the journey on the flows page**.
- The resources panel inside *any* flow in that journey must **indicate the
  resources belong to the journey, not to this flow** — and editing them from any
  member flow edits the journey's resources.
- The journey itself must be editable in place on the flows page, including
  **pulling up the resources dialog from the journey row**.

### Design constraints, verbatim intent

- **Grouping is done by drag and drop** — drag flows together to group them into a
  journey. That is the operator's stated interaction, not a menu item.
- **Single-flow journeys are left un-nested.** A flow with its own private journey
  renders as a plain row, exactly as today.
- **Designed well, not a drive-by.** The operator asked specifically for an
  excellent, intuitive, clean layout that *"presents the information that is
  necessary when it's necessary"* — i.e. progressive disclosure, with the journey
  concept appearing only once it earns its place.
- The distinction the UI must carry is **"these resources are the journey's"**
  versus **"these are just resources"**, and it is driven by whether the journey
  holds more than one flow.

### Design this before building it

The operator explicitly rejected an afterthought. Produce a layout proposal — a
`.mockup.html` via the `mockuplm` skill is the house tool for this — and get it
agreed **before** writing the page. Questions worth resolving in the mockup rather
than in code:

- How a group renders versus a plain row, without making ungrouped flows look
  second-class.
- What the drag affordance is, and what happens when a flow that already has its
  own declared resources is dragged into another journey (its resources merge? are
  refused? the operator picks?). **This is a real data question, not just visual**
  — see §4's open question on it.
- Where the journey's name, resource count, and resources-dialog entry point live
  on the group header.
- How ungrouping / detaching reads.

## 3. What has been achieved (high level)

Step 5A closed and was live-verified on a real guild on 2026-09-20/21: a journey
can build its own home — categories, channels and roles with compiled permission
overwrites — and unpublish takes back what it created while refusing what it
adopted. The cascade refusal was proven against real Discord behaviour.

Then 5B.1 shipped in two commits. **The backend half is good and should be kept.**

**`729439a` — the attachment became a row instead of a convention.**
`journeyKey` used to *be* the flow id, so a second flow could never join a journey:
it looked up a journey keyed by its own id and was told it declared nothing. A new
`flow_journey_links (guildId, flowId, journeyKey)` table with a dated migration and
a backfill makes the association real data. Six lookup sites now resolve through
`resolveFlowJourney`, with a temporary, loudly-commented fallback to the old rule.
The table lives in `src/features/provisioning/data/` rather than as a column on
`flows`, because `flows/data` is inside the vocabulary gate and `journey` is a
proven rejection — the gate working as intended.

**`359e426` — a second flow can join a journey.** Attach/detach routes, the
builder-side attachment control, and the journeys page. **The routes and the
builder control are sound; the page is what must go.**

Guards that were sabotage-verified along the way and should not be re-litigated:
the install ownership check, the attach route's guild scoping, the upsert's
move-don't-duplicate behaviour, the delete-with-attachments refusal, the
backfill count, and the shared-unpublish refusal.

## 4. What to do next, in order

### 4.1 Replace the journeys page (this is the immediate work)

**Remove:**
- `web/src/pages/JourneysListPage.tsx`
- the `/journeys` route, `web/src/App.tsx:106` and its import at `:18`
- the nav entry, `web/src/layout/DashboardLayout.tsx:50`

**Keep — these are backend and are correct:**
- everything in commit `729439a`
- the attach/detach/attachment routes in `src/web/api/journeyRoutes.ts`
- `web/src/flows/JourneyAttachmentControl.tsx` and `journeyAttachment.ts` —
  re-evaluate their *placement* in the builder against the new design, but the
  logic and its tests are fine
- the autosave fix in `useResourceAutosave.ts` / `resourceSaveQueue.ts`. **Do not
  revert this**: attaching a flow swaps the resource list on screen without the
  flow id changing, so autosave read the swap as an edit and would have written
  the old list into the journey just attached to. The save identity now includes
  the journey key.

**Build:** grouping on `web/src/pages/FlowsListPage.tsx` (454 lines, Mantine
`Table` inside a `Card`) per the agreed mockup, plus the journey-aware framing in
the resources panel (`web/src/flows/ResourcesPanel.tsx`, opened from the builder
toolbar; `InstalledResourcesDialog.tsx` is the separate installed-resources view).

**Open data question the mockup must answer:** dragging flow X into journey J when
X already declares its own resources. `attach` is an upsert on `(guildId, flowId)`
so the link moves cleanly, but X's old journey row and its `resource_bindings` do
not move with it. Bindings name real Discord objects and must not be silently
orphaned. Decide whether the drag merges declarations, refuses, or prompts —
and note that the existing refusal copy convention is to **name each affected
resource, never a count** (see `dialog-copy-density-over-prose` in memory, and
`sharedJourneyGuard.ts` for the established shape).

### 4.2 Then: slice E of 5B.1

The plan document has E's checklist. It is **not** only a live run — it deletes the
`journeyKey === flowId` fallback, and has a hard prerequisite:

> Wrap the attach and clear write-pairs in a transaction **before** deleting the
> fallback. Today a crash between `journeysRepo.create` and `attach` leaves an
> unlinked journey that the fallback silently repairs. Without it, that state is
> permanent and invisible — live channels, and nothing able to resolve them.

`resolveFlowJourney.ts` logs a warning whenever the fallback fires, so "every row
resolved" is checkable from a live guild's logs rather than assumed. Note the
warning is noisy in the test suite by design; read it from the guild only.

### 4.3 Then: the rest of 5B

Remaining, in rough value order: **drift detection and repair**, **verify
don't overwrite** (same machinery), **idempotent install / resume after
interruption**, ranked suggestions and disambiguation UI, resource binding as one
autocomplete field, rate-limit pacing. Subsystem config as a declarable resource is
blocked on issue #22.

Three 5B rows are **already done** despite the roadmap listing them: uninstall /
teardown policy, the install wizard, and per-resource provisioning opt-in.

One row is **dropped by operator decision**: *a resource bound by more than one
journey*. Resources are scoped to exactly one journey. Do not build it.

Independent of provisioning, parallelisable: a flow may hold many triggers; every
trigger in a flow fires (currently a real defect — only the first matching trigger
fires); trigger buttons deploy per destination; disconnected subgraphs are legible.

## 5. Where the documents are

| Document | What it is |
|---|---|
| `docs/plans/5B1-a-journey-can-hold-many-flows.md` | **The live plan.** Slices A–E, what A–D found, slice E's checklist. **Slice C's description is wrong and must be rewritten** to the flows-page design |
| `docs/prds/flow-engine-v2-build-order.md` | Step sequencing and status. §5B rows need the corrections in §4.3 above |
| `docs/prds/flow-engine-v2-journeys-and-provisioning.md` | The anchor PRD. §5.8 and item 39 are the authority on this design |

## 6. Standing constraints for whoever picks this up

- **Use Read / Edit / Write for file operations, never Bash `sed`/`cat`/heredocs** —
  a global user rule that overrides any session instruction saying otherwise.
- **Never read `.env.local`.**
- **Prefer foreground subagents for implementation work.**
- **Do not use `git stash` on this tree.** Four reviewers did during 5B.1; two left
  it broken and the work had to be recovered by hand.
- Testing target ~90%, a ceiling as much as a floor. Reviewer budget ~90–190k
  tokens a pass, at most two serial passes, **sabotage-verify first** — this repo
  has shipped a test that could not fail more than once.
- `web/` has **no jsdom and no React Testing Library**. Pure logic goes in
  `web/src/flows/__tests__/` as `*.test.ts`; components are not unit-tested.
- Baselines: server typecheck **17 pre-existing errors**; web **0**;
  `github-plan-cli/__tests__/ciBranchProductDiff.test.ts` fails pre-existing. Claim
  "no new errors", never "clean".
- The bot is **adults-only / NSFW by design**. Do not genericise persona or copy.
- `python3` is not installed — a sabotage attempted through it silently no-ops
  into a false pass.

## 7. Repo state at handoff

- Branch `feat/web-ui-flow-engine`, HEAD `359e426`. **Three commits unpushed**:
  `359e426`, `729439a`, `6c9ac93`.
- Full suite **1506 passing**, 1 pre-existing failure (`ciBranchProductDiff`).
  Server typecheck at the 17 baseline, web at 0. Both gates
  (`engineVocabulary`, `dependencyDirection`) pass.
- `stash@{0}` is a **redundant** snapshot of slice A/B left by a reviewer, fully
  superseded by `729439a`. Safe to `git stash drop`.
- `nimbalyst-local/mockups/` is untracked and unrelated — leave it alone.
