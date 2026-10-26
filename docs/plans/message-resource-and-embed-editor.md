# A posted message is a journey resource

> **Status**: Design agreed 2026-10-23. Step 1 built 2026-10-24, live run pending ([message-editor-step-1.md](message-editor-step-1.md)). Step 2 built 2026-10-25, live run pending ([message-resource-step-2.md](message-resource-step-2.md)). Step 3 built 2026-10-25, uncommitted, live run pending ([message-resource-step-3.md](message-resource-step-3.md)).
> **Owner**: Douglas
> **PRD**: `docs/prds/flow-engine-v2-journeys-and-provisioning.md` §5.7 (resources a journey declares). Also serves its open follow-up *a journey can set up the ticket system*, whose panel is a posted message
> **Reverses**: [shared-binding-table.md](shared-binding-table.md):29, for designed messages only (below)

## The gap

A server wants a message to *stay* in a channel: a welcome embed in `#verify` with a header, an image, some fields, and a button that opens a verification ticket. (Example, not scope.)

None of today's pieces can do it:

- **Post Embed** can design an embed, but it is a step inside a run, so it posts a new copy every time the flow runs.
- **Button Click + Deploy** keeps a message in a channel, but that message is only the flow's name in bold with the buttons under it (`deployFlowButtons.ts:180`). It cannot carry an embed.
- **A Button Click owns its button.** The button's hidden id names one flow and one trigger (`customId.ts:13`, `flowTriggerDispatch.ts:33`). The trigger can make a new button and can never listen to one that already exists. Two flows with a button in `#verify` post two separate messages.

## Decisions

From Douglas (2026-10-23):

- **The editor copies MEE6.** The embed is drawn as Discord will show it, and you click a part to edit it: header and its icon, title, body, fields, thumbnail, image, footer and its icon. Each embed has a colour, duplicate and delete, and there is an "Add embed" button underneath. One message holds several embeds.
- **A posted message is a journey resource**, alongside channels, categories, roles and ticket types. Install posts it, the dashboard reports when it has changed, repair puts it back, and uninstall deletes it.
- **Buttons are inside flows.** The message defines what its buttons look like, and a Button Click trigger in a flow listens to one of them.
- **Images can be uploaded**, not only linked. MEE6 takes only a link; the difference is deliberate.
- **One flow per button.** If a second trigger points at a button that already has one, saving is refused, and the refusal names the flow that has it.
- **This reverses a call from 2026-10-10.** [shared-binding-table.md](shared-binding-table.md):29 says the messages the bot posts are not setup it owns. A *designed* message now is. The ticket panel, ticket channels, wait messages and Ask a Question's messages stay as they were.
- **Today's Button Click + Deploy is converted, not kept beside it.** There is one way to put a button in a channel.

My picks, which Douglas agreed to (2026-10-23):

- **Making a button from the flow is still one step.** The trigger's panel offers "+ New button on this message" and "+ New message in #channel". These write the button into the message resource. A trigger can be pointed at a button that already exists, or create a new one, and either way the button is defined in one place.
- **A message lives in a declared channel.** Its parent is a `textChannel` resource of the same journey. To use an existing `#verify`, declare it and adopt it, which is already how a journey uses an existing channel. A new parent rule: a message's parent is a text channel, and only a message can have one.
- **A message can't be adopted.** The bot can only edit what it posted itself, so install always posts its own.
- **Editing a message in the builder doesn't change Discord until you repair.** It shows as "out of date", and repair edits the message in place, so it keeps its spot in the channel. This is the rule Douglas set for renaming a channel in the panel (PRD :321).
- **A deleted message is reposted by install, not by repair.** This keeps today's split: a missing resource goes to install's `create`, with the reason "no longer exists" (`installPlan.ts:441`). Drift is only about objects that still exist.
- **A button nobody listens to** answers a press with "Nothing's hooked up to this yet", and install notes it on the item.

## The model

### The resource

A new kind, `message`, in `RESOURCE_KINDS`. It is a Discord object, but it lives inside a channel and is not in the guild's cache. Its declaration carries:

| Part | Limit (Discord's) |
|---|---|
| `content`: plain text above the embeds, optional | 2000 characters |
| `embeds`: up to 10. Each has Post Embed's parts plus a header icon and a footer icon | 6000 characters across all of them |
| `buttons`: `{ key, label, style }` | 25, in rows of 5; label 80 characters |

A button's `key` is its identity, the same way a resource's key is. A trigger names it, and renaming the label changes nothing that listens to it.

### Its binding

`resource_bindings.discord_id` holds the **message id**. The channel comes from the parent's binding, so one column still holds one id. If the channel is recreated, the message went with it, and install posts a new one.

Every existence check today reads the guild's cache (`existsInGuildAs`, `readLiveResource`). Messages need a `channel.messages.fetch(id)` each. That cost is new, and paid only on install, drift checks and uninstall, never per click.

Crash recovery matches by name (`findInterruptedCreates`), and a message has no name. As with ticket types, there is no recovery: a crash between posting and recording can leave one stray message. That is the outcome Douglas accepted for tickets.

### The button's hidden id

It names the **button**, not the trigger: a new prefix followed by the button's key. The message id arrives with the click (`interaction.message.id`), so the id never has to fit a journey key and a resource key into Discord's 100 characters. A click goes:

1. message id → binding → journey and message key;
2. → the one trigger in that journey's flows listening to that button;
3. → that trigger's "who can press it" rule, then the run. This part is unchanged.

Provisioning renders the buttons and must not import flows (`dependencyDirection.test.ts`). The prefix therefore belongs to provisioning, and flows registers the handler for it.

### Install, drift, repair, uninstall

| Stage | For a message |
|---|---|
| Install | Post it if there's no binding or the message is gone. Otherwise reuse it. Ordered after its channel, which `orderResourcesForApply` already does through `parentKey` |
| Drift | A new kind, `outOfDate`: what is posted no longer matches the declaration. Step 2 decides how to compare, either with the live message or with a fingerprint stored when it was posted, depending on whether Discord's normalising of URLs and colours makes the live comparison unreliable |
| Repair | `message.edit`. Nothing edits a posted message in place today; deploy retires and reposts |
| Uninstall | Delete it. Messages go first in `KIND_ORDER`, before the text channels they sit in |

### The editor

A new config control. Post Embed uses it first, and the message resource's panel uses it after. It opens in its own large window, because the flow builder's side panel is too narrow to draw an embed. Mockup: [message-editor.mockup.html](../../nimbalyst-local/mockups/message-editor.mockup.html).

### Uploaded images

Every picture part (header icon, thumbnail, image, footer icon) takes one of three things: an **upload**, a **link**, or a **token** like `{{subject.avatarUrl}}`.

- **The bot keeps the file and attaches it to the message.** The embed points at `attachment://<name>`, and Discord hosts the picture as part of that message. This avoids two problems with the alternatives:
  - Serving the image publicly from the dashboard would put a new unauthenticated path on the public internet.
  - Uploading it to Discord once and reusing that link doesn't last, because Discord's attachment links expire.
- **Uploads are kept per server, in the database**, and the picture box offers the ones already uploaded so one can be reused. One home on both database types, and it's backed up with everything else. Postgres and SQLite store bytes differently, and CI only runs SQLite, so step 1 runs the upload against a live Postgres too.
- **The file is checked by its contents, not its name.** Only PNG, JPG, GIF and WebP are accepted.
- **Size.** Discord limits how much one message may upload in total, and a message can carry up to 40 pictures (10 embeds × 4). Step 1's plan sets the per-image cap and refuses, at save, a message whose uploads together are over Discord's limit.
- **The upload route is an exception to the 1 MiB body cap** every `/api` route has. It's placed in the rate limiter's Discord-free group, since it never calls Discord.
- **The dashboard shows an upload through a signed-in route**, used by the editor and its preview. Nothing outside the dashboard can read it.
- **Not in step 1:** deleting an upload. One still used by a flow or message would have to be refused, naming who uses it, and that is its own small step.

## Steps

One at a time. Each is planned against the code as it stands when it starts.

1. **The editor, on Post Embed.** Post Embed gains plain text above, several embeds, the header and footer icons, and uploaded images, all edited in the MEE6-style window. Existing Post Embed nodes keep working; the step's plan decides whether by a data migration or by the schema reading the old shape. Useful on its own. **Built 2026-10-24, live run pending** ([message-editor-step-1.md](message-editor-step-1.md)): by a data migration, since the schema could not read the old shape (see that plan). Where the build departs from this design is under "Step 1 as built" below.
2. **The message resource.** Declare it in Resources with the editor, and give it buttons. Install posts it, install reposts it if deleted, repair edits it, uninstall deletes it. A button press answers "Nothing's hooked up to this yet" until step 3. **Built 2026-10-25, live run pending** ([message-resource-step-2.md](message-resource-step-2.md)). Where the build departs from this design is under "Step 2 as built" below.
3. **Button Click listens to a message's button.** Covers the trigger's message and button picker, the inline "+ New button" / "+ New message", the one-flow-per-button refusal, and the new click routing. Today's triggers and their deployed messages are converted. Deploy, `/flow-deploy` and `flow_button_messages` are retired. The step's plan decides how a message posted under the old ids changes over without its buttons going dead. **Built 2026-10-25, live run pending** ([message-resource-step-3.md](message-resource-step-3.md)): posted messages are adopted by a data migration, and their old buttons answer through a `flow:` bridge until each is repaired. `flow_button_messages` goes in the bridge-removal deploy that follows. Where the build departs from this design is under "Step 3 as built" below.

## Step 1 as built

Built 2026-10-24; the live run on an unboosted guild is pending (the checklist is in [message-editor-step-1.md](message-editor-step-1.md)). Where it departs from, or settles, what this design said:

- **Where it lives.** The message model is in `src/shared/discordMessage/` and the uploads in `src/features-system/guild-uploads/`, outside flows, so step 2's provisioning can use both without importing flows. Step 2's declaration is to hold the same `message` object, and its install and repair are to send it with the same `buildMessagePayload`.
- **Size caps.** The design left them to the plan, and counted up to 40 pictures a message. As built:
  - 8 MiB a picture, also the upload route's body cap.
  - At most **10 distinct uploads a message**, Discord's file limit for one message. An upload shown twice is attached once, and links don't count.
  - 10 MiB of uploads a message, a working guess (`MESSAGE_LIMITS.uploadBytes`) until the live run measures Discord's real limit.
  - These are judged at save, as readiness issues, and again by the run.
- **Uploads per server**: deduplicated by SHA-256, and capped at 200 MiB a server. There is still no delete, so a server at the cap can't add pictures until the delete step.
- **The signed-in picture route is cacheable.** An upload's bytes never change, so it answers `private, max-age=31536000, immutable`; every other `/api` answer stays `no-store`. The editor loads it with `<img src>` and the cookie, not the SDK, so a session that runs out mid-edit shows a broken picture rather than the sign-in panel.
- **The upload is raw bytes** (`application/octet-stream`, which a cross-site form can't send), not multipart, and must declare its length.
- **Plain text pings users** (`allowedMentions: { parse: ['users'] }`). Post Embed used to ping nobody, because an embed can't ping.
- **Rules the design didn't name**:
  - The 6000 characters are judged at save, counting only the text outside `{{tokens}}`, and again once rendered.
  - A picture's token must come out as an http(s) link; an `upload:<id>` read from a variable is refused, never attached.
  - A title link must parse as a URL.
- **A builder tab older than the deploy is refused on save** ("Reload the page, then save again"), because it would strip the migrated message. This is a one-deploy bridge (`src/web/api/staleBuilderGraph.ts`), to be removed in a later deploy. `FLOW_GRAPH_VERSION` was not bumped, because it is checked on every read of a stored graph.
- **The window edits the node live**, and Cancel puts back the message as it was when the window opened.

## Step 2 as built

Built 2026-10-25; the live run is pending (the checklist is in [message-resource-step-2.md](message-resource-step-2.md), "The live run", and includes all of step 1's). Where it departs from, or settles, what this design said:

- **`message` is a resource kind but not a Discord resource kind.** It joins `RESOURCE_KINDS`, not `DISCORD_RESOURCE_KINDS`: every helper typed by the latter reads the guild cache or runs the name match and the intent lifecycle, none of which fits a message.
- **The binding stores the channel and a fingerprint** (`message_channel_id`, `message_digest`), not "the channel from the parent's binding" (:55). Uninstall works from binding rows alone, with no declaration, so a message row has to know its own channel.
- **Drift compares a fingerprint, not the live message** (:76). Only the bot can edit its own post, so the only drift is the declaration moving on. The fingerprint is a SHA-256 of key-sorted JSON, because Postgres `jsonb` reorders keys.
- **Every existence check fetches the message** (:57), once per plan, with `force`. A message the bot can't read blocks install and uninstall, and drift lists it as unchecked, neither clean nor drifted.
- **No tokens at all in a resource message**, `{{guild.name}}` included. A posted sign has no run to render them against.
- **A resource message pings nobody**, unlike Post Embed's plain text.
- **Its channel is fixed once installed.** Discord can't move a message: install refuses a changed channel rather than reposting, and the dashboard locks the picker.
- **An announcement channel counts as a text channel** for a message, since a Community server converts its `#rules` channel into one.
- **The button prefix is `mbtn:<buttonKey>`**, owned by provisioning; flows registers the one handler, which in step 2 only answers the sentence. Discord's button constants moved to `src/shared/discordButtons.ts` so both can use them.
- **The dashboard holds the autosave on a browser copy of the save rules**, so a message refusable mid-edit (a fresh empty embed, a half-typed link) is not sent and reverted. This holds the whole Resources list while it lasts, and a red chip says why.
- **The window has no colour presets** in a resource message: the swatches are Post Embed's field config.

## Step 3 as built

Built 2026-10-25, uncommitted; the live run is pending (the checklist is in [message-resource-step-3.md](message-resource-step-3.md), "The live run", and includes steps 1 and 2's). Where it departs from, or settles, what this design said:

- **Saving isn't refused.** Every graph save is stored, so one flow per button is checked at go-live and when a flow is grouped, naming the flow that has the button. The picker greys a taken button, so an author rarely meets the refusal.
- **A trigger listens only to a message its own journey declares**, by bare keys (`button: { messageKey, buttonKey }`). A flow moved to another journey loses its button, and readiness says so.
- **Posted messages are adopted, not reposted.** The migration records each as the bot's own (`created`, so uninstall deletes it) and merges flows that posted into one channel into one journey. Each converted journey then goes Install, Drift, Repair, and keeps its message's id and place. Until the repair, its `flow:` buttons answer through a bridge that logs every press. A trigger no `flow_button_messages` row names (never posted, or posted before the table existed on 2026-09-20) is emptied; a press on such an old button answers "This button's been retired — ask a mod to repost it."
- **Resource saves carry a version.** The builder now saves Resources through the journey, which another flow may share, so both resource PUTs carry the version the browser loaded and answer 409 "reload" once it has moved on.
- **A listened button's key is locked** in the message window, and removing a listened button, message or channel asks first. The server doesn't refuse such an edit; the repair preview names the flows it would cut off.
- **Who listens** is shown under each button in the window and in a note at install naming the buttons nobody listens to.

## Not in this

- **Reaction Add pointing at a message resource**, which is MEE6's reaction roles. Today it takes a pasted message id (`triggerReactionAdd/index.ts:37`). This is the natural follow-on.
- **Dropdown menus on a message.** The interaction registry routes only slash commands, modals and buttons.
- **The ticket panel as a message resource.** It would use this, but setting up the ticket system is its own follow-up (PRD §5.7).
