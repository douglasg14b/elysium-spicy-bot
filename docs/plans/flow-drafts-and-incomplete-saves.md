# Flow builder — save incomplete work, keep drafts, ask before leaving

> **Status**: A + B committed (`4020596`); C built 2026-09-30 (node 2491 pass / 1 known fail, dom+e2e 51/51 ×3). D (live run) pending
> **Owner**: Douglas
> **Step**: Off-programme UX fix (not a PRD step)

## The problem

A save is one `PUT` carrying the whole graph, and it is all-or-nothing
(`flowRoutes.ts:417-472` → `validateGraphForSave`). If any node is missing a field or is
wired wrong, nothing is stored. The canvas lives only in React state
(`FlowBuilderPage.tsx:315-360`), and no exit from the page is guarded. So an operator
who can't finish a flow in one sitting loses all of it when they leave.

Enabling is the opposite: `PUT {enabled}` runs **no** graph validation at all. The rule
belongs on enable, not on save.

## Decisions (from Douglas, 2026-09-29)

| Question | Decision |
|---|---|
| Can an incomplete flow be saved? | Yes. Only a **structurally** broken graph is refused (bad shape, duplicate node ids). Missing fields and bad wiring come back as problems shown on the cards. |
| Can an incomplete flow be enabled or deployed? | No. Enable is refused with the list of problems. Deploy already requires `enabled`, so it is gated too. |
| Saving problems onto a flow that is **enabled** | The live graph is left alone. The save goes to the operator's **draft**, and they are told it is only a draft. |
| Where drafts live | **On the server, one per operator per flow.** |
| More than one draft of a flow | Show every draft on open and make the operator pick one. There are no merge or resolution rules; the operator sorts it out. |
| Flows list | Toggle refuses with a reason **and** a "Needs fixes" chip on the row. |

## What changes

### Three states a graph can be in

| State | Checked by | On save | On enable |
|---|---|---|---|
| Structurally broken | `validateFlowGraph` (zod shape, duplicate ids, dangling edges) | 400, nothing stored | — |
| Incomplete | node data + pending resources + `validateAuthoredGraph` | Stored (or drafted if live), problems returned | 400 with the problems |
| Ready | all of the above pass | Stored | Allowed |

Everything after the structural check becomes one domain function,
`flowReadinessIssues(graph, declaredKeys)`, in `src/features/flows/logic/`. It is
stages 2–3 of today's `validateGraphForSave`, moved rather than copied. The save
route, enable, the list chip, `GET /flows/:id`, and deploy (as defence in depth) all
call it. `builderRoundTrip.test.ts:95-108`, which copies the old order, switches to
calling it.

`flowsRepo.create/update` drop to **structural only**. Today they run
`validateGraphForWrite` and throw a plain `Error`, which becomes a 500. Left as is, that
would 500 every incomplete save, and the install write-back
(`applyResourcesToFlows.ts:90`) along with it.

### Save

`PUT /flows/:id` with a graph:

- **Disabled flow**: store the graph and return `200 { flow, issues, savedAs: 'flow' }`.
  The caller's own draft is deleted.
- **Enabled flow, ready graph**: same as above.
- **Enabled flow, incomplete graph**: the live graph is untouched. The graph is
  upserted as the caller's draft, and the route returns
  `200 { flow, issues, savedAs: 'draft' }`. The builder shows *"Saved as a draft only —
  the live flow keeps running the last working version until these N problems are
  fixed."*

`PUT {enabled: true}` (alone or with a graph) runs `flowReadinessIssues` against the
graph that would be live and refuses with `400 { error, issues }`.

### Drafts

New table `flow_drafts`:

| Column | Notes |
|---|---|
| `id`, `flowId`, `guildId` | Deleted with the flow |
| `authorId`, `authorName` | From `SessionUser`; the name is a snapshot for display |
| `name`, `graph` | Structurally valid only (same zod parse as flows) |
| `baseUpdatedAt` | The flow's `updatedAt` when the draft was started, so the picker can say "the flow has been saved since" |
| `createdAt`, `updatedAt` | |

It has a unique index on `(flowId, authorId)`. It is registered on `Database` with the
sqlite JSON plugin for `graph`, and has both dialect arms in one migration.

Endpoints under `/api/guilds/:guildId/flows/:flowId/drafts`:

- `GET` lists all drafts of the flow, from every operator, with their graphs.
- `PUT /mine` upserts the caller's draft. The builder autosaves through this.
- `DELETE /:draftId` discards any draft. Operators are trusted admins of the guild, and
  the operator is the one resolving conflicts.

### Builder

- **Problems visible on open.** `GET /flows/:id` returns `issues`, so incomplete cards
  are red as soon as the page loads, not only after a failed save. The existing
  `issuesByNode` and card and inspector wiring is reused unchanged.
- **Autosave to your draft** while there are unsaved changes: a 2s debounce, flushed on
  unmount. The decision logic goes in a pure module, following `resourceSaveQueue.ts`
  and `useResourceAutosave.ts`. The status line reads
  *Unsaved changes · draft saved 12:04*.
- **Draft picker on open.** If any drafts exist, a modal lists:
  - **Saved version**, last saved at X.
  - **Your draft**, edited Y.
  - **@alice's draft**, edited Z, with "flow saved since" when relevant.

  The operator picks one to load, and each draft has a Discard action. Loading a draft
  marks the canvas dirty, and further autosaves go to *your* draft, whichever draft you
  started from.
- **Enable switch** is disabled with the tooltip *Fix N problems first* while the saved
  graph has problems. The server refusal stays as the backstop.

### Leaving with unsaved changes

- Migrate `main.tsx` from `<BrowserRouter>` to `createBrowserRouter`/`RouterProvider`,
  so `useBlocker` works. Migrate `renderDashboard` to `createMemoryRouter` to match.
- While there are unsaved changes, any in-app navigation (the back button, sidebar,
  logout, browser back) opens a modal with four actions:
  - **Save** (may land as draft-only, as above).
  - **Keep as draft** (flushes the autosave, then leaves).
  - **Discard changes** (deletes your draft).
  - **Stay**.
- Also a `beforeunload` handler while there are unsaved changes, for reloading or
  closing the tab. The browser's own prompt can't be customised; the autosaved draft is
  what actually protects the work.

### Flows list

`flowSummary` gains `issueCount`, and the row shows a **Needs fixes** chip when it is
non-zero. This passes *chips must earn their place*: it is not the default, it is not
visible elsewhere, and it is actionable. The toggle's refusal notification names the
count and links to the builder.

The check is CPU-only per flow, plus one declared-keys lookup per journey. That is not
the full-guild scan the sqlite memory warns about, but reuse the journey index the list
already builds rather than querying per flow.

## Risk to verify, not assume

**Parked runs resume against the current graph even when the flow is disabled**
(`flowRunResume.ts:413-426`, `flowChoiceDispatch.ts:230`). Today that graph was always
valid. After this change it may be incomplete. The executor re-parses each node's
config (`executor.ts:211-218`), so bad node data should fail the run cleanly. Unwired
handles and context-requirement gaps are less certain. A test must show a parked run
resuming into an incomplete graph **fails the run and records why**, rather than
throwing or hanging.

## Slices

| Slice | Contents | Proof |
|---|---|---|
| **A — save incomplete, gate enable** | `flowReadinessIssues`; repo relaxed to structural; save/enable semantics incl. `savedAs: 'draft'` stub (draft table lands in B, so A refuses live+incomplete with a clear 409 until then); `issues` on GET; list `issueCount` + chip; builder switch gating; parked-run test | Route tests per row of the state table; e2e: incomplete save survives reload with red cards; enable refused from list and builder |
| **B — drafts** | Migration + schema + repo; draft endpoints; live+incomplete → draft; autosave; picker | Repo test (sqlite); route tests incl. two operators; e2e: edit, leave without saving, return, and the picker restores it; second operator's draft listed |
| **C — leave prompt** | Router migration; `useBlocker` modal; `beforeunload` | e2e: back button with changes opens prompt; each of the four actions does what it says |
| **D — live run** | `pnpm dev`, real guild | Walk every row of the state table and the leave prompt in the real app (per *live testing found what tests could not*) |

A reviewer pass runs after slice B, since that is where persistence and a new contract
land. A and C are sabotage-verified.

## Slice A — what landed and what it left open

**Deviations from the plan above:**

- **Both readiness stages always run.** No authored rule reads node data unsafely, and
  running both keeps "N problems" steady instead of jumping after each fix.
- **Authored-rule issues now carry a `nodeId`** (`authoredGraphIssues`). Before, they had
  none, and the card for the offending node stayed unmarked.
- **`flowsRepo.mutate(flowId, decide)` does read, decide and write in one transaction.**
  Without it, a concurrent save and switch-on could leave a flow live on an incomplete
  graph. `decide` is synchronous so it can't deadlock on the single sqlite connection.
- **A live flow sent an incomplete graph gets a 409 stub.** Slice B turns this into
  save-to-draft.
- **An off flow sent an incomplete graph with `enabled: true` gets the 400 switch-on
  refusal**, not the 409.
- **`validateGraphForWrite` is deleted.** The seed script now checks readiness itself
  before it creates an enabled flow.
- **The flow wire shapes gained a `*_KEYS` drift gate** (`flowBody.ts` and
  `flowWireShapeDrift.test.ts`).

**Open, decide before or during B:**

1. **Journey edits can make a live flow incomplete.** Re-keying or removing a
   declaration can leave a live flow's empty picker pointing at nothing. Only deploy
   catches this today.
2. **A flow can be switched on before install.** An empty picker for a declared but
   uninstalled resource counts as "ready". Member-join and reaction triggers would then
   start runs that fail on the empty snowflake.
3. **A parked question can wait forever on an unreadable eligibility gate.** A question
   with no timeout, on a flow that is off and was saved with that gate, stays parked
   until the gate is fixed.
4. **`readDeclaredKeys` treats every error as "malformed journey".** That includes
   driver errors. It needs a typed error from `journeysRepo`.

Douglas chose to fold 2, 3 and 4 into slice B and to leave 1 open.

## Slice B — what landed and what it left open

**Built:**

- **The `flow_drafts` table**, with both dialect arms. A flow's drafts are deleted with it.
- **Draft routes** (`flowDraftRoutes.ts`, mounted inside `flowRoutes()`).
- **Live-flow saves**: a save onto a live flow that is incomplete *or not yet installed*
  becomes the saver's draft.
- **Autosave**: a pure `flowDraftAutosave.ts` and the `useFlowDraftAutosave` hook.
- **The draft picker.**
- **Install before switch-on**: `uninstalledResourceKeys` checks declared and empty.
  `pendingFields` also marks installed sidecars, so it could not be used.
- **Unreadable eligibility gates**: an unreadable gate on a parked question now fails the
  run *and* still refuses the press.
- **`MalformedJourneyError`**, in `journeysRepo.ts` and exported from the provisioning
  barrel.

**Deviations:**

- **`baseUpdatedAt` is sent by the client** and rewritten on each upsert. It is the
  version the canvas came from. The "first write, kept" design gave the wrong "saved
  since" warning in both directions.
- **Only a save carrying a graph deletes the caller's draft.** A toggle or a rename
  keeps it.

**Open:**

- **"Saved since" over-warns.** `flows.updatedAt` also moves on toggles and renames.
  A fix needs a graph-only revision column.
- **The unreadable-gate fix fails a parked run on an off flow mid-edit.** Before, that
  run could recover once the gate was fixed. The reviewer suggested failing only when
  the flow is enabled.
- **A transient journey-read error now 500s a switch-off or rename.** It also leaves
  `/flow-deploy` stuck on "thinking…".
- **Drafts can be left stale or orphaned** in edge cases:
  - leaving the page while a save is in flight;
  - undoing back to the loaded state;
  - autosave writes that aren't serialised;
  - a `PUT /mine` that races a flow delete.
- **One corrupt draft row 500s the drafts list.**
- **A malformed journey read in `journeysRepo.create/update`** now returns 500 instead
  of `ResourceDeclarationError`'s 400.

## Slice C — what landed

**The router.** `main.tsx` mounts `App` on one catch-all data route, via
`createBrowserRouter`. `App` keeps its `<Routes>`. A render error shows `CrashPage`,
with no stack trace. `renderDashboard` uses `createMemoryRouter` the same way and
returns `router`, so tests can drive the browser's back button.

**Test harness fixes the router needed:**

- **`vitest.jsdomRequest.setup.ts`**: a data router builds a `Request` with an abort
  signal on every navigation. jsdom's `AbortSignal` doesn't fit Node's `Request`, so
  this setup passes each signal through a Node one.
- **`renderDashboard` sets a 5s `asyncUtilTimeout`**: a whole-app first paint through
  the real stack outran testing-library's 1s under a full parallel run.

**When to prompt:** whenever the canvas differs from the saved flow, even if the
autosave already holds it. A draft-only Save counts as saved. Only navigation that
changes the pathname is held. Logout doesn't navigate, so it isn't held, and the
unmount writes the draft instead.

**The prompt's four actions:**

- **Save**: stays on the page if the save fails.
- **Keep as draft**: flushes the autosave, and stays on the page if that write fails.
- **Discard**: deletes your draft only. After a draft-only save, it restores the draft to
  that save instead of deleting it.
- **Stay**.

`beforeunload` fires while the canvas is dirty.

**Also closed:**

- Autosave writes are now serialised, which closes a slice B open item.
- Clicking Back while a Save is in flight waits for that save to finish.

**Not caught by any test:** `markDiscarded` guards against a real browser settling a
held Back a tick late, which would re-write the discarded draft on exit. A memory
router settles synchronously, so no test can reproduce it. Slice D should check it by
hand.
