# SDK step 9: a session that runs out mid-edit keeps the page

Follows steps 1–8 (`sdk-1-walking-skeleton.md` … `sdk-8-journeys.md`; step 8 committed as `c25791b`).

## Why this slice

Step 7 wired the SDK's `onUnauthorized` to sign the dashboard out: a 401 from any call sets the user to null, the `Gate` swaps the whole tree for the login page, and the query cache is emptied. Whatever the page held unsaved goes with it. In the Flow Builder that is every edit since the last draft autosave, because the autosave is itself the call that gets the 401. Step 7 asked Douglas which he wanted, and he chose (2026-10-04):

> The page stays as it is, with a "your session ran out, sign in again" panel over it. Signing in happens in a new tab (Discord OAuth via the existing `/api/auth/login`); once signed in, the user returns and carries on. Save works again and nothing is lost.

It also closes step 7's two follow-ups: a 401'd mutation still shows its own failure notification, and a 401 on the guild list shows "Could not load servers".

## Decisions taken

All conventional; none needed Douglas.

### 1. A lost session holds requests; it does not fail them

There were two general ways to do this:

- **(a) Let the 401 throw, as today.** Add a "session restored" event that the autosaves subscribe to and retry on, and suppress 401 notifications in one shared place.
- **(b) Hold the request at the fetch layer.** A refused request waits until the session is back and is then sent again. A request issued while the session is lost waits before it goes out at all.

**(b)** is chosen. `useResourceAutosave` decides it. On a failure it shows the error inside the resources dialog, forgets what it last sent, and **re-reads the server's list over the one on screen**. On a 401 that re-read 401s too. Under (a), both autosave hooks' failure paths would need special cases to tell a lost session from a refusal. Under (b) no failure path runs: the write waits, and then it lands.

What (b) gives:

- **Every caller, unchanged.** The Flow Builder's draft autosave keeps its serial queue: the held write is the head, and everything after it is chained behind. The resource autosave, the settings forms, the ticket actions and every query simply take longer.
- **Step 7's follow-ups close by construction.** A held Save never fails, so it never shows "Couldn't save". A held guild list never fails, so it never shows "Could not load servers". The "one shared place" Douglas asked for is the gate itself, not a check on the notification path. Dom tests pin both.
- **A Save pressed just as the session ran out completes by itself after sign-in.** Its spinner keeps going under the panel. This is new behaviour, and it is inside "Save works again and nothing is lost".

**Re-sending is safe.** On this API a 401 only comes from `requireAuth`, and from `/me`, which writes nothing. `requireAuth` runs before any handler, so a 401'd request was never executed.

### 2. The session gate: `web/src/auth/sessionGate.ts`

Replaces `sessionLoss.ts`. The session gate is a `fetch` for the SDK, plus the calls `AuthProvider` makes to tell it what is happening.

**States:**
- **`signedOut`**: before the boot `/me` has answered, after a refused one, and after Log out. A 401 passes straight through. This keeps the first load with no session going to the login page, as it does today.
- **`signedIn`**: the first 401 moves the gate to `lost` and tells the listeners, once.
- **`lost`**: a refused request joins the hold. A new request is held **before it is sent**. Nothing goes out while the panel is up, because it would only be refused, and if someone else signs in on another tab it would go out as them (§4).

**What it does:**
- **Clones the request before the first send.** The body is consumed by then, and the clone is what goes out again.
- **Calls `globalThis.fetch` when the request is made,** not when the module loads, so the test stubs (`installFakeApi`, `installDashboardApi`) still intercept.
- **Never holds `/api/auth/*`, either before or after sending.** `/me` is the probe that asks whether the session is back, and it must be able to answer 401. A 401 on logout means "already out". The rule is path-based and documented.
- **Tags each send with a generation, and bumps it on restore.** A 401 for a request sent before a restore (a slow request still carrying the old cookie) is retried at once instead of putting the panel back up.
- **Ends a held request when its abort signal fires,** so a query TanStack cancels does not wait for a sign-in.
- **Repeats if a re-send gets a 401 again.** The request goes back into the hold. Nothing loops without the user acting, because the hold only opens when a recheck succeeds.

**The calls `AuthProvider` makes:**
- `sessionBegan()`: on a successful boot `/me`, **before** `setUser`, so the guild list request is already guarded.
- `sessionRestored()`: the same person is back. The hold opens and the generation moves on.
- `sessionEnded()`: Log out. Anything still held is dropped unanswered.
- `onSessionLost(listener)`: as before.

**Pre-flight scope:** every path except `/api/auth/*`. This is simpler than mirroring `requireAuth`'s list, and `/api/bot` and `/api/health` are only read at mount.

### 3. SDK seam

`SetupClientOptions.onUnauthorized` is replaced by `fetch`, the function every request goes through. hey-api's `Config.fetch` already exists, and its `beforeRequest` resolves `options.fetch ?? _config.fetch ?? globalThis.fetch`. The response interceptor that called `onUnauthorized` goes. The SDK keeps no session policy; the dashboard passes its gate. Only `main.tsx` and `setupDom.ts` call `setupClient`. The SDK test "reports a 401 to onUnauthorized" becomes "sends every request through the fetch it was given".

### 4. `AuthContext`

**Session state** is a discriminated union: `checking | signedOut | signedIn | expired | replaced`.

**Context value:** `user`, `loading`, `sessionExpired`, `logout`, `recheckSession`. `refresh` goes: nothing outside the provider called it, and the boot read and the panel's recheck are now different operations.

**On a lost session**, `signedIn` becomes `expired` with the user kept. The `Gate` keeps rendering the dashboard and adds the panel over it. **The query cache is no longer emptied on a 401.** It is still emptied on Log out.

**`recheckSession()`** asks `/me`. Only one check runs at a time. The outcomes:
- **Same user id:** `sessionRestored()`, then `signedIn`. The held requests go out.
- **401:** `stillSignedOut`.
- **Any other failure:** `unreachable`.
- **Different user id:** `replaced`. The edits on this page belong to the previous person, so this is a sign-out:
  - **the hold is not released;**
  - the `Gate` renders the loader, which unmounts the dashboard tree. Its `beforeunload` listener goes, because React runs every passive unmount before any passive mount in a commit. The tree's unmount flushes are held before they are sent;
  - an `AuthProvider` effect then calls `startOver()` (`web/src/auth/startOver.ts`, `window.location.replace('/')`). A fresh page has an empty cache and boots as the new person on their dashboard.

**Why reload rather than swap in place:** an in-place swap would race the old tree's unmount flushes against the new person's live cookie. The draft hook's actual SDK call is a microtask behind `queue.then`, and whether the gate had reopened first would depend on when React flushes effects. With the hold kept closed, nothing of the old page's can go out as the new person. The navigation is a one-function module so a dom test can `vi.mock` it, because jsdom's `location.replace` cannot be spied on.

### 5. The panel: `web/src/auth/SessionExpiredPanel.tsx`

**A Mantine `Modal`:**
- `withCloseButton={false}`, `closeOnClickOutside={false}`, `closeOnEscape={false}`;
- `zIndex` at Mantine's `max`, above the builder's own dialogs and the notifications.

**It blocks the page without touching it:**
- **Focus moves into the panel** (`data-autofocus` on its body, `tabIndex={-1}`, so a stray Space or Enter clicks nothing). A controlled input keeps its text when it loses focus, and Mantine's `returnFocus` puts focus back on it when the panel closes. Nothing underneath is disabled.
- **`className="nokey"`.** React Flow ignores keys whose target is inside `.nokey` (`isInputDOMNode` in `@xyflow/system`). Without it, the inspector's node is still selected when focus moves into the panel, and the first Backspace the operator types deletes it.

**Signing in:**
- **"Sign in again"** is a link to `/api/auth/login` with `target="_blank"` and `rel="noopener"`. The OAuth callback already redirects to `/`, so the new tab lands on the dashboard and needs no server change. The copy says to come back to this tab.
- **Checking is automatic on window `focus`,** which fires on coming back to this tab or window, and is silent when it fails. The **"I've signed in"** button checks too, and says why when it fails. The button takes no `loading` prop, because `loading` sets `disabled` and would drop focus out of the trap.

### 6. Copy

New user-facing copy, in the persona:

| Where | Text |
|---|---|
| Panel title | Your session safeworded out |
| Panel body | Everything on this page is right where you left it. Sign in again in a new tab, then come back here and carry on — nothing gets saved until you do. |
| Sign-in link | Sign in again |
| Recheck button | I've signed in |
| Recheck: still no session | Nice try. Still no session — finish signing in on the other tab first. |
| Recheck: could not ask | Couldn't reach the server to check. Give it another go. |

## Behaviour changes (expected)

- **A 401 mid-session** no longer signs the dashboard out. The page stays, the panel covers it, the request waits, and nothing new is sent until the same person is signed in again. Then everything held goes out, and the page carries on.
- **A held Save completes by itself after sign-in.** A held read does too.
- **No "Couldn't save … Not authenticated" and no "Could not load servers"** for a lost session.
- **The query cache survives a lost session.** It is still emptied on Log out.
- **Signing in as somebody else** reloads the dashboard at `/` as them. The previous person's unsaved edits are not sent.
- **Unchanged:** a 401 on the very first `/me` still shows the login page. The login page is unchanged.
- **New copy:** the six strings in §6.

## Checks (planned)

**Baselines:**
- Suite against the baseline: 3,060 pass, 1 known failure.
- Typechecks: root `tsc` the same 17; `typecheck:e2e` the same 4; web `tsc -b` and the SDK typecheck clean.
- `pnpm sdk:generate` twice, byte-identical. No route changes, so the generated files should not move.

**Unit tests, `web/src/auth/__tests__/sessionGate.test.ts`** (node). The gate:
- passes a 401 through when signed out;
- holds a 401 when signed in and re-sends the same body after a restore;
- tells the listeners once for two simultaneous 401s;
- holds a request issued while lost before it is sent;
- never holds `/api/auth/*`;
- retries a late 401 from before a restore without reopening the hold;
- ends a held request when it is aborted;
- drops held requests on `sessionEnded`.

**Dom tests, `web/src/auth/__tests__/sessionExpiry.test.tsx`**, the whole app through the fake API:
- a page read that 401s shows the panel over the page:
  - no "Could not load servers";
  - the guild list is still cached;
  - the read is not repeated while the panel is up;
  - "I've signed in" with `/me` answering re-sends it and the page fills in;
- a Save that 401s:
  - no "Couldn't save";
  - the picked value is still in the form;
  - after the recheck the PUT carries it and "Saved" shows;
- a recheck that is still 401 shows its sentence and the panel stays;
- coming back to the window rechecks by itself;
- a different user calls `startOver` and nothing held goes out;
- a boot `/me` 401 shows the login page.

**Other tests:**
- `signOut.test.tsx` goes: its Log out case and its journey case (which now calls `sessionBegan()` first) move into `sessionExpiry.test.tsx`, and its 401 case is replaced by the cases above.
- `setupDom` resets the gate after each test with `sessionEnded()`.
- **e2e, `web/e2e/sessionExpiry.test.tsx`:**
  1. open the builder and expire the session;
  2. add a node; the draft autosave 401s;
  3. the panel shows;
  4. Backspace inside the panel deletes nothing;
  5. the canvas still has 3 cards and no draft is stored;
  6. restore the session and click "I've signed in";
  7. the stored draft has 3 nodes;
  8. Save, and the flow has 3 nodes.

  `buildDashboardApp` takes an optional session switch so that `/api/auth/me` and the guarded `/api/*` paths answer 401 while it is off. `installDashboardApi` returns `expireSession()` and `restoreSession()`.

**Sabotage**, each restored:
1. `queryClient.clear()` put back on the lost path → the dom test asserting the guild list survives fails;
2. the gate passes the 401 through instead of holding it → the e2e finds no draft stored;
3. `nokey` dropped → the e2e Backspace check deletes a node;
4. the pre-flight hold removed → the different-user dom test sees a write go out;
5. the generation check removed → the late-401 unit test reopens the hold.

## As built

As planned, with the changes below. Where they contradict the sections above, this section is the record.

### Session gate and SDK
- **`web/src/auth/sessionGate.ts`** (`sessionLoss.ts` is deleted). It exports `sessionGatedFetch`, `sessionBegan`, `sessionRestored`, `sessionEnded` and `onSessionLost`.
- **Every hold waits on the first request's signal,** and is passed it through each retry. A clone's signal is not used, because Node's `Request.clone()` holds the clone's controller only through a `WeakRef`, so an abort can stop reaching it once that is collected.
  - What prompted this: the abort unit test hung once, during a sabotage run, while another test file ran beside it.
  - That cause is reasoned from undici's `clone()`, not proven: the hang did not happen again, either before or after the fix.
- **`sessionBegan()` only acts while signed out** (review), so a late answer cannot begin a session that is already signed in or lost.
- **`setupClient`'s `onUnauthorized` is replaced by `fetch`** (`packages/web-sdk/src/setupClient.ts`). Its response interceptor is gone, and its JSDoc states the contract only (review).

### Auth context and panel
- **`AuthContext`** as in §4. Changes from the plan:
  - the boot `/me` effect ignores an answer that arrives after its cleanup has run. Under StrictMode the effect runs twice, and a late answer would otherwise call `sessionBegan` or show "signed out" (review);
  - `recheckSession` answers `'replaced'`, not `'restored'`, if it is asked again after somebody else signed in (review).
- **`App.tsx`'s `Gate` is renamed `AuthGate`,** so "gate" in prose means only the session gate (review). The panel is mounted inside it, beside `<Routes>`, and opened by `sessionExpired`.
- **`SessionExpiredPanel.tsx` and `startOver.ts`** as in §4–5. The copy is exactly as in §6.

### Resource autosave: writes queue (review)
`useResourceAutosave` now sends one write at a time, each behind the last, as the draft autosave already did.

Each write is the whole list. When a lost session is restored, the session gate releases two held writes together, and on separate connections they can be stored out of order. The older list would then win on the server while the newer one shows on screen. This could also happen without a lost session, but only from two writes on separate connections answered out of order.

The queue lives in the hook, which owns the ordering, and not in the session gate. A new dom test pins it.

### Tests and harness
- **`web/src/auth/__tests__/sessionGate.test.ts`:** 8 unit cases.
- **`web/src/auth/__tests__/sessionExpiry.test.tsx`:** 9 dom cases. `signOut.test.tsx` is deleted and its Log out and journey cases moved here.
  - The different-user case also fires a write after the other person has signed in but before the recheck. That is the write the pre-flight hold exists for (review: the held PUT alone could not catch the hold being removed).
- **`web/src/flows/__tests__/useResourceAutosave.test.tsx`:** 1 dom case, a second write waiting on the first.
- **`web/e2e/sessionExpiry.test.tsx`:** 1 case, as planned. It adds a renamed flow and a check that focus returns to the name box after the panel closes. The added card is selected from the keyboard (Enter), because a pointer press runs d3-drag, which jsdom's events cannot carry.
- **Harness:**
  - `buildDashboardApp` takes an optional `sessionLive`;
  - `installDashboardApi` returns `expireSession`/`restoreSession`;
  - `setupDom` resets the gate after each test with `sessionEnded()`;
  - the `fakeApi.ts` comment is updated.

### Behaviour changes, final
As listed under *Behaviour changes* above, plus:
- **The resource autosave sends its writes one at a time.** A second edit's save waits for the first to answer, instead of racing it.

### Checks
- **Suite:** 3,077 pass, 1 known failure (`ciBranchProductDiff`).
  - In the final full run, `levelUpDispatch`, `memberJoinDispatch` and `reactionAddDispatch` timed out their hooks under load, the known block-discovery flake. Run alone, all 41 pass.
  - **Against the 3,060 baseline:** the date-dependent birthday test passed this time (+1); −3 `signOut`; +9 `sessionExpiry` (dom); +8 `sessionGate`; +1 `useResourceAutosave`; +1 e2e. The `setupClient` test was replaced one for one.
- **Typechecks:** root `tsc` the same 17; `typecheck:e2e` the same 4; web `tsc -b` and the SDK typecheck clean.
- **Generation:** `pnpm sdk:generate` twice gives hash-identical output across all 19 generated files. No routes changed, and `git diff` on them is line-ending noise only.
- **e2e:** all 14 files pass, the new one included.
- **Sabotage**, each restored:
  1. `queryClient.clear()` put back in the lost-session listener → the dom Save case failed: the form re-loaded, and its pick was gone;
  2. the session gate passed the 401 through → the e2e failed at the panel, which never showed. A sharper variant held the request but returned the 401 after sign-in instead of sending again: the e2e failed with `expected []` on the stored drafts, and three dom cases failed;
  3. `nokey` swapped for another class → the e2e failed on Backspace inside the panel: 2 cards, not 3;
  4. the pre-flight hold removed → the unit test "sends nothing new while the session is lost" failed. After review, the different-user dom case failed as well (2 PUTs, not 1);
  5. the generation check removed → the late-401 unit test timed out on a second, false loss;
  6. a different user treated as the same person → the different-user dom case failed (`startOver` was not called);
  7. `sessionRestored()` called for a different user → the different-user dom case failed (the held PUT went out: 2, not 1);
  8. the resource autosave's queue removed → the new ordering test failed (2 PUTs while the first was unanswered).
- **Not verified by a test:**
  - the panel against a real browser's portal and focus behaviour; jsdom with Mantine's `env="test"` renders the modal inline;
  - that `window` `focus` fires when coming back from the sign-in tab in every browser (the dom case dispatches the event);
  - the StrictMode late-answer guard.
- **Review:** one pass, `generic-reviewer-domain-runtime` and `generic-reviewer-maintainability` run directly. No Critical or High.
  - **Fixed:**
    - the resource autosave's unordered release (Medium);
    - "gate" meaning two things (Medium);
    - the plan's file names (Medium);
    - the boot `/me` late answer, and `sessionBegan` overwriting state;
    - a different-user test that could not catch sabotage 4;
    - `recheckSession`'s answer after `replaced`;
    - the SDK option's JSDoc;
    - the stale `fakeApi.ts` comment;
    - "dropped" wording, which is in fact "left pending";
    - test helpers (`tick`, `settleAMoment`, `User`, `StoredGraph`, `requestsTo`);
    - the journey test's stated reason.
  - **Recorded rather than fixed:** see Follow-ups.

### Follow-ups
- **A cookie that changes owner without a 401 first** (domain review, Medium). This predates this step.
  - **Scenario:** A's session lapses quietly while A's page sits idle, then B signs in in another tab. A's page's next request carries B's cookie and succeeds as B. For example, the draft autosave would store A's canvas as B's draft.
  - **What this step covers:** the session gate prevents this only once a 401 has marked the session lost.
  - **A fix:**
    - `sessionBegan(userId)`, and the session gate stamps each request with the expected user id;
    - `requireAuth` answers 401 when the stamp and the session disagree;
    - that 401 takes the existing lost path, and the panel's recheck finds B and reloads.
  - It is a server change and outside this step.
- **`sessionEnded()` leaves held requests pending forever,** rather than rejecting them with an `AbortError` (domain review, Low). The UI cannot reach it: Log out sits under the panel. Rejecting would also land "Couldn't save" notifications from the previous dom test after `setupDom` has cleared them.
- **Other dialogs over the canvas** (`LeaveFlowDialog`, `ResourcesDialog`, the journey dialogs) do not carry `nokey`. A Backspace typed while one has focus on a button would reach React Flow's delete. This predates this step and was not checked live.
