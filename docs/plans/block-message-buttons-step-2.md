# Button Click listens to a block's button (step 2)

> **Status**: Planned 2026-10-27; built 2026-10-27 (uncommitted) — see [As built](#as-built). Not run live.
> **Owner**: Douglas
> **Follows**: [block-message-buttons-step-1.md](block-message-buttons-step-1.md), committed in `62e5dae`.
> **Next**: step 3 — a "Who" field on the blocks that act on a member.

## The gap

Step 1 lets Post Embed and Open Ticket post buttons (`mbtn:<buttonKey>`) and records every such post in `flow_posted_messages` (message id → flow, node, run, subject, ticket, channel). Nothing reads the record: a press finds no journey binding and answers "Nothing's hooked up to this yet". Button Click can name only a journey message's button (`button: { messageKey, buttonKey }`).

## What step 2 does (settled with Douglas)

- Button Click can name a button on a block's message. Every press starts a **new** run.
- The run is **about** whoever the posting run was about (`subject_id`; for Open Ticket, the ticket's subject). Posted by a run about nobody → about the presser. The presser is the run's **actor**.
- A post from Open Ticket seeds the run's `ticketId` and `ticketChannelId` variables (keyed on `ticket_id` being set, never on the block type), so Close Ticket with `{{var.ticketId}}` works.
- "Who can press it" judges the presser; its "only the member the run is about" means the run's subject as above.
- Same rules as journey buttons: one flow per button (go-live and grouping), nobody listening → "Nothing's hooked up to this yet", only switched-off listeners → disabled, two live → neither runs, and the press wakes parked button-click waits in today's order.
- Who may listen: a flow in the posting flow's journey, or the posting flow itself when it has no journey.
- A trigger naming a block button that is gone, outside the journey, on a block that posts no buttons, or no longer on the message is a readiness issue (stored, can't go live). Two triggers in one flow on the same button too.
- The trigger's picker offers block buttons beside journey messages; a block's message window names its listeners and locks a listened key, as a journey message's does.

## Design

### Config

`button` becomes `z.union([{ messageKey, buttonKey }, { flowId, nodeId, buttonKey }])` (plain union, no discriminator). Every saved graph matches the first arm, so **no migration**. `flowId` is always written, also for the listener's own flow, so every comparison is an exact triple. `nodeId` is `min(1)`; `buttonKey` keeps the resource key rule. The `messageButton` conformance probe accepts both arms and refuses half-shapes. SDK `MessageButtonRef` becomes a union of named `JourneyButtonRef` and `BlockButtonRef`. Journey-only machinery (`journeyButtonListeners.ts`, provisioning's `buttonListeners.ts`, `ButtonListener`, install's note, drift) is untouched; `buttonPicksIn` already skips a value without `messageKey`.

The poster's ids in listener types are named `messageFlowId` / `messageNodeId`, never `flowId` / `nodeId` (those mean the listener). The browser overlay builds listener objects explicitly — spreading a pick would overwrite the poster's id with the listener's.

### Press

- `flowPostedMessagesRepo.findByMessageId(guildId, messageId)`; `handleMessageButtonPress` asks it first (a primary-key read), then falls through to today's journey path unchanged.
- `logic/blockButtonListeners.ts`: `blockButtonTriggers(guildId, record, buttonKey)` — the posting flow (gone or another guild → none), its journey via `resolveFlowJourney` (`MalformedJourneyError` → `JOURNEY_UNREADABLE`), its flows via `flowsInJourney` or the posting flow alone, then the button-click triggers whose pick is exactly `(record.flowId, record.nodeId, buttonKey)`. The posting node's current buttons are not re-asked: what was posted is what can be pressed.
- Only when somebody listens: subject = `memberOrLeaver(guild, record.subjectId)` (moved out of `ticketEventDispatch.ts` into `logic/memberOrLeaver.ts`; a leaver is a partial member, as Ticket Event has it), or the presser when there is none; variables from the ticket columns.
- `pressOutcome` reads `flow.enabled` / `flow.name` and takes `{ flow, node }[]` plus a log label, so both branches share it and its sentences.
- `startButtonRun` (`engine/flowTriggerDispatch.ts`) takes optional `subject` and `variables`. Every gate — answers included, so off and fighting flows decide the wake the same way — is judged against `{ candidate: presser, subject: subject ?? presser, actor: presser, variables }`; the seed is `subject ?? presser`, actor presser, those variables. Wake order unchanged. `EligibilityFacts` widens to partial members (only `.id` is read). Nothing ticket- or journey-shaped enters `engine/`.

### Readiness, claims

- `logic/blockButtonReferences.ts`: `blockButtonPicksIn(graph)`, `postedButtonNodesIn(graph)` (nodes whose visible `message` field declares `buttonsKey`, found by control — never by block type), and `blockButtonIssues(graph, scope)` with the wrong-flow / gone / posts-no-buttons / missing-button / duplicate issues at the field path.
- `flowReadinessIssues(graph, scope)` takes a `ReadinessScope = { flowId, declarations, journeyFlows }` (the journey's other flows). `FlowDeclarations` gains `flowId` and `journeyFlows`, so it is a scope; callers change mechanically. Create and the seed pass an empty scope. The flows list builds `journeyFlows` from rows it already loaded (no extra query).
- `buttonClaimConflict` also compares block picks by exact triple against the live holders already filtered to the journey, naming `"<block> in <posting flow>"`. No journey → no cross-flow claims (nothing else can listen).

### Browser

- The journey listeners route (`getJourneyButtonListeners`) widens with `blockMessages` (each journey flow's posting nodes: flow, node, block label, headline, buttons) and `blockListeners` (block picks of the journey's flows). No new route; still database-only.
- No journey: the picker offers the canvas's own posting nodes, computed in the browser.
- The canvas overlays its own posting nodes and picks over the server's answer.
- `MessageButtonControl`: journey messages, then block messages grouped by flow ("This flow" first), then the button. "+ New button" is hidden for a block message, with a one-line hint (its buttons are edited in its own message window). Taken buttons greyed with "↳ Flow"; a gone pick shows marked.
- `MessageControl` passes the block's listeners to the window; `ButtonRow`'s listener line, key lock and Remove confirmation then work as for journey messages.
- Card: the block arm names `"<headline or block> · <button>"` (fallback `"a block's button · <key>"` if the plumbing is wide).
- Eligibility hint copy for `subject` / `actor` on a trigger changes (see Decisions, 1).

## Decisions

1. **One gate rule for every press.** The gate sees the run the press would start. On a journey message press that is the presser as both subject and actor, so a `subject` or `actor` gate there changes from refusing everyone to admitting the presser. Nobody writes a gate meaning "refuse everyone"; the hints are rewritten to say what they now mean.
2. **A post from a run about nobody** makes the presser the subject, so "only the member the run is about" admits whoever presses it. Said in the hint.
3. **Button Click declares no ticket outputs.** `{{var.ticketId}}` in Close Ticket's text works (copy tokens pass as written); the variable picker won't offer it and a channel picker can't take `{{var.ticketChannelId}}` — the run's channel already is the ticket channel. Possible follow-up.
4. **No ticket read on press.** The record holds the subject, ticket and channel. A deleted ticket has no channel left to press in.
5. **The wake matches the presser's own parked runs**, as today: a mod's press does not wake the ticket subject's parked wait.
6. **Accepted, not built:** a posting flow moved or deleted silently cuts off a listener in another flow (readiness flags it next read; presses answer "Nothing's hooked up"); deleting a listened posting node asks nothing; `flow_posted_messages` is never pruned; posts from before step 1 stay deaf.
7. **The record stays in `logic/`** (step 1's open question): `ticket_id` is used here. AGENTS.md says why.

## Tests

Server: the press integration test (TestDiscord + SQLite) — subject M / actor P on a Post Embed press; null subject → presser; Open Ticket seeds ticket vars and Close Ticket closes it; a subject gate admits the ticket subject and refuses a mod without waking the mod's wait; leaver → partial member; no record → nothing hooked up; off → disabled; two live → fighting; posting flow deleted; wrong journey never runs; no journey self-listen runs. `blockButtonReferences` issues; claims; conformance arms; `findByMessageId` guild-scoped; eligibility partial subject; `journeyFlows` excludes self; go-live refusal route test; widened listeners route. Web: overlay without the id collision; `MessageButtonControl` listing, writes, greying, no inline add; `MessageControl` listener line, lock, confirm; card. Sabotage-verify: drop the gate's subject (ticket subject refused); resolve the listener's journey instead of the poster's (cross-journey runs); drop the key check in readiness.

## As built

Built as designed above; where the code made a detail come out differently, it is listed here.

- **"Fill this in." on an empty `button`.** zod 4 reports a missing union value as `invalid_union` ("Invalid input"), not a type error, so the builder lost "Fill this in." when `button` became a union. `ruleBehind` (`logic/blockFieldRules.ts`) maps `invalid_union` on an absent value to `required`; a value fitting neither arm keeps the schema's own complaint.
- **`ButtonClaimConflict` carries `button`** (the pick, either arm) instead of `messageKey`/`buttonKey`, and the claim input gains `posters` — the flows a block's button may be posted by, for the post's name in the refusal. `decidePut` hands the claim check only the guild's *live* flows, so a switched-off poster would otherwise be named "a block's post"; it passes `scope.journeyFlows`, the move check passes the guild's flows. Found by the go-live route test.
- **`ReadinessScope.flowId` is `string | null`**, with `NEW_FLOW_SCOPE` (`logic/readinessScope.ts`) for create and the seed: a flow not yet created has no id, so nothing can name it.
- **The flows list** builds each flow's scope with `readinessScopeOf` (`web/api/flowJourneyIndex.ts`) from the rows it already loaded; `flowSummary` takes the scope instead of declarations.
- **The listeners route** reads the journey's flows once and derives both halves from them: `journeyButtonTriggersIn` (pure, `logic/journeyButtonListeners.ts`) and `journeyBlockButtons` (`logic/blockButtonListeners.ts`).
- **The card's block arm was plumbed in full**: `blockMessages` rides on each card like `declaredResources`, so a pick shows `"<headline or block> · <button>"`; the fallback `"a block's button · <key>"` is only for a post no longer on offer. The builder memoizes `blockMessages` by content, since the cards carry it and a fresh array each render would loop the effect.
- **Button Click's field description** now reads "Which button starts the run — on one of this journey's messages, or under a block's post."
- **The subject is fetched after the acknowledgement, not before.** The gates read only ids, so `EligibilityFacts.subject`/`actor` are `Pick<GuildMember, 'id'>`, and `startButtonRun` takes `subject` as `{ id, resolve }` (`ButtonRunSubject`): the gates judge the id, and `resolve` (`memberOrLeaver`) runs only on the run path, after `deferUpdate`. Fetching first put up to two Discord calls (a leaver's) ahead of the three-second acknowledgement, paid them on answers that start nothing, and turned a failed fetch into the registry's generic error with the presser's waits unwoken. A failed fetch now logs the ids and follows up with the run-failed sentence. Found in review.
- **Decision 6 also covers the listener moving.** A live listener moved out of its poster's journey (attach, group) is cut off as silently as a moved poster: readiness flags it on its next read, presses answer "Nothing's hooked up". Not built.
- **Only cards that can name a post carry `blockMessages`** (a `messageButton` field): the posts change on every keystroke in a posting block's message, and every other card would re-render for nothing.
- **TestDiscord models an ephemeral follow-up** (`POST /webhooks/:appId/:token`, after the press was acknowledged), so the press test can hear the run-failed sentence.
- **The ticket case of the press test presses a twin.** TestDiscord refuses a press in a channel holding permission overwrites (`refuseOverwritesFor`: how Discord applies them to an interaction is not modelled), and a ticket channel always holds them. Open Ticket runs for real and writes its record; the presses land on a twin message in a plain channel carrying that record's flow, node, subject, ticket and ticket channel.

Not run live.
