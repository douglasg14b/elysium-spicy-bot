# Send Message takes over Post Embed

Douglas, 2026-10-31: "send a message and then also add an embed … within the same message", and
Send Message's text box should offer `@role` like the embed editor does. Post Embed already
sends plain text plus up to ten embeds as one message, with buttons. His call: **merge the two
into Send Message**, and embeds stay optional — text alone, embeds alone, or both.

Two steps. This file plans step 1; step 2 is named at the end and planned once step 1 is in.

## Step 1 — one block

### The block

`action.sendMessage` keeps its type, label (Send Message), icon and its `where` / `channelId` /
`ephemeral` fields. Its `message` becomes Post Embed's: `messageConfigSchema`, edited by the
`message` control, with `buttons` as its `buttonsKey` (optional). Capabilities become Post
Embed's (`sendMessages`, `embedLinks`, `attachFiles`); only `manageRoles` is read by code today. The
description is rewritten in the bot's voice to say text, embeds, or both.

**Ephemeral and buttons are refused together at save**: a `superRefine` issue on `buttons`
("Buttons can't go on a message only the clicker sees — untick that, or drop the buttons", in
voice). Nobody asked for a private message with buttons, and its press routing was never
exercised.

**Text first.** A fresh message opens as an empty embed today (`startingMessage` in
`messageDraft.ts`); Douglas's condition was that a plain message stays first-class, so a fresh
message opens with no embed — the plain-text part ready to type into, embeds added on purpose.
This changes the start for every `message` field (Open Ticket, journey message resources);
acceptable, and named in the summary to him.

`run`:

- Judge the rendered message first (`trimMessageText`, `renderedMessageIssue`), as Post Embed does.
- `ephemeral` on: the same `interaction` regression throw as now, then
  `messageWithButtons(...)` (no buttons — refused at save) and
  `interaction.followUp({ ...ready.options, ephemeral: true })`.
- Otherwise exactly Post Embed's run: `channelFor`, `messageWithButtons`, `channel.send`,
  `recordPostedMessage`.
- `allowedMentions: { parse: ['users'] }` on both paths (`messageWithButtons` already sets it).

`blocks/actionPostEmbed/` is deleted. Every import of `ACTION_POST_EMBED` moves to
`ACTION_SEND_MESSAGE`; `postEmbedRun.test.ts` and `web/e2e/postEmbedMessage.test.tsx` become
Send Message tests (rename them), keeping every case. The ephemeral tests move to the new
message shape.

### The migration

`2026-10-31-Send_Message_Takes_Post_Embed`, modelled on `2026-10-24-Post_Embed_Message_Shape`
(same graph tables — `flows.graph`, `flow_drafts.graph` — same dual-dialect arms, same
camelCase/string tolerance, frozen constants, sqlite arm in its own transaction). Up, per node:

- `action.postEmbed` → type `action.sendMessage`, data untouched.
- `action.sendMessage` whose `message` is a string → `message: { content: <string>, embeds: [] }`
  (an empty string becomes a message with neither, for the server to name). A node whose
  `message` is already an object is left alone.

Down: a Send Message node whose message is content only (no embeds, no buttons, no uploads)
goes back to a string; any other becomes `action.postEmbed` and loses `ephemeral`. Lossy,
documented.

Parked runs hold only ids and Send Message cannot park, so nothing else holds this config.
Node ids do not change, so `flow_posted_messages` and Button Click's `{ flowId, nodeId,
buttonKey }` keep pointing at the same posts.

Must be run against the Docker Postgres as well as sqlite (`production-runs-postgres`).

### The stale-tab bridge

A stored node of an unknown type is a readiness issue on its flow (`validateNodeData`), not a
failure of the guild's list, so a row the migration missed is loud but contained.

`src/web/api/staleBuilderGraph.ts` refuses, with its existing sentence, a save carrying an
`action.postEmbed` node or an `action.sendMessage` whose `message` is a string. Its key-based
`Reshape` needs a per-block predicate for this; keep the existing two entries' behaviour.
`DECLARED_BLOCK_DEPENDENTS` in `blockTypeBranching.test.ts` follows. The bridge and the older
migrations' tests import `ACTION_POST_EMBED` from the block being deleted: each takes the
literal `'action.postEmbed'` as a frozen copy — never a re-export of the constant from
somewhere new.

### Elsewhere

- `pnpm sdk:generate` (block field rules change).
- Seeds, templates and the e2e preview scenario (`seedMessageEditor.ts`) that build either node.
- Every test fixture building a Send Message with a string `message`, and every user-facing
  sentence naming Post Embed (`ResourcesPanel.tsx`, `UploadUses.tsx`, `buttonListeners.ts`,
  `messageResourceProblems.ts`, `convergingTriggers.ts`, …).
- `docs/contracts/block-authoring.md` and `AGENTS.md`: Post Embed becomes Send Message wherever
  it is named as a poster of `message`; add the migration to the bridge-removal list.

### Done when

Suite green against the quiet baseline; migration up/down tested on sqlite and run once on
Docker Postgres; a Send Message with text only, embed only and both posts in the e2e harness;
ephemeral with an embed follows up.

## Step 2 — `#channel` mentions, and mentions in more boxes

Douglas, 2026-10-31: mention channels the way roles are, shown as the channel's name rather
than its id; and the `@role` / `#channel` box in Ask a Question's and Open Ticket's text too —
not Send DM.

### Channels in the message editor

- In every part where `showsMentions` is true, `#` lists the server's **text** channels
  (`GuildChannel.type === 'text'`, sorted as the channel picker sorts them, category name as a
  muted hint); a pick is stored as `<#id>` and shown as `#name` while typing and on the stage,
  in Discord's mention blurple. A `<#id>` the list does not hold reads `#unknown-channel`.
- One box with two triggers: `RoleMentionTextarea` becomes a mention textarea taking roles and
  channels (two react-mentions `Mention` children, `@` and `#`). `roleMentions.ts` gains its
  channel twin (markup, digits-only pattern so `<#{{var.x}}>` stays a token, label, style);
  `CopyText` draws channel segments beside role ones. Rename files only if the name would lie.
- The channels reach `EditorScope` from `ControlContext.channels` (`MessageControl.tsx`) and
  from wherever `ResourcesPanel.tsx` gets its roles for the journey message editor.
- Nothing changes server-side: `<#id>` is posted as written; channel mentions never ping.

### Mentions in long text boxes

- A `longText` field may declare `showsMentions: true` (manifest field type, conformance, the
  wire schema in `nodeBody.ts`, `pnpm sdk:generate`). Declared on Ask a Question's `question`
  and Open Ticket's `reason` only — first confirm each lands where Discord renders mentions
  (an embed description or field value, or plain content); if one does not, stop and say so.
- The inspector's `longText` control draws the same mention box for such a field, styled as the
  inspector's textarea (not the Discord stage), roles from `ControlContext.roles` plus
  `managedRoles` as the message editor merges them, channels from `ControlContext.channels`.
  Its token preview (`CopyPreview`) draws mentions by name too.

### Done when

`@` and `#` both work in the message editor and in those two boxes, verified in jsdom
(react-mentions needs `fireEvent.keyDown(box, { key, keyCode })`) and once in real Chrome via
`pnpm preview:dashboard` + `preview:shoot`; Send DM's box is unchanged.
