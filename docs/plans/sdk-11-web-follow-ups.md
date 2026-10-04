# SDK step 11: the web follow-ups (and the last small leftovers) from steps 1–10

Follows step 10 (`sdk-10-server-follow-ups.md`, committed as `180d88e`).

## Why this slice

Douglas asked for the follow-up lists to be cleared (2026-10-04). Step 10 took the server and tooling items; this step takes the web ones plus three small server leftovers step 10 recorded. Each item below names the Follow-ups entry it comes from, and each was checked against the tree before planning.

## Every carried follow-up, checked

What each `sdk-*.md` Follow-ups entry is now, so the list this step leaves is complete.

| From | Entry | Now |
| --- | --- | --- |
| 2 | `onUnauthorized` not wired | Closed in step 7 (then replaced by the session gate's `fetch` in step 9). |
| 2 | Query cache not cleared on logout | Closed in step 7 (`AuthContext` `signedOut`). |
| 2 | Overlapping saves across guild switches | **This step, §1.** |
| 2 | SPA fallback answers unmounted `/api/*` GETs | Closed in step 7 (`app.all('/api/*')` 404 in `server.ts`). |
| 2 | Item 12 pinned, not visible | Not a defect: a note that the Warnings channel picker cannot be emptied, so its `minLength` rule has no UI state. Nothing to do until a picker can be emptied. |
| 2 | `@hey-api/openapi-ts` declares Node ≥ 22.18 | **Still open, not this step's.** The workflows pin Node `"22"` (latest 22.x) and Docker runs no generator. Pinning `engines` would make `pnpm install` refuse the Node 20 Docker image, so it is a tooling decision; see Questions. |
| 3 | `importOriginal` for the journey route mocks | Closed in step 8. |
| 3 | `GET /flows` 500 not an `ErrorBody` | Closed in step 10. |
| 3 | `togglingId` holds one id | **This step, §2.** |
| 3 | Builder reads `/published` through the hand client | Closed in step 6. |
| 3 | Dialog loader relies on `staleTime` 0 | **This step, §3.** |
| 3 | Loud refresh cancelled by a toggle is never toasted | **This step, §2.** |
| 4 | Ticket-type key over 64; e2e log noise; `sdk:check` noise | Closed in step 10. |
| 5 | Hand-authored limits on `BlockConfigField` stay | Decided in step 6 (§5): server-declared manifest members, not a browser copy. |
| 5 | "Needs at least N." list hint | **This step, §4a.** |
| 5 | x-messages change could be its own commit | Moot: committed. |
| 5 | `isFormatSchema`; walk labels; `blockWith` | Closed in step 10. |
| 5 | Browser's first sentence may not be the server's first | **This step, §5.** |
| 5 | `/api/nodes` on the bridge | Closed in step 6. |
| 6 | Deploy e2e | Closed in step 10 (first deploy; redeploy is out of scope). |
| 6 | Journey routes' `.refine()` | Closed in step 8. |
| 6 | `staleTime` stays 0 | **This step, §3.** |
| 6 | Brief's stash bullet placement | Closed: the brief now has a "Git and imports" section. |
| 6 | Commit in two parts | Moot: committed. |
| 7 | The overlay question | Closed in step 9 (Douglas picked the overlay). |
| 7 | Journey calls don't sign out on a 401 | Closed in step 8 (hand client deleted). |
| 7 | A 401'd mutation's notification | Closed by construction in step 9: a held request never fails. |
| 7 | Brief's baselines placement | Closed: the brief's Baselines list now holds them. |
| 7 | Stale "no `.test.tsx`" page comments | **This step, §7.** |
| 8 | 64-character cap written twice; `invalidKey` prose | **This step, §4b, §4c.** |
| 8 | Display-order lists unchecked | **This step, §4d.** |
| 8 | `SchemaMatches` in root `tsc` only; journey 500s | Closed in step 10. |
| 9 | Cookie changing owner without a 401 | **Out of scope** (open question to Douglas; session-gate semantics). |
| 9 | `sessionEnded()` leaves held requests pending | **Out of scope** (unreachable from the UI). |
| 9 | Other dialogs over the canvas lack `nokey` | **This step, §6.** |
| 10 | `levelingCohorts.ts` vacuous anchor | **This step, §8.** |
| 10 | `RESUME_REPRESENTATIVES`' `satisfies` only fails root `tsc` | **This step, §8** (same class as step 10's guard moves; one exported type and one assertion). |
| 10 | `updateDeployedTicketMessage` swallows its errors | **This step, §8.** |
| 10 | Redeploy has no e2e | **Out of scope** (TestDiscord models no message delete). |
| 10 | `ticketActions` asserts the panel redraw in its fixture | **This step, §8.** |
| 10 | Brief's line-endings trap | Closed: the brief now says line endings are settled. |

## Decisions taken

All conventional; none needed Douglas.

### 1. Overlapping saves (step 2)

**Checked.** The guild-switch framing is unreachable today: `GuildContext` has no switcher (`selected` is `guilds[0]`). Every cache write already goes to the key built from the save's own `path`, so the "wrong cache entry" half is not real either. **The race is real by route instead:** save on Settings, go to Warnings, come back. The form remounts, its `useMutation` is new (`isPending` false), so a second PUT can start over the first; and the remount's fresh GET was never cancelled by the first save's `onMutate`, so if it reads before the PUT writes and answers after it, it puts the old value back over the save's answer. A guild switch, when one exists, is the same remount.

- **The save's pending state lives in the mutation cache, keyed by what it writes.** Each settings write gets `mutationKey` = the query key of the entry it writes (`getWarningsConfigQueryKey`, `getGuildSettingsQueryKey`, `getTicketsConfigQueryKey` — so per guild by construction), and the form reads `useIsMutating({ mutationKey })` for "saving". Any mount of the form for that guild sees a save another mount started.
- **Ticket config's three writes share one key**, since they all write the one config entry: while any is in flight, every config write button waits. This also closes the same race within one mount (a slow categories save answering after a fast type save, putting the type list back as it was).
- **A save's answer is written as the newest thing known:** `writeSavedAnswer(queryClient, queryKey, answer)` (new, `web/src/api/writeSavedAnswer.ts`) cancels any read of the entry that started while the save flew, then sets the answer. No extra GET, so the existing "one GET" pins stand.
- Notifications are unchanged: a save's toast still shows after its form unmounted — it is news wherever the operator is.
- **Not changed:** ticket actions (`useTicketAction`). Their server writes are conditional, so a second action started from a remount gets the server's own refusal (409), not a silent overwrite. The flows list is not keyed by guild; its in-flight state is §2's.

### 2. Flows list toggles (step 3)

**Checked, both real.** `togglingId` is one id, so a second switch un-disables the first. A loud `refreshFlows()` cancelled by a toggle's `cancelQueries` resolves quietly with the old list (query-core 5.104.1: a revert-cancel returns the existing data), and the toggle re-reads quietly, so a failure in that window is never toasted.

- `togglingIds: ReadonlySet<string>`.
- **The re-read is owed, once, after the last switch settles**, as loud as the loudest read any switch cancelled. A ref counts loud refreshes in flight; a switch that cancels a read records whether it was loud; the switch that brings the in-flight count to zero issues the re-read. Re-reading only after the last switch also stops one switch's re-read landing over another's optimistic state.

### 3. `staleTime` (steps 3 and 6)

Remove the dependency: `staleTime: 0` at the call sites that need a fresh answer — the installed dialog's `useQuery` and the builder load's three `fetchQuery`s — with the comment at `FlowBuilderPage` saying so instead of crediting the client's default.

### 4. Browser-side rule copies (steps 5 and 8)

- **a. "Needs at least N."** Removed from `TextListControl` and `ObjectListControl`. The server's own "Add at least N entries." arrives as the field's error (live once edited, or from the re-check). An untouched list below its minimum now says nothing until it is edited or re-checked: an under-report, which the standing decision allows.
- **b. Slug caps.** `contractValues.ts` reads `RESOURCE_KEY_MAX_LENGTH` off `zResourceDeclaration.shape.key` and `JOURNEY_KEY_MAX_LENGTH` off `zFlowGroup.shape.newJourneyKey`, throwing at load if the generated schema has no maximum (zod's `maxLength` is `number | null`). The slugifiers slice to those, **then** trim hyphens, fixing the trailing-hyphen key the server refused. Pinned by a parity case: every slug either is empty or passes the generated key schema.
- **c. `invalidKey`.** The chip carries the server's own sentence for the field that failed (`detail.problem`, the first issue of the generated zod the detector already runs), and its tooltip shows it. The static `reason` (and the contract doc's row) stop restating the pattern.
- **d. Display orders.** `AUDIENCE_ORDER`/`ACCESS_ORDER` equal the generated enums' order, so they become `zPermissionAudience.options`/`zPermissionAccess.options` (complete by construction). `RESOURCE_KIND_ORDER` differs on purpose (channel first), so it stays a literal and a test holds it to a permutation of `zResourceKind.options`.

### 5. Which rule's sentence shows first (step 5)

**Checked, real in principle.** zod 4 reports a string's issues in declaration order (`.regex(…).min(1)` on `''` gives the pattern sentence first); `.int()` aborts, so on a number only `.int()` after a bound reorders. hey-api's generated zod always runs format, then length, then pattern (and the whole-number rule, then bounds). The server answers with the first issue. So a schema declared out of that order shows a different first sentence in the browser.

- **One rank, two places.** `src/shared/zodRuleOrder.ts` (plain zod types) says whether a node's checks run in the generated order: on a string, length rules before a `.regex()`; on a number, `.int()` before bounds. `attachRequestMessages` reports an out-of-order route node (so the emit fails), and `browserFieldRules` reports a block whose own field schema is out of order (the server runs the block's schema, not the fresh browser one).
- Not ranked: string formats other than `.regex()`. The only one on a request schema is `flowDraftBaseSchema`, a format schema whose check runs first on both sides; a worded format check already fails the emit.
- If an existing schema fails the new rule, it is reordered server-side and the regenerated zod is a real diff.

### 6. React Flow `nokey` (step 9)

A theme default, so no dialog can forget it: `components.Modal.defaultProps.className = 'nokey'` in `theme.ts`, with the reason moved there from `SessionExpiredPanel`, which drops its own prop (its e2e becomes the regression test for the default). No `Modal` passes its own `className`, so nothing overrides it. A new e2e drives the Deploy dialog: a selected card, focus on a dialog button, Backspace, the card stays.

### 7. Stale comments (step 7)

The follow-up named four pages; the same false claim ("no jsdom", "no `.test.tsx`") is in many more places under `web/src` (34, as built). Each is corrected; where the comment's real reason survives (a pure module is cheaper to drive than a render), it is kept.

### 8. Server leftovers (step 10)

- `levelingCohorts.ts`: the vacuous `MissingCohortLabel`/`cohortLabelsAreComplete` anchor goes; the annotation and the runtime test are the guards.
- `RESUME_REPRESENTATIVES`: an exported `ResumeRepresentativesAreReasons` type, asserted in `conformance.test-d.ts`, replaces relying on `satisfies` for the suite.
- `updateDeployedTicketMessage` throws; its two callers already own the failure (`.catch` + log). Each caller gets a test that a failed redraw does not fail the save.
- `ticketActions.test.tsx`: the fixture returns the panel; a named case asserts the settings save redrew it.

## Behaviour changes (expected)

- Coming back to a settings form while its save is in flight shows it saving; a second save cannot start over it; a read the remount started cannot put the old value back.
- Ticket settings: while any config write is in flight, the other config write buttons wait.
- Two flows switched quickly both stay disabled until each settles; a refresh a switch interrupted is re-read once all switches settle, and its failure is toasted if the refresh was a loud one.
- A list field below its minimum no longer shows "Needs at least N."; the server's "Add at least N entries." shows once it is edited or re-checked.
- A slug whose 64th character would have been a hyphen is one character shorter instead of refused.
- The `Invalid key` / `Name required` chip's tooltip is the server's sentence for what is wrong.
- Every Mantine modal is opaque to React Flow's keys.

## Checks (planned)

- Suite against 3,094 pass / 1 known failure; typechecks against root `tsc` 17, `typecheck:e2e` 4, web and SDK clean.
- `pnpm sdk:generate` twice, byte-identical; `pnpm sdk:check`.
- e2e: `sessionExpiry`, `flowBuilderToolbar`, `ticketActions`, plus the full `web/e2e` run.
- Sabotage, each restored:
  1. the settings `mutationKey` dropped → the remount test fails;
  2. `writeSavedAnswer`'s cancel dropped → the late-GET test fails;
  3. `togglingIds` back to one id → the two-switch test fails;
  4. the owed re-read made quiet → the toast test fails;
  5. a global `staleTime: Infinity` → the dialog and load tests still pass; then one call site's `staleTime` dropped → its test fails;
  6. a slugifier trimming before slicing → the parity case fails;
  7. a route schema and a block schema declared `.regex().min()` → the emit/derivation tests fail;
  8. the theme default removed → the Deploy-dialog e2e and `sessionExpiry` fail;
  9. a caller's `.catch` removed → its "redraw failure doesn't fail the save" test fails.

## As built

As planned, with the changes below. Where they contradict the sections above, this section is the record.

### 1. Overlapping saves
- **`web/src/api/writeSavedAnswer.ts`** (new): cancel the entry's reads, then `setQueryData`. Called from each settings mutation's own `onSuccess`, so the save is still pending while it runs.
- **`web/src/api/useSaveInFlight.ts`** (new, from review): "is a save with this key pending", read live through `useSyncExternalStore` over the mutation cache. **Not `useIsMutating`**: that hook (5.104.1) computes its answer once at first render and only recomputes on a cache event after its subscription, so a save settling between a remount's render and the subscription would leave Save stuck "saving" until the settled mutation is garbage-collected, five minutes later.
- **Warnings and Server Settings:** `mutationKey` = the entry's query key; `saving = useSaveInFlight(key)`; their `onMutate` cancel is **gone** — `writeSavedAnswer`'s cancel covers every read still in flight when the answer lands, and a read that answers *before* the save is harmless (the draft is on screen). A refused save no longer leaves a cancelled read unreplaced.
- **Ticket settings:** all three writes share `mutationKey: configKey`; the two saves write their answer in `onSuccess` (moved from the handlers); `configWriting = useSaveInFlight(configKey)` disables Save changes, Save type and Delete type while any config write is in flight. Its `onMutate` cancel and `onError` re-read pair stay as they were.
- Ticket actions and the builder's saves are unchanged (§1 of the decisions).

### 2. Flows list switches
- `togglingIds: ReadonlySet<string>`; `loudReads` and `switches` (in-flight count, owed re-read) are refs.
- **Beyond the plan (review):** a refresh asked for while any switch is in flight is not sent; it is owed, at its loudness, and the last switch to settle issues one read. This closes a refresh started during a PUT landing over the switch, and the double "Couldn't refresh" toast when such a refresh and the owed re-read both failed. The switch's bookkeeping now sits inside the `try` whose `finally` undoes it.

### 3. `staleTime`
As planned. `queryClient.ts` is unchanged.

### 4. Browser rule copies
- **a.** As planned, plus (review): `ObjectListControl` now renders `error` under the list as `TextListControl` does, and leaves `controlErrorProp.test.ts`' exemption list, which holds only `EligibilityControl` now. Without it, an object list below its minimum would have been reported nowhere in the inspector once the hint went (latent: no shipped object list declares `minEntries`).
  - `minEntries` stays on the manifest; no control reads it now. Conformance still uses it to size probes and to cross-check `maxEntries`. See Follow-ups.
- **b.** As planned. The slug tests derive their lengths from the constants rather than pinning 64.
- **c.** As planned. `invalidKey`'s `reason` is now "The key or the name breaks the server's own rule for it, so the save will be refused."; the tooltip on a row shows `detail.problem`, the generated zod's sentence (e.g. "Resource keys cap at 64 characters.", "Give the resource a key.").
- **d.** As planned. `PERMISSION_AUDIENCES`/`PERMISSION_ACCESS_LEVELS` live in `contractValues.ts` with rows in `src/web/api/__tests__/contractValues.test.ts` against `permissionIntent.ts`.

### 5. Rule order
As planned. No existing route or block schema was out of order: the spec and SDK are byte-identical to before this step. `requestMessages.ts` documents that the check also runs on a `.pipe()`'s undocumented side (stricter than needed; no such schema exists). The new empty-key chip case pins that the browser leads with the length sentence, as the server does.

### 6. `nokey`
As planned.

### 7. Comments
The false "no jsdom / no `.test.tsx` / no component runner" claim was in **34** places, not four: the 28 the first grep found, plus `driftSummary.ts`, its test, `JourneyAttachmentControl.tsx`, `controls/duration.ts`, `controlErrorProp.test.ts` (whose stated reason for reading source instead of rendering was the false one; now "cheaper than building each control's props") and `resourceRows.ts`' "genuinely untestable" refs (review).

### 8. Server leftovers
- `RESUME_REPRESENTATIVES`: the exported type is **`RejectedResumeEntries`** — the plan's name failed `engineVocabulary.test.ts`.
- `ticketActions.test.tsx`: the named case is "the deployed ticket panel › is redrawn with the new configuration when the settings are saved" (edited, and the configured panel's "⚙️ Current Configuration" field).
- The rest as planned.

### Behaviour changes, final
- Leaving a settings page mid-save and coming back shows Save spinning and the picker held; no second save can start; the save's answer is what shows when it lands.
- Ticket settings: while one config write is in flight, the other config write buttons are disabled.
- Flows list: every switch in flight stays disabled until its own answer; a list refresh asked for during a switch is sent once the switches have all landed, and a failed loud refresh still toasts "Couldn't refresh" with the server's sentence.
- "Needs at least N." is gone from list fields; the server's "Add at least N entries." shows under the list (both list controls) once edited or re-checked.
- A derived key whose last kept character would be a hyphen is cut one shorter instead of refused.
- The Invalid key / Name required chip's tooltip is the server's own sentence.
- Every Mantine modal carries `nokey`.
- A ticket panel that cannot be redrawn is logged by its caller (`[tickets] Settings saved, but the deployed panel could not be refreshed:` / `Ticket config saved, but the deployed panel could not be refreshed:`) instead of `Failed to update deployed ticket message:`.

### Checks
- **Suite:** 3,121 pass, 1 fail (`ciBranchProductDiff`, known). Baseline 3,094: +2 `WarningsPage` remount cases, +3 `FlowsListPage`, +3 `flowBuilderToolbar` (dialog freshness, load freshness, `nokey`), +1 `ticketActions` named panel case, +1 each to `ticketRoutes` and `ticketConfigModal` (redraw failure), +1 `conformance.test-d`, +1 `requestMessages`, +1 `blockFieldRules`, +2 `contractValues`, +1 `resourceMeta`, +4 `detectResourceProblems`, +2 `journeyAttachment` (net), +3 `resourceAdoption`, +1 `controlErrorProp` (`ObjectListControl` no longer exempt). The birthday flake did not show; `engineVocabulary` failed once on the first type name and passes after the rename.
- **Typechecks:** root `tsc` the same 17 (all in files this step did not touch); `typecheck:e2e` the same 4; web `tsc -b` and the SDK typecheck clean.
- **Generation:** `pnpm sdk:generate` twice, hash-identical, and identical to the committed output (`git status` lists no generated file); `pnpm sdk:check` green.
- **e2e:** `flowBuilderToolbar`, `ticketActions`, `sessionExpiry` alone, and all of `web/e2e` in the full run.
- **Sabotage**, each restored (source and generated output checked unchanged after):
  1. `mutationKey` changed to another key → "shows a save still in flight as saving after the operator leaves and comes back" failed (repeated after the `useSaveInFlight` change);
  2. `writeSavedAnswer` without its cancel → "does not let a read the remount started put the value from before the save back" failed (picker showed `#lobby`);
  3. `togglingIds` replaced by a one-id set → "keeps every switch in flight busy" failed;
  4. the owed re-read forced quiet → "still says so when a refresh a switch interrupted fails" failed;
  5. a refresh during a switch not deferred → "holds a refresh asked for during a switch" failed;
  6. global `staleTime: Infinity` with the call sites kept → all four toolbar e2e passed; with the call sites removed too → "asks again what is live each time its inventory opens" (stale `#vip-lounge`) and "reads the guild's roles and channels afresh" (1 read, not 2) failed;
  7. theme `nokey` default removed → the Deploy-dialog Backspace e2e and `sessionExpiry` both failed (a card deleted);
  8. the rule-order check disabled → the `requestMessages` and `blockFieldRules` order cases failed;
  9. `slugifyResourceName` trimming before slicing → the trailing-hyphen and parity cases failed;
  10. each caller's `.catch` removed → the route and modal redraw-failure cases failed;
  11. a `{ kind: 'choice' }` with no index added to `RESUME_REPRESENTATIVES` → `conformance.test-d.ts` failed with `ExpectNever<{ readonly kind "choice"; }>`;
  12. `'role'` dropped from `RESOURCE_KIND_ORDER` → `resourceMeta.test.ts` failed;
  13. `updateDeployedTicketMessage` made to skip the redraw → only the named panel case in `ticketActions` failed.
- **Review:** one pass, `generic-reviewer-domain-runtime` and `generic-reviewer-maintainability` run directly, read-only; `git status` and a marker grep after both showed nothing injected. No Critical or High.
  - **Fixed:** `useIsMutating`'s stale snapshot (`useSaveInFlight`); the object list's unreported minimum; refreshes during a switch, the double toast, and the bookkeeping outside `try`; the remaining stale comments; the empty-key order case; the redundant `onMutate` cancels and the double key derivation; the wrong "each writes while in flight" comment; the self-referring chip `reason`; the `''` convention comment; `writeSavedAnswer`'s unused generic; `heldReply` moved into `fakeApi.ts`; `NO_FLOW_IDS`; the 64 pins in web tests; the button assertion that passed for the wrong reason (now `data-loading`); `minEntries`' manifest comment.
  - **Recorded rather than fixed:** see Follow-ups.

### Follow-ups
- **`minEntries` has no browser consumer** (review, Low). Conformance could derive the minimum from the schema's `minItems`; then the member could leave the manifest, `nodeBody.ts`, the SDK and two blocks. A contract change, not this step's.
- **The flows list is not keyed by guild** (review, Low; unreachable while `selected` is `guilds[0]`). When a guild switcher lands, key the page body by `selected.id` as the settings forms are, or the switch refs and a pending switch's closure carry across guilds.
- **No ticket-settings remount test**: the mechanism is the Warnings one, which is tested; Ticket settings and Server Settings use it unchanged.
- **The remount test's late-read case waits 50 ms** for a read that should not land, in the shape `sessionExpiry.test.tsx`'s `settleAMoment` already uses.
- **Could be committed in parts** (review): the comment rewrites (§7), the server side (§5, §8), then the web behaviour (§1–4, §6) with this plan.
