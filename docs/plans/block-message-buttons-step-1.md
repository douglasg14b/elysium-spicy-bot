# A block's message carries buttons; Open Ticket posts one (step 1)

> **Status**: Built 2026-10-27, uncommitted; suite green bar the known baseline, migration run on SQLite and on a throwaway Postgres 16. Not run live — see "After this step". Deviations under "As built".
> **Owner**: Douglas
> **Follows**: [message-resource-step-3.md](message-resource-step-3.md) (Button Click listens to a journey message's button) and [button-emoji.md](button-emoji.md).
> **Next**: step 2 — Button Click listens to a block's button; step 3 — a "Who" field on the blocks that act on a member. Each gets its own plan once the one before has run.

## Where this is going (Douglas, 2026-10-26)

- Anywhere a flow can make an embed, it can make buttons under it. Open Ticket gets an embed, posted in the ticket channel above the ticket card.
- Button Click can react to a button from a journey message **or** from one of those blocks. Every press starts a **new** run.
- A press run is **about** whoever the posting run was about (for a ticket, its subject), and the presser is who **acted**. "Who can press it" already exists on the trigger.
- Blocks that act on a member get a "Who" field: the member this run is about (default) or whoever acted.
- No extra buttons on the ticket card itself (scrapped).

This plan is step 1 only.

## The gap

- Post Embed posts a message, but no buttons (`actionPostEmbed/index.ts`).
- Open Ticket posts only the ticket card (`actionOpenTicket/index.ts:167-172`); a flow can't put its own embed in the ticket channel.
- Buttons exist only on a journey's message resource (`provisioning/logic/messageButtons.ts`), and the message window already draws and edits them (`web/src/flows/messageEditor/ButtonRow.tsx`, `MessageEditor`'s `buttons` prop). `MessageControl` just doesn't pass any.

## What step 1 does

1. **A `message` field can carry buttons.** The field declares `buttonsKey: 'buttons'`, a sibling config key holding `MessageButton[]` (up to 25, five to a row). The sidecar precedent: the pickers' `<field>Key`, read through `ControlProps.config` and written through `ControlContext.setConfigKey`.
   - `MessageControl` passes `buttons` to `MessageEditor` when the field declares a `buttonsKey`, with `listeners: []` (nobody can listen until step 2) and the page's `serverEmojis`.
   - `setConfigKey` widens to take a button list.
   - Conformance: a `message` field's `buttonsKey` must name a schema key whose schema takes a button list (probed, as `controlShapeProbes` does); a key covered this way needs no field of its own.
2. **Post Embed** gains `buttons` (optional; absent or empty = no buttons).
3. **Open Ticket** gains an optional `message` and `buttons`. The message is posted in the ticket channel **before** the ticket card. Leaving it empty posts nothing extra.
4. **Buttons render with `mbtn:<buttonKey>`**, through provisioning's `buildButtonRows` and `serverEmojiIds`. A press goes to the existing handler, finds no journey binding, and answers "Nothing's hooked up to this yet" — right for step 1.
5. **Every post that carries buttons is recorded** (see Decisions, 4), so step 2 can route presses on messages posted from step 1 onward.

## Where the design is wrong against the code

1. **"Buttons with no text and no embed" is not allowed.** I told Douglas it was. `messageProblems` refuses an empty message, and a journey message follows the same rule; consistency wins. Buttons need a message to sit under: a block with buttons and no message is refused at save.
2. **The run has no flow id.** `FlowRunContext` carries `runId` and `nodeId` (`blocks/types.ts`). The record needs the flow; the executor knows it, so it goes on the context (or is read from the run — the implementer picks the smaller change and says which).

## Decisions

1. **Buttons are a sibling key, not part of the message value.** `DiscordMessage`, `buildMessagePayload`, the `message` control's shape probe and the journey declaration all keep message and buttons apart; folding buttons into the message would change the shared shape both sides use.
2. **One button rule set.** The button-only rules in `messageResourceProblems.ts` — a label or an emoji, an emoji that is one, unique keys, no `{{tokens}}` in a label — move into one function both the journey message and the block's button schema ask. A block's labels take no tokens either: the executor's copy rendering never sees a sibling key, so a token would post literally. The block's button schema refines with those rules; like `messageConfigSchema`, the refinement stays out of the field-rule export and the server's re-check carries the sentences.
3. **In scope: Post Embed and Open Ticket.** Out: Ask a Question (its buttons are `flowc:` answers that resume the run — a different thing), anything posting to a DM (the `mbtn:` handler refuses outside a server), Send Message (plain text, no message control).
4. **A record per post with buttons, written in step 1.** A block's message has no binding, is never reposted, and its customId can't carry the flow, node and subject in 100 characters. Without a record written at post time, every message posted before step 2 would have buttons that stay deaf forever. New table `flow_posted_messages`: `message_id` (primary key), `guild_id`, `channel_id`, `flow_id`, `node_id`, `run_id`, `subject_id` (nullable — a run about nobody), `ticket_id` (nullable — Open Ticket only), `posted_at`. Written after the send succeeds; a failed write is logged, not thrown (the message is posted and the flow did its job; its buttons will answer "Nothing's hooked up"). Messages without buttons are not recorded. Migration run on SQLite and on a real Postgres.
5. **Open Ticket's order:**
   1. Render and judge the message (the same checks Post Embed makes) and read its uploads **before** `openTicket`. A bad message allocates no number, makes no row and no channel.
   2. Open the ticket, make and attach the channel (unchanged).
   3. Post the flow's message (with `allowedMentions: { parse: ['users'] }`), then the ticket card. `recordTicketStateMessage` gets the **card's** id; only the card is pinned.
   4. The flow's message lands before the `opened` announcement, so a Ticket Event flow's post goes under it.
   - A send failure after the channel exists leaves the same half-made ticket a failed card send already can (no state message, no announcement). Not papered over.
6. **Shared posting helper.** Post Embed's rendered-message check, uploads read and payload build move to one helper in `blocks/`, used by both blocks, with the buttons added to the payload's `components`.
7. **A message posted keeps its buttons.** Editing the block later changes later posts only.

## Tests

- Open Ticket (`blocks/actionOpenTicket/__tests__/`, none exist yet): its message is sent before the card; the state message id recorded is the card's; a message that can't post fails with no ticket row; no message posts nothing extra; a post with buttons writes its record.
- Post Embed: buttons render as `mbtn:` rows; a post with buttons writes its record, one without doesn't.
- The shared button rules: both the journey message and the block schema refuse the same buttons with the same sentences.
- Conformance: a `buttonsKey` naming a missing key, or a key whose schema refuses a button list, is refused.
- Each new guard sabotage-verified.

## After this step

Run it on a real server: a flow that opens a ticket with an embed and two buttons, a Post Embed with buttons, a press on each (expect "Nothing's hooked up to this yet"), and the records in the table. Then plan step 2.

## As built (2026-10-27)

Where it differs from the above, and why:

1. **The record lives in `flows/logic/`, not `flows/data/`.** `flowPostedMessagesSchema.ts` and `flowPostedMessagesRepo.ts` sit beside `recordPostedMessage.ts` in `logic/`: the table has a `ticketId` member, and `ticket` is a proven rejection of the engine vocabulary gate, which reads every declaration under `data/` — the reason `logic/ticketEventDispatch.ts` is not under `engine/`. Columns and migration as Decision 4 says (`2026-10-27-Flow_Posted_Messages`), keyed by `message_id`, no other index.
2. **Flow id: on the context.** `FlowRunContext.flowId`, set by the executor beside `runId` — one line there; the run row cannot help, since a run that never parks has none. Every hand-built context in the tests gained the field.
3. **One button rule set, with one changed sentence and one changed order.** `messageButtonProblems` (provisioning) is the rule set; the journey message asks it after its message checks, so a journey's problems now come message (schema, then tokens) first, buttons after — the browser mirror follows, and its drift table passed unchanged. A token in a button's label now says "No tokens here — a button's label goes out exactly as typed, braces and all. Spell it out." for both kinds; the old sentence ("…sits in its channel for everyone…") was untrue of a block's message.
4. **The block's button schema is provisioning's** (`logic/messageButtonSchema.ts`, `messageButtonsConfigSchema`): a plain-zod copy of the wire's `MessageButton`, both worded from one set of sentence constants (`MESSAGE_BUTTON_RULE_SENTENCES`, which `journeyBody.ts` now imports — the spec did not change). The spanning rules run through a pipe, only once every button's own fields pass, as the journey route asks them only after its schema: zod otherwise refuses a blank label twice. `messageButtonRules.test.ts` holds the two to the same refusals, sentence for sentence.
5. **Open Ticket's order**: the ticketing checks it always made, then the message judged and its uploads read, then `openTicket`. Gains `attachFiles`.
6. **Two places that had to learn the sidecar**, beyond conformance: a save keeps a field's `buttonsKey` (`withDeclaredNodeData`), which would otherwise have stripped every button; and the builder's `fieldOwning` counts a buttons edit as an edit to the message.
7. **Vocabulary**: `mentions` and `style` (discord.js keys in object literals) joined the gate's generic list. The shared helper is `blocks/messageWithButtons.ts` (`renderedMessageIssue`, `messageWithButtons`).
8. **Test support**: `fakeGuild` now has an (empty) emoji cache, which every post with buttons reads.
9. **After review**: the `buttonsKey` gate also requires the key optional and undefaulted, refuses a list that lets two buttons share a key (the shared rules skipped), and refuses two message fields on one key. The browser keeps only stored buttons it can draw (one of the four styles; a string label, an emoji object).

Review findings left for Douglas: a failed send of Open Ticket's own message still leaves the half-made ticket Decision 5 accepts (the reviewer would catch it, post the card anyway and fail the run — a change to that decision); `ticket_id` alone puts the record in `logic/`, so either `.claude/rules/data-persistence.md` gains the exception or step 2 derives the ticket from `channel_id` and the files move to `data/`; the button schema is written twice (plain zod and the wire's hono zod) rather than rebuilt from `.shape`; send and record are two calls per block; the table has no pruning.

Known gaps, not addressed:

- A button's problem from the server's re-check shows at the node's level in the inspector (`buttons.1: …`), not on the button in the window.
- Open Ticket's message, once written, can be emptied but not removed: an emptied message is refused at save, so the way back is undo. A "remove message" for an optional `message` field would close it.
- A `message` field hidden by `visibleWhen` would not hide its buttons from the parse. No block does that.
