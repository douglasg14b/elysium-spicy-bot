# Button Click listens to a message's button (step 3)

> **Status**: Built 2026-10-25, all four slices, uncommitted; not run live. Planned and reviewed the same day, and Douglas answered the open questions (see "Douglas's answers", which wins over anything above it). Picks marked **Douglas?** that his answers don't mention are built as written. What the build decided beyond the plan is under "As built", at the end.
> **Owner**: Douglas
> **Design**: [message-resource-and-embed-editor.md](message-resource-and-embed-editor.md), step 3. Mockup: [message-editor.mockup.html](../../nimbalyst-local/mockups/message-editor.mockup.html), section 4 (the trigger's picker).
> **Follows**: [message-resource-step-2.md](message-resource-step-2.md), built and committed in `962183d`, and its "Step 3 picks up" list. Neither its live run nor step 1's has happened yet.
> **Next**: the bridge-removal deploy (see "After this step").

## The gap

A journey can post a message with buttons, but pressing one only answers "Nothing's hooked up to this yet" (`flows/logic/messageButtonPress.ts:24-29`).

A Button Click trigger can't listen to that button. It still owns a button of its own, `{ channelId, label, style }` (`triggerButtonClick/index.ts:22-38`). Deploy posts that button as `flow:<flowId>:<nodeId>`, under the flow's name in bold (`deployFlowButtons.ts:183-187`, `customId.ts:10`).

So there are two ways to put a button in a channel. The design says there must be one.

## What step 3 does

- **Button Click points at `{ messageKey, buttonKey }`** in its own journey, instead of owning a channel, a label and a style.
- **The trigger's panel picks a message, then a button.** It also offers "+ New button on this message" and "+ New message in #channel", both of which write into the journey's Resources.
- **A press routes** from the message id to its binding, then its journey, then that journey's flows, then the one live trigger naming the button, then its gate, then the run.
- **One flow per button.** A second flow can't go live on a button another flow holds, and the refusal names that flow.
- **Listeners are shown.**
  - The message window shows "↳ <flow name>" under each button.
  - Install notes the buttons nobody listens to.
  - A button somebody listens to has its key locked.
- **Today's triggers and their posted messages are converted** by a data migration. Each posted message is kept and adopted, so it keeps its place in the channel. Its buttons keep working through a `flow:` bridge until the operator repairs it.
- **Deploy is retired**: `/flow-deploy`, the deploy and undeploy routes, the Deploy button, "take buttons down", and every reader of `flow_button_messages`.

## Where the design is wrong against the code

1. **"Saving is refused" doesn't fit how saves work.** Every graph save is stored, incomplete or not:
   - a live flow's incomplete graph becomes the saver's draft;
   - an off flow's is stored as unfinished (`decidePut`, `flowRoutes.ts:446-528`; `flowReadiness.ts:14-27`: "refusing it is how operators lost work").

   The one check that already spans flows, the loop check, refuses at **go-live** (`flowRoutes.ts:504-524`). One flow per button goes there too (pick 3).
2. **Readiness is given only a set of keys** (`flowReadinessIssues(graph, declaredKeys: ReadonlySet<string>)`, `flowReadiness.ts:67`). To say "this message has no button `verify`", it needs the declarations themselves. It has nine callers, plus `flowJourneyIndex.ts` for the flows list.
3. **The builder can't write a shared journey's resources.** Its save target is always `{ kind: 'flow' }` (`FlowBuilderPage.tsx:1061-1064`), and `saveFlowResources` answers 409 to every write to a journey that another flow also holds (`journeyRoutes.ts:837-889`). The design's inline "+ New button" would be refused in every grouped flow (pick 7).
4. **Whether a message-button press wakes parked waits isn't a free choice.**
   - Wait for Event's `buttonClick` kind ("a flow button click", `actionWaitForEvent/index.ts:20,78`) is woken only by a `flow:` press (`flowTriggerDispatch.ts:63-69`).
   - Once `flow:` goes, nothing else could wake it.

   The step-2 plan left this open, but the code forces it (pick 9).
5. **"A message can't be adopted" is about install.** These messages were posted by the bot, so the migration can record them, and the record says `created`, not `adopted`: the bot made them, so uninstall deletes them.
6. **The migration has no Discord, so it can't bind channels.**
   - **No declaration to work from.** A converted message's channel is often just a snowflake in the old trigger.
   - **Adoption needs Discord.** An `adopted` binding needs the channel's live name, which drift compares against (`resourceDrift.ts:341-347`). So install adopts the channel.
   - **Drift waits for the channel.** It skips a message whose channel isn't bound (`journeyDriftPlan.ts:340`).

   So each converted journey goes **Install → Drift → Repair**, in that order (see "The changeover").

## Decisions

From the design (Douglas, 2026-10-23):

- One flow per button; the refusal names the flow that has it.
- One way to put a button in a channel; Deploy is converted, not kept beside it.
- A trigger can point at an existing button or make a new one; either way the button is defined in the message resource.
- A press nobody listens to answers "Nothing's hooked up to this yet", and install notes it.

My picks:

1. **A trigger listens only to a message its own journey declares.**
   - The config holds bare keys, like every resource sidecar (`resourceTargets.ts:26-39`). A key means "in my journey", resolved through `resolveFlowJourney`.
   - A flow moved to another journey loses its button, and readiness says so. That is the same blast radius as a channel sidecar (memory note *journey-merge-blast-radius*).
2. **The config is one object-valued key**, `button: { messageKey, buttonKey }`, drawn by a new control, `messageButton`.
   - The precedent is `eligibility`: one control over one object key.
   - It is **not** a `ResourcePickerControl`. No snowflake is written into the node and install writes nothing back: the press finds the message through its binding, and a second copy of the message id in the graph would be one more thing to drift.
   - `channelId`, `label` and `style` leave the schema; `eligibility` stays.
   - Both keys use the resource key pattern (`journeyBody.ts:72`).
3. **One flow per button is checked at go-live.** **Douglas?**
   - **Where it runs:** in `decidePut`, beside the loop check, when the write leaves the flow on and either switches it on or carries a graph (`goesLive`, `flowRoutes.ts:537`).
   - **What it compares against:** the other live flows of the same journey.
   - **The refusal:** a 400 with `issues: []`, as the loop check gives, saying `"Welcome" already listens to "Verify" on "Rules panel". One flow per button — point this trigger at another.`
   - **Live vs off flows:** a live flow's save is refused. An off flow's save is stored, and switching it on is refused.
   - **Two triggers in one flow on the same button** are a readiness issue on both nodes: "Two triggers in this flow listen to "Verify". One press starts one run." The graph is stored, marked, and can't go live.
   - **The picker greys a taken button** with "↳ Welcome" and won't select it, so an author rarely reaches the refusal.
   - **The alternative:** make a claim across flows a readiness issue, judged against every flow, on or off. That needs a tiebreak, or two off flows both get stuck, and one flow's edit can then mark another flow "Needs fixes". I don't recommend it.
4. **Routing reads the database on each press, with no in-memory index.**
   - **Per press:** one binding read by `(guildId, discordId, kind 'message')`, plus `flowsInJourney` (`applyResourcesToFlows.ts:127-141`: the links plus the pre-link fallback, then the guild's flows, filtered). Three queries.
   - **Why the index precedent doesn't apply:** `messageTriggerIndex.ts` exists because every guild message passes through it. A press is one deliberate act, and today's `flow:` press already reads its flow on every press (`flowTriggerDispatch.ts:33`).
   - **The cost an index would add:** it would need dropping on link and binding writes, and provisioning announces neither.
5. **What a press answers.** The wording is for Douglas to tune.

   | Case | Answer |
   |---|---|
   | One live trigger names the button | Its gate, the wake, then the run: today's tail, unchanged (`flowTriggerDispatch.ts:44-134`) |
   | Only switched-off flows name it | "This flow is currently disabled." (today's sentence, `skipped`) |
   | Nothing names it, or the binding is gone | `NOTHING_HOOKED_UP` |
   | Two or more live triggers name it (only a race can do this) | Neither runs. "Two flows are fighting over this button, so neither gets it. A mod has to sort them out." Logged as an error naming both flows |
   | Not in a server | Today's sentence |
6. **Button keys are frozen in the browser; the server doesn't refuse.** **Douglas?**
   - **The key field:** in the message window, a listened button's key is `readOnly`, with a lock icon. This copies step 2's channel lock: `readOnly`, not `disabled`.
   - **Remove** on a listened button asks first: "Welcome listens to this button. Remove it anyway? That trigger will need another button."
   - **The message's own key** stops following its name, as an installed key does: `installedKeys` becomes installed ∪ listened in `resourceKeyFollowsName`.
   - **If an edit gets through anyway,** the trigger shows a readiness issue.
   - **Why not refuse on the server:** it would cost an async read of the journey's flows on every resource autosave, and a refusal there reverts the whole list (`useResourceAutosave.ts:233-252`).
7. **The builder saves resources through the journey once the flow has one.** **Douglas?**
   - **The change:** when `attachment?.journeyKey` is known, `resourcesTarget` becomes `{ kind: 'journey', journeyKey }`. With no journey yet it stays `{ kind: 'flow' }`, whose first save creates the journey.
   - **What it fixes:** correction 3. It also matches memory note *journeys-are-not-a-page*: "editing from any member edits the journey's".
   - **The alternative:** in a grouped flow, inline creation says "Add it from the group's Resources", and nothing else changes.
8. **"+ New message in #channel" offers the journey's declared text channels first, then the server's text channels.** **Douglas?**
   - Picking a server channel also declares it, adopted (`adoptDiscordId`, named after the channel).
   - This keeps what the old trigger could do: put a button in any channel in one step.
   - Offering only declared channels would be less UI.
9. **A message-button press wakes parked button-click waits**, in today's order (correction 4):
   1. Work out the matched trigger's refusal first.
   2. Wake the waits only if the press isn't refused.
   3. Only then answer off, nothing listening, or binding gone.

   The option label becomes "a button click". When nothing listens there is no gate to ask, so the press wakes; that is today's behaviour for a press on a deleted flow (`:36-62`).
10. **Install notes only the buttons nobody listens to**, by label: `Nobody listens to "Verify" yet — a press answers "Nothing's hooked up to this yet".`
    - It replaces `MESSAGE_BUTTONS_UNHEARD_NOTE` (`installPlan.ts:203-207`).
    - Install finds the listeners through a hook that provisioning defines and flows registers (pick 11).
11. **The listener hook is `provisioning/buttonListeners.ts`**, shaped like `ticketTypeProvider.ts`.
    - **Its pieces:**
      - `registerButtonListenerReader(reader)`, where `reader(guildId, journeyKey)` returns `Promise<ButtonListener[]>`;
      - `ButtonListener = { messageKey, buttonKey, flowId, flowName, nodeId, enabled }`;
      - `requireButtonListenerReader()`, which throws when nothing is registered.
    - **Who uses it:**
      - `previewInstall` asks it, but only when a declared message has buttons.
      - Flows registers `journeyButtonListeners` in `initFlows`.
      - The router and the new route call that function directly.
    - **The guard:** `provisioningWiring.test.ts` holds both boot roots (`bot.ts`, `web/e2e/support/bootBot.ts`) to registering it.
12. **The browser gets listeners from one new read route**, `GET /{guildId}/journeys/{journeyKey}/button-listeners` (`getJourneyButtonListeners`), which answers `{ listeners: ButtonListener[] }`.
    - It reads only the database, so it counts against the general rate budget.
    - The builder overlays its own canvas: it drops its own flow's entries from the answer and adds the triggers on screen, so a pick shows at once.
    - The flows page's group header uses the answer as it comes.
13. **Posted messages are converted by adopting them, with a `flow:` bridge in between.** **Douglas?** The alternatives are under "The changeover".
14. **`flow_button_messages` is dropped in the bridge-removal deploy, not this one.** **Douglas?**
    - This step deletes its repo and every reader. The table and its `Database` entry stay.
    - **Why:** a rollback to step 2's code needs the table. Its rows are also the only record of older stray messages, until Douglas deletes those by hand.
    - **The alternative:** drop it in this migration, and log every row that wasn't adopted.

## Plan review (2026-10-25): what blocks building

A coverage review found six blocking problems. **Building waits until Douglas has answered the questions at the end of this section.** Where a finding changes a pick above, the finding wins.

1. **Shared channels are likely the common case, and dragging the flows into one group doesn't fix it.**
   - **Why it's common:** each converted flow gets its own journey, so two button flows that deployed into one `#rules` give two journeys that both adopt `#rules`. The second install is blocked (`installPlan.ts:629-637`). Its message is never repaired, and it dies when the bridge goes.
   - **Why dragging doesn't fix it:** merge refuses colliding keys, and bindings can't move (`journeyMergePlan.ts:16-19`). The merge also empties the source's declarations but leaves the message binding under the old key, so the destination's install reposts.
   - **Options:** the migration puts every converted flow that deployed into one channel into one journey per channel (unless one already has a real journey), or accept the loss.
   - **Count the cases** on a dump first (finding 5).
2. **One membership rule.** "Which flows are in journey J" is computed three different ways today:
   - `selectFlowIdsForJourney`, whose fallback admits a flow whose id is J even when it's linked elsewhere (`applyResourcesToFlows.ts:164`);
   - `resolveFlowJourney`, which reads the link first;
   - `otherFlowsOnJourney`, which reads links only (`sharedJourneyGuard.ts:51`).

   Migration-created journeys are keyed by flow id, so these disagree after a regroup. **Fix:**
   - The router, `buttonClaims`, the listener route and the install note all use one function: a flow is in J only when `resolveFlowJourney` says J.
   - Test: a flow grouped away from its flow-id journey gets `NOTHING_HOOKED_UP` on its old message.
3. **Two live listeners can happen without a race.** The group route (`journeyRoutes.ts:1163-1324`) attaches a live flow to another journey with no claim check, so one drag can match a button a live flow there already holds. **Fix:**
   - Run `buttonClaimConflict` in the group preview (as a warning) and the group route (as a refusal naming the flow).
   - Douglas picks what two listeners do: neither runs, or the earlier claim wins.
4. **Resource saves have no stale-tab or version guard.**
   - **The risk:** both resource PUTs replace the whole list with no version check (`journeyRoutes.ts:809-923`). A builder tab left open across the deploy would delete the migrated channel and message on its next Resources keystroke.
   - **Fix:** before this deploy, give both PUTs an optimistic guard (the journey's `updatedAt` or a list hash; 409 "reload"). At minimum, refuse a save that drops a declaration with a live binding.
   - **Pick 7 reverses a recorded safety decision.** `resourceSaveTarget.ts:23-33` says the 409 on shared journeys "protects flows an operator cannot see". That makes pick 7 Douglas's call.
   - **If he takes pick 7,** spell out the mid-session switch from the flow target to the journey target (`resourceTargetIdentity`).
5. **No backup, no dry run, no rollback.**
   - **Add live-run step 0:** `pg_dump` production, restore it into a throwaway `postgres:16`, run the migration there and read its log (hazards, strays, empty destinations) before deploying.
   - **The rollback is restoring the dump.** Rolling the image back without `down` breaks every `flow:` press, because step 2's executor can't parse `button` nodes.
   - **`down` must delete the message bindings it created**, which it can identify by the message ids in `flow_button_messages`. After a `down`, never Install or Repair a converted journey on step 2's code.
6. **Slices A and B can't be green as drawn.** A's schema change breaks `planButtonDeployment.ts:74-98` and `onboardingFlow.ts` (root `tsc`), plus about 20 tests that the plan only retargets in C. **Fix:** in A, delete `planButtonDeployment` and `deployFlowButtons`, rewrite the seed, and retarget those tests. Every slice stays green.

The review also found these, which change the build but not Douglas's answers:

7. **An off listener's gate still applies.** When only a switched-off flow listens, ask its gate before waking, as today's `refusalFor` does (`flowTriggerDispatch.ts:44-69`). Test in B: a gated, switched-off listener refuses the presser and doesn't wake their wait.
8. **A message that was never posted.** `button` isn't a resource picker, so `uninstalledResourceKeys` (`flowReadiness.ts:144`) doesn't see it, and a flow can go live listening to a message that was never posted. **Douglas** chooses: allowed (nobody can press it), or refused with the install-first sentence.
9. **Match posted rows by `nodeIds`, not by the node's current channel.** Log every `flow_button_messages` row the migration doesn't adopt, with the reason.
10. **Warn when a draft node's old keys differ from the live node's.** Otherwise the draft's edit is discarded silently.
11. **Migrated journeys must pass the wire rules too**, not just `validateJourneyDeclaration`:
    - keys match `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64 characters, and never empty (an emoji-only flow name slugs to nothing, so give a fallback);
    - `defaultName` ≤ 100 characters, normalised for `textChannel`;
    - at most 100 resources per journey.

    Freeze copies of these rules in the migration. The test runs each migrated journey through the PUT request schema.
12. **Disconnects get confirmations.**
    - The repair preview names the listeners its edit would disconnect, a cheap server-side check since repair is rare.
    - Removing a listened *message*, or its channel, asks first, as removing a button does.
    - Decide whether the router checks that the button is still declared.
13. **"+ New message" greys out channels held by another journey or the ticket feature**, using the ownership `resourceAdoption.ts` already computes.
14. **A deleted destination channel.** Its adopt is blocked, which blocks the whole install. The migration logs a destination it can't confirm, and the live run deletes such dead declarations first.
15. **Tests that need the listener reader.** `requireButtonListenerReader` throws when unregistered, so B retargets the provisioning tests that call `previewInstall` with buttoned messages.
16. **A deleted converted flow** leaves a journey with no flow, a live message and an adopted channel, which nothing in the UI can uninstall. Note it; optionally, the delete warns when the flow alone holds installed resources.
17. **Presses don't take the journey lock, on purpose.** During a repost, a press on the new message can briefly get `NOTHING_HOOKED_UP`.
18. **Measure "no bridge press for a week"** over a week with no redeploy, because each redeploy wipes the container's logs. Or persist a counter.
19. **Never-deployed Button Click triggers.** **Douglas** chooses: convert them (their journey gains a channel and a message, which a later install posts publicly), or leave the trigger empty.
20. **Repair rewrites the bold title** of a flow renamed since its last deploy, so "same content" isn't always true.
21. **The null digest is fine.** `checkMessage` compares `row.messageDigest !== messageDigest(...)` (`journeyDriftPlan.ts:346`), so null always reads as drifted. Install's `reuse` never writes a digest over it (`applyInstallPlan.ts:102-106,503-507`), so no sentinel is needed.

**From the repo-grounding review** (also 2026-10-25). These are confirmed and build as written:
- drift skips a message whose channel is unbound (`journeyDriftPlan.ts:340`);
- install `reuse` works under a same-install `adopt` parent (`installPlan.ts:801,810-819`);
- `registerCommandsWithDiscord` PUTs the whole list (`registerCommands.ts:11`);
- `useResourceAutosave` saves while the dialog is closed (`ResourcesDialog.tsx:160`);
- the wake order and the go-live check are as described.

Fixes:

22. **Name the migration `2026-10-26-…` or later.** `2026-10-25-Button_…` would sort before `2026-10-25-Resource_Binding_Message_Post` ("B" < "R"), whose columns it writes. Kysely refuses unordered migrations (`migrationOrdering.test.ts:6-21`), so the container wouldn't start.
23. **Channel rule 1 must use a key that is still declared.** Bindings outlive declarations (`journeyRoutes.ts:847-849`). A `parentKey` naming nothing makes `validateJourneyDeclaration` throw on read (`resourceDeclaration.ts:261-265`), which 500s the flows list. If the bound key isn't declared, re-declare the `textChannel` under the binding's own key; install then reuses it (`installPlan.ts:548-556`).
24. **A posted message's parent comes from `flow_button_messages.channel_id`.** Use the sidecar only when the node's `channelId` is empty or matches the sidecar's binding. Otherwise the parent is a channel the message isn't in, and install blocks with "Discord can't move a message" (`installPlan.ts:811-817`). `node_ids` is JSON, so parse it on both dialects, as `Post_Embed_Message_Shape` parses `graph`.
25. **Lengths in the migration.**
    - Truncate slugs to 64 characters, with a fallback key when a slug is empty.
    - Cap `defaultName` at 100 (a 100-character flow name plus " channel" is 108).
    - Give a label left empty by stripping `{{`/`}}` a fallback.

    These are the same as item 11.
26. **The binding row** writes `name` (NOT NULL, `resourceBindingsSchema.ts:110`), `owner_kind: 'journey'` and `owner_key`. The column is no longer called `journey_key`.
27. **The disabled sentence is `status: 'error'` today** (`flowTriggerDispatch.ts:74-76`), not `skipped`. Pick 5's table either keeps `'error'` or says it changes. Item 7 already covers which node's gate decides the wake.
28. **The seed's readiness call isn't mechanical.** `seedOnboardingFlow.ts:51` passes an empty set. It must pass the seed journey's declarations, or the template marks itself "no message".
29. **The engine vocabulary gate.** `engineVocabulary.test.ts:19-32,74-77` checks identifiers in `engine/`, `data/` and `blocks/`, and `health` isn't an allowed word. Put `startButtonRun` in `logic/`, rename its input with listed words, or add the word on purpose.
30. **`flowsInJourney` is private** (`applyResourcesToFlows.ts:125`). Item 2's single membership function replaces it.
    - `resource_bindings` has no index on `discord_id`; its only indexes are `(guild_id, owner_kind, owner_key[, resource_key])` (`2026-10-10-Owner_Keyed_Resource_Bindings.ts:124-134`).
    - So either the migration adds `(guild_id, kind, discord_id)`, or the plan drops the word "indexed".
31. **More tests break by construction.** Add these to the retarget list:
    - `parkedRunIncompleteGraph.test.ts:166` and `guildReferences.test.ts:135` (the readiness signature);
    - `messageButtonPress.test.ts:67`;
    - `installPlan.test.ts:987` (the note text);
    - `journeyDriftRoutes.test.ts:102-104` (it mocks `undeployFlowButtons`);
    - `provisioningMessage.integration.test.ts:57,169`, plus probably `journeyRoutes.test.ts` (the listener reader);
    - `web/src/flows/__tests__/publishedSummary.test.ts`;
    - `web/src/pages/__tests__/FlowsListPage.test.tsx:41` (`buttonMessages: []`, which breaks web `tsc`);
    - `installBody.test-d.ts`.

    Also fix two that would mislead after the change:
    - `flowRoutes.test.ts:509` would pass vacuously after the rename; point it at `declarations`.
    - `buildApp.test.ts:324-340` and `rateLimit.test.ts:106-138,193` use `/deploy` as their example; point them at `/install`.

    And say whether `uninstalledResourceKeys` and `pendingResourceFields` keep a `Set` derived from the declarations.
32. **"+ New message" can't offer a channel the journey already adopts or binds.** `validateJourneyDeclaration` refuses two adopts of one id (`resourceDeclaration.ts:317-328`), so map such a channel to its existing key instead.
33. **Pick 7 and flows from before the link table.** `saveFlowResources` writes the link on every save (`journeyRoutes.ts:904-913`); the journey PUT doesn't. For a flow that predates links, keep `{ kind: 'flow' }`, or write the link first.
34. **Citations to correct when building:**
    - the loop check is `flowRoutes.ts:496-520`;
    - the key pattern is `journeyBody.ts:85-103`;
    - the orphan warning is `journeyMergePlan.ts:200`;
    - there are 10 readiness callers outside tests.

**Questions for Douglas before building:**
1. Two flows that deployed buttons into the same channel: merge them into one journey per channel during the migration, or accept that they're stuck? (1)
2. May the live run start with a `pg_dump` and a dry run on a local restore, with "restore the dump" as the rollback? (5)
3. Two live flows on one button, e.g. after grouping: neither runs, the earlier claim wins, or grouping is refused? (3)
4. Pick 7, which reverses the recorded 409: accept it, and if so, is a version check on resource saves required before the deploy? (4)
5. Pick 6: keys frozen in the browser only, or also a warning at Repair naming the flows it would disconnect? (12)
6. Switching on a flow whose message isn't installed yet: allowed or refused? (8)
7. Never-deployed Button Click triggers: convert them, or leave them empty? (19)
8. The original **Douglas?** picks: 3, 8, 13 and 14, the bridge-removal end state, the "<flow name> channel" placeholder, and the press wording.

## Douglas's answers (2026-10-25)

These win over the picks and the review items above.

1. **Shared channels: merge.** The migration puts converted flows whose buttons were posted into the same channel into one journey, so neither gets stuck at Install. (Douglas picked "merge"; the mechanics below are mine.)
   - **Groups are built transitively.** Two flows are in one group when they posted into a common channel, or are already in one journey. A flow that posted into two channels can join two groups into one.
   - **Which journey the group uses:**
     - no member has a journey: create one, keyed by the oldest member's flow id (`createdForFlowId` that flow), named after it, and link every member;
     - exactly one journey among the members: link the others to it;
     - two or more different journeys: can't merge, because bindings can't move. Leave each as it is and log the hazard, naming both journeys and the channel (the old review item 1).
   - "Has a journey" means a link row, or a journey keyed by the flow's id (the fallback).
   - Each flow still gets its own message resource per channel, so one journey can hold two messages in one channel. The channel is declared once.
2. **No backup or dry run.** Live-run step 0 is dropped. The way back is fixing forward; `down` is still written and tested, but it isn't the rollback plan. The migration's log is the record, so it must name everything it did and everything it skipped.
3. **Two live flows on one button: refuse the drag.** The group route refuses, naming the flow that already listens, and the group preview warns first. "Neither runs" stays as the press's answer to a race, which is now the only way to get there.
4. **The builder saves through the journey (pick 7), with a version check.** Both resource PUTs carry the version the browser last loaded and answer 409 "reload" when it has moved on. This is built in slice A, before anything writes to a shared journey from the builder. A flow from before the link table keeps `{ kind: 'flow' }` until its link exists (review item 33).
5. **Keys: both.** The editor locks a listened key (pick 6), and the repair preview names the flows whose button an edit would disconnect (review item 12).
6. **A flow whose message isn't installed may go live.** No refusal; nobody can press a message that isn't posted.
7. **Never-posted triggers are left empty.** A Button Click node with no `flow_button_messages` row naming it (by `nodeIds`) loses its old keys and gets no `button`; the migration logs it, and readiness says "Fill this in". Its channel and message aren't declared. This also covers buttons deployed before the table existed (2026-09-20). **Correction (review H1):** the bridge can't keep those working — the node has no button left to run from — so a press on one answers "This button's been retired — ask a mod to repost it." straight away (`RETIRED_BUTTON_MESSAGE`), and logs the flow, node, message and channel.
8. **The wording is fine as drafted**: the disabled sentence, the fighting sentence, and "<flow name> channel".
9. **Keep `flow_button_messages` until the bridge-removal deploy (pick 14).** That deploy replaces the `flow:` handler with a permanent one-line answer: "This button's been retired — ask a mod to repost it." It doesn't remove it.

## The model

### The trigger (`blocks/triggerButtonClick/index.ts`)

```
buttonClickConfigSchema = z.object({
  button: z.object({ messageKey: resourceKey, buttonKey: resourceKey }),
  eligibility: eligibilityConfigSchema,
})
```

- **Fields:**
  - `{ key: 'button', label: 'Button', control: 'messageButton', description: 'Which button on which of this journey's messages starts the run.' }`;
  - "Who can press it", unchanged.
- **Card:** `[{ key: 'button', emptyText: 'no button picked', stopIfEmpty: true }, eligibility as today]`.
  - A `messageButton` value renders as "Rules panel · Verify", read from `node.data.declaredResources` (`FlowBuilderPage.tsx:1727`).
  - A key that's gone renders as the bare key.
- **The control vocabulary** follows step 1's `message` path (step-1 plan, "The control"):
  - `messageButton` in `BLOCK_CONTROL_TYPES`;
  - its arm in `CONFIG_FIELD_ARMS` and `nodeBody`;
  - its case in `renderControl.tsx` and `cardSummary.ts`;
  - its `ControlChange` value;
  - a `controlShapeProbes` entry, which accepts `{ messageKey: 'a', buttonKey: 'b' }` and refuses `{}` and `'x'`;
  - the field-rule emit, with the field `unchecked` as `eligibility` is.

### Readiness (`logic/flowReadiness.ts`, `logic/messageButtonReferences.ts`)

- **Readiness takes declarations, not keys.** `declaredKeys: ReadonlySet<string>` becomes `declarations: readonly ResourceDeclaration[]`, and keys are taken from it inside.
- **The change is mechanical at each caller:**
  - `readDeclaredKeys` / `declaredResourceKeys` become `readDeclarations`, which also returns the journey key (for pick 3);
  - in `flowJourneyIndex.ts`, `FlowJourneyIndexEntry.declaredKeys` becomes `declarations`;
  - `flowBody.ts:464`;
  - `flowDraftRoutes.ts:131-148`;
  - `flowRoutes.ts`, seven sites;
  - `seedOnboardingFlow.ts:51`.

  `deployFlowButtons.ts` is deleted, so its caller goes too.
- **`messageButtonIssues(graph, declarations)`** finds fields by control (`messageButton`), not by block type, the same way `uploadReferenceIssues` finds `message` fields. Its issues, at path `button`:
  - "This flow's resources have no message "rules-panel". Pick another." This covers a key that isn't declared, or isn't a message.
  - ""Rules panel" has no button "verify" any more. Pick another."
  - Two nodes in this flow naming the same button: an issue on each (pick 3).
- **One judgement everywhere.** `flowReadinessIssues` asks it, so the builder's marks, the list's count and the switch-on gate all agree.

### The go-live check (`src/web/api/flowRoutes.ts`)

- **What the route reads.** It already reads `otherLiveFlows` when the write goes live (`:917-949`). It now also passes the ids of the flows in this flow's journey, from `selectFlowIdsForJourney` over the links and the guild's flow ids.
- **What `decidePut` does.** After the loop check, `buttonClaimConflict(otherLiveFlowsInJourney, graphItWouldRun, declarations)` returns the first conflict, which becomes the pick-3 refusal.
- **Where the logic lives.** In `flows/logic/buttonClaims.ts`: pure, and tested on its own.

### The press (`flows/logic/messageButtonPress.ts`, `engine/flowTriggerDispatch.ts`)

**`startButtonRun(interaction, flow, node)`**, in `engine/`, is today's handler from line 44 down: gate → wake → health → `deferUpdate` → `executeFlow` → `followUp`.
- It takes a `health` input, so each route words its own off, missing and wrong-guild cases.
- The `flow:` bridge and the new router both call it, so the gate and the wake order exist in one place.

**`handleMessageButtonPress`**, the new body:
1. **Not a button:** as today. **Not in a guild, or no `GuildMember`:** today's sentence.
2. **Read the id** with `parseMessageButtonCustomId`. A malformed id is an error.
3. **Find the posted message** with a new repo method, `resourceBindingsRepo.findPostedMessage(guildId, interaction.message.id)`: `ownerKind 'journey'`, `kind 'message'`, `discordId` equal to the id.
   - No row: wake the waits (there's no gate to ask), then answer `NOTHING_HOOKED_UP`.
4. **Find the listeners** with `journeyButtonListeners(guildId, row.ownerKey)`, filtered to `(row.resourceKey, buttonKey)`.
5. **Answer by how many live listeners there are:**
   - exactly one: `startButtonRun`;
   - none: wake, then "disabled" if an off flow names the button, else `NOTHING_HOOKED_UP`;
   - two or more: wake, log, then the fighting sentence.

**Timing.** These reads come before `deferUpdate`, as the flow read does today: three indexed reads inside Discord's 3 seconds.

**The `flow:` bridge** (`initFlows.ts:114-122`) stays registered for this deploy. It is marked as a bridge, pointing to "After this step".
- It keeps routing `flow:<flowId>:<nodeId>` to the converted node. Today's handler reads only `eligibility` and `startedBy`, and both survive the conversion. A node the migration emptied has no `button` to run from, so its press answers `RETIRED_BUTTON_MESSAGE` instead (review H1).
- Every press logs `[flows] flow: bridge press` with the flow id, node id, message id and channel id. That log is how the stragglers are found.

### The changeover: a data migration (`2026-10-2x-Button_Click_Listens_To_Message.ts`)

**Production's state can't be read from here.** Douglas's server has Button Click flows deployed. The migration logs one summary per guild, and the live run starts with a record taken before the deploy.

**Shape.** It follows `2026-10-24-Post_Embed_Message_Shape.ts`:
- select the rows, loop in TypeScript, write back with `JSON.stringify`;
- the transforms are frozen in the file, never imported;
- the SQLite arm opens its own `db.transaction()`;
- `updatedAt` is handled as step 1's migration handled it.

It writes `flows`, `flow_drafts`, `journeys`, `flow_journey_links` and `resource_bindings`, and reads `flow_button_messages`.

**Which nodes and which channels.** The posted rows decide, not the nodes (review items 9 and 24, Douglas's answer 7):
- For each flow with Button Click nodes that have no `button`, take its `flow_button_messages` rows. Parse `node_ids` as JSON on both dialects.
- For each channel, the newest row whose `nodeIds` include a current Button Click node of the flow is the **posted message**. Its `channel_id` is the destination; the node's own `channelId` isn't consulted.
- A node no row names is **never posted**: it loses its old keys, gets no `button`, and is logged. No channel or message is declared for it.
- A flow with no posted message at all keeps no journey change; only its nodes are emptied.

**For each flow with at least one posted message:**

1. **Its journey, by group** (Douglas's answer 1).
   - Two flows are in one group when they have a posted message in a common channel, or already share a journey (link row, or the flow-id fallback). Groups are transitive.
   - No member has a journey: create one, keyed by the oldest member's flow id, `createdForFlowId` that flow, named after it, and write a link for every member, as `saveFlowResources` does (`journeyRoutes.ts:891-913`).
   - Exactly one journey among the members: link the others to it. If it exists only as a flow-id fallback, write its owner's link too.
   - Two or more different journeys: merge nothing. Each flow keeps its own journey (created as above when it has none), and the hazard is logged, naming the journeys and the channel. Install will block the second adopt (`installPlan.ts:629`); the operator re-points one trigger.
2. **The channel, once per journey per destination**, by the first rule that matches:
   1. A `textChannel` binding in this journey whose `discordId` is the destination, and whose key is still declared (review item 23; if it isn't, re-declare a `textChannel` under the binding's own key).
   2. The node's `channelIdKey` sidecar, when it names a declared `textChannel` whose adopt id or binding is the destination.
   3. A declared `textChannel` already adopting that id.
   4. Otherwise, declare `{ kind: 'textChannel', key: unique slug, defaultName, adoptDiscordId }`. The `defaultName` is the bound name if any binding in the guild names that id, else "<flow name> channel". Adopted resources keep their own name and repair never renames them (`resourceDrift.ts:316-341`), so a placeholder name is safe.

   A channel already held by a journey outside the group is the residual hazard: logged, naming both journeys.
3. **One message resource per (flow, channel)**, kept one-to-one with what was posted. A merged journey can hold two messages in one channel:
   - The resource is `{ kind: 'message', key: unique slug of the flow name, defaultName: flow name, parentKey, message: { content: "**<flow name>**", embeds: [] }, buttons }`. The content is exactly what deploy posted (`deployFlowButtons.ts:184`).
   - Each Button Click node in that channel becomes a button, in graph order: `{ key: unique slug of its label (or "button"), label, style }`.
   - `{{` and `}}` are stripped from a name or label, with a warning, because a resource message refuses tokens.
   - More than 25 buttons can't happen: deploy refused more than 25 in one channel (`planButtonDeployment.ts:111`).
4. **The node** becomes `{ button: { messageKey, buttonKey }, eligibility }`. A never-posted node becomes `{ eligibility }`, logged; readiness then says "Fill this in."
5. **The posted message** gets a `message` binding:
   - `state 'created'`: the bot posted it, so uninstall deletes it;
   - `discordId` is the message id, and `messageChannelId` is the channel;
   - **`messageDigest` is null**, so drift reads it as out of date (`journeyDriftPlan.ts:346`). `isPostedMessageRow` accepts a null digest (`lookupBoundMessage.ts:25`). Before relying on null, check that nothing reads a null digest as clean; if something does, use a fixed sentinel instead.

   Older rows for the same (flow, channel), and rows whose flow is gone, are logged as messages to delete by hand. The bridge keeps their buttons working until it's removed.
6. **Drafts.** Every draft of the flow gets the same node-id mapping. A Button Click node that exists only in a draft loses its old keys and gets no `button`, with a warning.

**Every journey it writes must pass `validateJourneyDeclaration`** (`journeysRepo` validates on read, and one bad row 500s the flows list) **and `messageResourceProblems`.** The test asserts both, as step 1's test asserted `validateNodeData`.

**Idempotent.** A node that already has `button` is skipped. A key or binding that already exists is reused, never duplicated.

**`down`** rewrites converted triggers back to `{ channelId, label, style }`. It takes `channelId` from the parent's adopt id or binding, and otherwise writes the sidecar. It leaves the declarations and bindings, which step 2's code reads fine. The file header says what is lost.

**After the deploy, each converted journey goes:**
1. **Install** adopts the channel. The message is `reuse` (`installPlan.ts:810-818`), so nothing is posted.
2. **Drift** shows "out of date".
3. **Repair** edits in place: the same content, `components` now `mbtn:<key>`, no files. The message keeps its id and its place.

Until then, its `flow:` buttons answer through the bridge.

**The alternatives, for Douglas:**
- **(A) Recommended: a data migration, adoption, the `flow:` bridge, and the operator running Install and Repair.**
  - No Discord is needed at migration time, so it is tested on SQLite and on live Postgres.
  - Nothing is reposted.
- **(B) A `ClientReady` one-shot that does Install and Repair itself, for every converted journey.**
  - No operator steps.
  - But it calls Discord at boot, in every guild, on every restart until it has finished, and its failures have nowhere to show but the log.
  - The bridge is still needed in between.
- **(C) Don't adopt.**
  - Install posts fresh messages, and the old ones are deleted by hand, or by a startup job reading `flow_button_messages`.
  - The old messages lose their place in the channel, and old and new are both live until somebody deletes the old ones.

### The stale-tab bridge (`src/web/api/staleBuilderGraph.ts`)

- **It becomes a per-block table.** Post Embed keeps its flat keys. A Button Click is stale when it holds `channelId`, `label` or `style` and no `button`.
- **Why it's needed:** a builder tab older than the deploy would otherwise send the old shape, and `withDeclaredNodeData` would strip it to `{ eligibility }`, wiping the migrated `button`.
- **The sentence becomes block-neutral:** "This builder tab is older than the server, so saving it would wipe your work. Reload the page, then save again."

### Retiring Deploy

**Delete:**
- **Files**, with their tests:
  - `flowDeployCommand.ts`
  - `deployFlowButtons.ts`
  - `planButtonDeployment.ts`
  - `undeployFlowButtons.ts`
  - `flowButtonMessagesRepo.ts`
- **Exports and wiring:** the three exports in `flows/index.ts`, and the registration at `initFlows.ts:108-109`. `/flow-deploy` leaves Discord on the next boot, because `registerCommandsWithDiscord` PUTs the full global list (`bot.ts:61`).
- **Routes:** `deployFlow`, `undeployFlow` and `undeployJourney`, with their entries in `rateLimitClassification.test.ts` (`:26,31,50`).
- **Wire members:**
  - `DeployResult`, `DeployedButtonMessage`, `UndeployResult` and `UndeployedButtonMessage` (`installBody.ts:37-67,152-153`);
  - `PublishedButtonMessage`, `buttonMessages` and `mayHaveUnrecordedButtons` (`publishedBody.ts`, `publishedFlowState.ts`, `publishedJourneyState.ts`). A converted message shows in `deletableResources` through `previewUnpublish`, like any other message.

**Comments that name deploy:** `flowsRepo.ts:304-308`, `discordErrors.ts:10`, `guildBody.ts:60`, `flowRoutes.ts:1017-1024,1175-1180`, `journeyRoutes.ts:506-529`.

**The seed** (`templates/seedOnboardingFlow.ts`, `onboardingFlow.ts`) creates the journey:
- a `textChannel` adopting the given channel;
- a message with one button, "Agree to Rules";
- the link;
- the trigger pointing at that button.

It prints "Install its resources from the dashboard" in place of the `/flow-deploy` line.

## Dashboard

**A mockup is warranted** for the trigger's panel only. It becomes section 4 of `message-editor.mockup.html`, drawn before slice D, and shows four states:
1. **No messages:** "This flow's journey has no messages yet", then "+ New message in…" listing the declared text channels, a divider, then the server's channels.
2. **Picking:** a Message select (its name, with "in #rules" under it), then a Button select. Each button option is drawn in its Discord style. A taken one is greyed with "↳ Welcome", and the current flow's own pick says "↳ this flow".
3. **"+ New button on this message":** a small popover with Label (with an 80-character counter) and Style (Blurple, Grey, Green, Red). Add creates `{ key: unique slug(label), label, style }` and selects it.
4. **A pick that's gone:** the issue line under the field.

**The control** (`web/src/flows/controls/MessageButtonControl.tsx`):
- `ControlContext` gains `declareResources(update: (current) => next)`, wired to the builder's `saveResources` (`FlowBuilderPage.tsx:1049`). Check that `useResourceAutosave`, mounted by the always-rendered `ResourcesDialog`, saves while the dialog is closed. If it doesn't, move the hook up to the page.
- `ControlContext` also gains `listeners`.
- A new message is seeded as step 2's pick 14 does: one embed titled with its name. Its first button comes from the popover.
- **The race:** the graph and the resources save separately. If the graph lands first, it briefly shows a "no message" issue, which the next check clears. That is accepted.

**The message window** (`messageEditor/ButtonRow.tsx`):
- `MessageEditor` gains `listeners`.
- "↳ Nothing listening yet" becomes "↳ <flow name>" when someone listens.
- A listened button's key locks, and Remove asks first (pick 6).

**Resources panel:** frozen keys are installed ∪ listened (pick 6).

**The builder:**
- The Deploy button (`:2053`), its modal (`:2577-2607`), `handleDeploy` (`:1594-1613`) and `hasButtonTrigger` (`:1773-1782`) go.
- The resources target follows pick 7.
- Pick 3's 400 shows in the existing save-error banner, as the loop refusal does. There is no new refusal UI.

**Inventories** (`InstalledResourcesDialog`, `JourneyResourcesDialog`, `publishedInventory.tsx`, `publishedSummary.ts`) lose:
- the button lines;
- `canUndeploy` and "take buttons down";
- the "may be more" note.

**Wait for Event:** the option label becomes "a button click", and the example at `block-authoring.md:462` follows.

## Slices

**All four ship in one deploy.**
- If A shipped alone, every stored Button Click node would read as incomplete until C's migration.
- If C shipped without D, the builder would still offer a Deploy that calls a deleted route.

The slices are build order and review points.

**Every slice leaves web `tsc` green:**
- A adds a stub `MessageButtonControl` (the two selects, no inline creation), as step 1's slice B did with `MessageControl`.
- C removes the web callers of the deleted SDK functions (`deployFlow`, `undeployFlowMutation`, `undeployJourney`) in the same slice.

| # | Change | Proof |
|---|---|---|
| **A** | **The trigger and its save rules.** The schema and fields; `messageButton` through the control vocabulary (stub UI); readiness on `declarations`, with all its callers and `flowJourneyIndex`; `messageButtonIssues`; the one membership function (review item 2); `buttonClaims.ts`, the go-live refusal, and the group route's refusal and preview warning (answer 3); the stale-tab table; `getJourneyButtonListeners` and `journeyButtonListeners`; the version check on both resource PUTs and its browser send (answer 4), with `resourceSaveTarget.ts`'s recorded 409 comment and test updated; rate classification; `pnpm sdk:generate`. **To stay green** (review item 6): delete `planButtonDeployment` and `deployFlowButtons` (with `/flow-deploy`, the deploy route, and the builder's Deploy button and modal, which only call them; undeploy stays until C), rewrite the seed, and retarget every test that builds the old Button Click shape | **`messageButtonIssues` table:** an undeclared message key, a key naming a channel, a missing button key, and two nodes on one button each give their issue at `button`; a good pick gives none. Sabotage: drop the button-key check, and its row passes. **`buttonClaims.test.ts`:** a live flow in the same journey conflicts; a flow in another journey with the same keys doesn't; an off flow doesn't. **Routes:** a live flow's graph save onto a taken button gives a 400 naming the other flow, with `issues: []`; an off flow's save is stored, and its switch-on gives a 400. Sabotage: drop the journey filter, and the other-journey case fails. **Stale tab:** an old-shape Button Click is refused on save, create, draft and check; one with `button` passes. **Listeners route:** lists live and off listeners with names; another guild's journey answers 404. **Gates:** `nodeBody.test-d.ts`, `controlShapeProbes`, `openApiSpec`, `generatedSdkIsCurrent`, `rateLimitClassification`, `everyRouteInSpec` |
| **B** | **The press.** `startButtonRun` extracted; the new `handleMessageButtonPress`; `findPostedMessage`; the wake; the `flow:` bridge marked and logged; `buttonListeners.ts` (the hook), its registration in `initFlows`, `previewInstall` asking it, and the new install note; the repair preview naming the flows an edit would disconnect (answer 5) | **Integration** (TestDiscord with real discord.js and SQLite, in the `provisioningDrift.integration.test.ts` style). Install a journey with a message, two buttons, and a flow listening to one. A press on it runs the flow, as a `deferUpdate` with no reply; the other button answers `NOTHING_HOOKED_UP` ephemerally. With the flow off, the disabled sentence. A gate refusing the presser gets the refusal, no run, and **no wake** of their parked button-click wait; an allowed press wakes it. Sabotage: move the wake above the gate, and the refused case wakes. Two live listeners written straight to the database: neither runs, and the fighting sentence. A forgotten binding: `NOTHING_HOOKED_UP`. Another journey's flow naming the same keys never runs. A `flow:` press on a converted node still runs it and logs the bridge line. **Install note:** names only the unheard button. **`provisioningWiring.test.ts`:** both boot roots register the reader |
| **C** | **The migration (`2026-10-26-…`), and the rest of Deploy.** The migration; deleting undeploy, the repo, the remaining routes, wire members and published fields; the web callers of the deleted routes (undeploy actions, inventory lines); `pnpm sdk:generate` | **Migration on SQLite**, through a real `Migrator`. Seed: a live flow with two buttons into one channel (a raw snowflake) and one into another (a sidecar to a declared, bound channel); an off flow with no journey; a flow on a shared journey; a flow with two `flow_button_messages` rows for one channel; a row whose flow is gone; a draft with a draft-only Button Click; a label containing `{{`; a node no row names (emptied, nothing declared). **Merge cases** (answer 1): two flows posted into one channel with no journeys give one journey with both linked and two messages under one channel; one with a journey gives the other linked to it; two with different journeys merge nothing and log the hazard; a flow posted into two channels joins two groups transitively. Up gives the exact journeys, links, bindings (`created`, digest null), nodes and drafts. Every journey passes `validateJourneyDeclaration` and every message passes `messageResourceProblems`. The warnings list the older row, the orphan row and the draft-only node. A second up changes nothing; down then up works. **On the migrated data, with TestDiscord holding the posted messages:** install adopts the channel and reuses the message, sending nothing; drift says `outOfDate`; repair edits the same message id to `mbtn:` components; drift is then clean; a press runs the flow. Sabotage: write the new digest in place of null, and drift says clean. **Live Postgres** (a throwaway `postgres:16`, env on the command line): seed, up, down, up, then read one row of every table back, and check `graph` and `resources` are still `jsonb`. **Gone:** `/flow-deploy` isn't among `getSlashCommandBuilders()`, and the three routes answer 404. **Retargeted tests** (below) |
| **D** | **Dashboard and docs.** Section 4 of the mockup, drawn first; `MessageButtonControl` in full, with inline creation; `declareResources` and `listeners` in the context; the builder's resources target (pick 7); the window's labels, key lock and Remove confirm; frozen keys; the Wait for Event label. **Docs:** `block-authoring.md` (the control row, the card row, the `startedBy` note on the button dispatcher, `:462`); `AGENTS.md` (the last sentences of the `mbtn:` bullet, Deploy gone, the bridge); the design doc's step 3 line and a "Step 3 as built"; the PRD build order; an "As built" here | **`dom`:** the picker lists the journey's messages, then that message's buttons; a taken button shows "↳ Welcome" and can't be picked; "+ New button" writes the button into the declaration and the pick into the node in one step; "+ New message" on a server channel declares the adopted channel and the message; a listened key is `readOnly`; Remove on a listened button asks first; a listened message's key doesn't follow its name. **e2e** (`web/e2e/buttonClickMessage.test.tsx`): from an empty flow, "+ New message in #rules" and "+ New button"; save; install; TestDiscord holds one message with an `mbtn:` button; pressing it runs the flow. **Preview:** a seed with the trigger panel in the mockup's four states; `preview:shoot` at 1440 and 1280, checked by hand against the mockup |

**Tests that break by construction**, retargeted in C. They build `trigger.buttonClick` with `{ channelId, label, style }`, deploy, or read `flow_button_messages`:
- **Flows engine and blocks:** `bindResourcesToGraph`, `blockDiscovery`, `builderRoundTrip`, `channelFromCondition`, `durableRuns`, `eligibility`, `executor`, `nodeDataValidation`, `parkedRunChannel`, `pickRandom`, `runVariables`, `subjectAbsentRuns`.
- **Flows data:** `flowRunsRepo`, `flowsRepo`, `flowButtonMessages.integration`, `blockFieldRules`.
- **Elsewhere on the server:** `postEmbedMessageShapeMigration`, `flowDeleteTouchesNothing`, `journeyTeardownRoutes`.
- **Web:** `web/e2e/flowBuilderToolbar.test.tsx`, `web/e2e/preview/scenario/seedFlows.ts`, `web/src/flows/__tests__/unreachableNodes.test.ts`.

Most only need the new config shape. The deploy and undeploy tests are deleted.

**Review:** one reviewer pass after C. It covers a new interaction route that acknowledges presses, a data migration over five tables, the adoption of posted messages, and a retired command.
- A is guarded by its sabotage checks; D by its tests.
- A second pass only to confirm that C's Critical findings were fixed (memory note *reviewer-budget-one-pass*).

## The live run

On Douglas's server, against the production stack (Postgres, behind the tunnel). **None of step 1's or step 2's live run has happened**, so this run includes both, in deploy order.

**Before the deploy** (the only record to compare against afterwards):
1. For every flow with a Button Click, open its inventory and note each button message: its channel, its message id, and which buttons it has. Press one and check that it runs.

**After the deploy, step 1's checks** ([message-editor-step-1.md](message-editor-step-1.md)):

2. **The migration:** an existing Post Embed posts the same embed, and the log shows step 1's migration warnings.
3. **The full message from Post Embed:** plain text pinging the member, three embeds, uploaded header and footer icons, and a `{{subject.avatarUrl}}` thumbnail.
4. **Icons:** `attachment://` draws in the header and footer icons, on both a Post Embed and a resource message.
5. **The upload limit:** about 9.5 MiB across several uploads, then two files of about 6 MiB each. Set `MESSAGE_LIMITS.uploadBytes` from the answer.
6. **The stale-tab refusal**, now for both Post Embed and Button Click: open a builder tab before the deploy, then save from it after.
7. **An upload through the tunnel:** nearly 8 MiB answers 201; one byte over answers the app's 413; `cf-cache-status` is not `HIT`.

**Step 2's checks** ([message-resource-step-2.md](message-resource-step-2.md)):

8. **Nothing listening yet:** install a journey with `#rules` and a full message with three buttons. A press answers the "Nothing's hooked up" sentence, which only the presser sees.
9. **Drift and repair:** drift right after install is clean (the `jsonb` key order). Edit the title and swap a picture, and drift says out of date. Repair keeps the same id and place, with every picture shown once.
10. **Deleted and uninstalled:** delete the message in Discord, and install reposts it. Uninstall deletes the message, then the channel.
11. **A missing permission:** take Read Message History off the bot's role, and the plan names the blocker.

**Step 3's checks:**

12. **Save the log, straight after the deploy:** `docker logs <bot container> > step3-migration.log`. The next redeploy wipes the container's logs, and this one is the only record of what the migration did.
    - **If it's lost**, the two things to act on can be found again (Postgres):
      - **strays**, messages to delete by hand: `SELECT f.* FROM flow_button_messages f WHERE NOT EXISTS (SELECT 1 FROM resource_bindings b WHERE b.kind = 'message' AND b.discord_id = f.message_id);`
      - **emptied nodes**: `SELECT f.flow_id, f.name, n->>'id' AS node_id FROM flows f, jsonb_array_elements(f.graph->'nodes') n WHERE n->>'type' = 'trigger.buttonClick' AND NOT (n->'data' ? 'button');` (and the same over `flow_drafts`).
13. **The migration log** names every flow from check 1, each adopted message, and any older or orphaned rows and shared-channel hazards. Delete the listed strays by hand.
14. **The old buttons of adopted messages still work, straight away.** Each press logs the bridge line. A button whose trigger was emptied (never posted, or posted before the table existed) answers "This button's been retired — ask a mod to repost it." and logs a warning naming its flow, node and message.
15. **Each converted flow** shows its channel (adopted) and its message, with "↳ <flow>" under each button. Its trigger shows the message and the button.
16. **Install, then Repair, for each converted journey:**
    - install adopts the channel and posts nothing;
    - drift says out of date;
    - repair keeps the message's id and its place;
    - presses now log no bridge line;
    - a gated button still turns away a member without the role.
17. **A parked Wait for Event** ("a button click") wakes on an `mbtn:` press.
18. **A new flow:** use "+ New message in #channel" and "+ New button", install, press, and it runs.
19. **One flow per button:** a second flow's picker shows the button as taken. Force it through the API, or a second tab, and switching on is refused, naming the first flow.
20. **Off and removed:** with the flow switched off, a press answers "disabled". With the trigger removed, "Nothing's hooked up".
21. **Deploy is gone:** `/flow-deploy` is no longer in Discord's command list, and the Deploy button is gone.
22. **Gates:** the suite at its quiet baseline (2 known failures), root `tsc` at its baseline, and web `tsc` at 0.

## After this step: the bridge-removal deploy

A small change, made once the log has shown no bridge press for a week and drift is clean on every converted journey:
- replace the `flow:` handler with a permanent one-line answer, "This button's been retired — ask a mod to repost it." (Douglas, 2026-10-25), and remove `flowTriggerDispatch`'s bridge entry;
- remove `staleBuilderGraph.ts` (both blocks) and its `DECLARED_BLOCK_DEPENDENTS` entry;
- a migration that drops `flow_button_messages`, and its `Database` entry.

## Not in this

- An in-memory listener index (pick 4).
- Listening to a message in another journey (pick 1).
- Moving a converted message's binding when its flow is dragged to another group. The merge already warns that it is orphaned (`journeyMergePlan.ts:195`), and its presses then answer "Nothing's hooked up".
- Editing a message's buttons from the trigger panel beyond creating one. Edits go through Resources.
- Reaction Add on a message resource, select menus, and the ticket panel (design, "Not in this").
- Recovering messages deployed before `flow_button_messages` existed (2026-09-20). Nothing recorded them, and the migration empties their triggers, so from this deploy on their buttons answer that they're retired; a mod reposts them as message resources.

## Owner might disagree

- One flow per button judged at go-live, not on every save (pick 3).
- Adopting posted messages, with a bridge, versus a boot job or reposting (pick 13).
- Keys frozen in the browser only (pick 6).
- The builder saving resources through the journey (pick 7).
- Server channels offered in "+ New message" (pick 8).
- Keeping `flow_button_messages` until the bridge goes (pick 14).
- The adopted channel's placeholder name, "<flow name> channel".
- Shared-channel hazards left to the operator.
- The wording of the press sentences and of the retired-button line.

## As built

Built 2026-10-25, all four slices, uncommitted. The live run above has not happened; it is the next step, as listed. Where the build settled something the plan left open, or departed from it:

**A (the trigger and its save rules)**
- **The key rule is shared**: the pattern and its 64-character limit are in `src/shared/resourceKey.ts`. Readiness reads `readDeclarations` (`logic/flowDeclarations.ts`, renamed from `declaredResourceKeys.ts`).
- **One membership rule**, `logic/journeyMembership.ts` (`flowIdsInJourney` pure, `flowsInJourney` async), replaced `selectFlowIdsForJourney` and the private `flowsInJourney`. `otherFlowsOnJourney` stays links-only, on purpose.
- **Claims**: `logic/buttonClaims.ts` (`buttonClaimConflict`, `buttonClaimRefusal`, `buttonClaimMoveRefusal`) over `buttonPicksIn` in `messageButtonReferences.ts`. `decidePut` takes `journeyFlowIds`; the group and attach routes answer 409; the group preview's `buttonConflict` shows in `GroupConflictDialog`; detach checks too, when the flow falls back to the journey keyed by its id.
- **The version** is `journeys.updatedAt`, which now strictly increases, checked and written in one transaction (`updateAtVersion`, `deleteForFlowAtVersion`; `update` takes the same lock). A flow PUT on an existing journey and a journey PUT carrying `resources` must send `baseUpdatedAt`, else 409 "reload". A rename, group or merge moves it too, so a Resources tab open elsewhere has to reload; accepted. The group merge writes its destination at the version it read ("This group changed while you were dragging — try again.").

**B (the press)**
- **`startButtonRun`** (`engine/flowTriggerDispatch.ts`) takes `{ gates, outcome }`: a `run` is gated by its own node; only an `answer` carries gates (`ButtonGate { flowId, node }`), which decide the wake, and logs an unreadable one.
- **The `mbtn:` router** goes `findPostedMessage` → `journeyButtonTriggers`, keeping only `startedBy: 'buttonClick'` nodes; a malformed journey answers `JOURNEY_UNREADABLE` and wakes nothing.
- **The `flow:` bridge** logs every press. On a node the migration emptied it answers `RETIRED_BUTTON_MESSAGE`, gates kept, logging flow, node, message and channel.
- **The hook** `provisioning/buttonListeners.ts` is registered in `initFlows` and `bootBot.ts`. Drift's `outOfDate` and the orphan sentence name the flows a repair or removal cuts off, through `MessageState.postedButtons`, with no wire change. TestDiscord models presses (`interactionState.ts`).
- **Accepted**: no index on `discord_id` (`findPostedMessage` scans the guild's bindings); the wake runs before the press is acknowledged, behind four reads; one malformed flow graph anywhere in the guild makes every `mbtn:` press answer the generic error; the fighting sentence says "Two flows" when both triggers are in one flow.

**C (the migration, and the rest of Deploy)**
- **`2026-10-26-Button_Click_Listens_To_Message`**, tested through a real `Migrator` on SQLite, in TestDiscord (install reuses, drift says out of date, repair edits the same id, a press runs) and live on `postgres:16` (up, down, up; `jsonb` kept).
- **Buttons follow the posted row's `nodeIds` order**, which is what's in the channel. A node posted in two channels is a button on both messages and listens to the newer one, logged.
- **The channel rule order**: bound under a declared key, the sidecar, a declared adopt, bound under an undeclared key (re-declared), a new adopt. Rules 2 and 3 skip a key installed as another channel; with no key left to hold it, that post isn't adopted, and its triggers are emptied, logged.
- **Grouping counts a journey holding a posted channel** (a settled `textChannel` binding on it), so the group joins that journey. In the hazard branch, a member in no journey joins the journey of a channel it shares.
- **An existing message is recognised on down-then-up** by its binding, else by channel, name, exact `**name**` content, no embeds and no binding, so it never swallows an operator's own message. `down` leaves a node naming an undeclared button alone, with a warning.
- **It throws only on impossible states** (unparseable JSON, over 25 buttons or 100 resources, duplicate keys or adopts, a flow id that isn't a key, a message bound to another owner), rolling back so the container won't start. The version moves only when the resources really change. The log, printed after the last guild is written, also names the node ids an adopted row lists that are gone.
- **Deploy is gone**: `undeployFlowButtons`, `flowButtonMessagesRepo`, every deploy and undeploy route (`deployRoutesGone.test.ts`), the published-state button fields and the web undeploy paths. `flow_button_messages` and its `Database` entry stay for the bridge-removal deploy.
- **The conformance rule**: only a `startedBy: 'buttonClick'` trigger may declare a `messageButton` field (`checkMessageButtonSource`).

**D (dashboard)**
- **The builder saves through the journey only once a link row names it** (`FlowAttachment.linked`, `builderResourcesTarget`), not as soon as the journey key is known: a flow from before the link table is on its id-keyed journey unlinked, and saves through the flow until that save writes the link (review item 33).
- **The browser keeps a version per autosave identity.** After the stale 409 it stops saving that list, keeps the reload sentence up and toasts on leaving; other 409s revert as before. The sentence is mirrored in `resourceSaveQueue.ts` (`staleResourcesMessageDrift.test.ts`).
- **A refused save the trigger panel started, with Resources shut, is a toast** in the server's words ("Your resources didn't stick"), as a refused graph save is; open, the panel says it in place (`ResourcesDialog.tsx`, `builderResourceSaves.test.tsx`).
- **A button another trigger in the same flow holds is taken too**: greyed, "↳ another trigger in this flow", since one press starts one run.
- **No chip on the group header.** The flows page reads listeners only for the group's Resources window.
- **A listened message's key stops following its name but isn't locked**; only a listened button's key is.
- **The picker's issue line sits between the selects and the "+ New" links**, not under the links, and the links stack close where the inspector is too narrow for both (checked against mockup section 4 at 1440 and 1280).

**Still open**
- **The merge empties the moving journey's declarations unversioned**: it doesn't check the version it read, so a Resources save landing on that journey mid-merge is overwritten.
- **The stale 409 is told apart by its sentence**, because the flow route also answers 409 for a journey other flows share. A status or code of its own would retire the mirrored sentence.
- **Buttons posted before 2026-09-20 now answer "retired".** Nothing recorded them, so the migration emptied their triggers; a mod reposts each as a message resource.
- **The closed Message select shows only the name**, not the mockup's "in #rules" second line; the option list shows it.
