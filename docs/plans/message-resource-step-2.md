# The message resource (step 2)

> **Status**: Built 2026-10-25; live run pending. Planned 2026-10-24, and Douglas approved building it ("build it"). The picks below marked **Douglas?** are the ones most likely to be his call; they are built as written unless he says otherwise. What the build decided beyond the plan is under "As built", at the end.
> **Owner**: Douglas
> **Design**: [message-resource-and-embed-editor.md](message-resource-and-embed-editor.md), step 2. Mockup: [message-editor.mockup.html](../../nimbalyst-local/mockups/message-editor.mockup.html), section 3.
> **Follows**: [message-editor-step-1.md](message-editor-step-1.md) (the message model, the window, the uploads) and [uploads-page.md](uploads-page.md) (the usage reader).
> **Next**: step 3 (Button Click listens to a message's button). It gets its own plan. This plan only names the places step 3 picks up.

## The gap

A journey can declare channels, categories, roles and ticket types. It can't declare a message.
- Post Embed posts a new copy every run (`actionPostEmbed/index.ts:174`).
- Deploy posts only the flow's name in bold, with buttons under it (`deployFlowButtons.ts:180`).

Step 1 built three things: the model (`src/shared/discordMessage/`), the window (`web/src/flows/messageEditor/`) and the uploads. Nothing in provisioning knows a message exists, and nothing in the repo edits a posted message in place.

## What step 2 does

- **Resources gains "Message".**
  - Its parent is one of the journey's text channels.
  - It holds a `DiscordMessage` and up to 25 buttons (key, label, style).
  - It is edited in the step-1 window, with a row of buttons under the embeds.
- **Install posts it** after its channel. If the posted message is gone, install posts it again ("no longer exists").
- **Drift reports "out of date"** when the declaration has changed since the message was posted. **Repair edits it in place.**
- **Uninstall deletes it**, before the channel it sits in.
- **Pressing a button answers "Nothing's hooked up to this yet."** Install says so on the item.
- **The Uploads page** counts a journey's message as a use, and refuses to delete a picture the message shows.

There are no new API routes; only schemas widen (`ResourceKind`, `ResourceDeclaration`, `RESOURCE_DRIFT_KINDS`, `UploadUse`). So `rateLimitClassification` and `everyRouteInSpec` have nothing new to place.

## Where the design doc is wrong against the code

1. **"The channel comes from the parent's binding" (design :55).** Uninstall works from binding rows alone, with no declaration:
   - `previewUnpublish` takes only a key (`provisioningService.ts:173-190`).
   - `buildUnpublishPlan` notes that bindings carry no `parentKey` and outlive the journey row (`unpublishPlan.ts:109-127`).

   So a message row couldn't find its channel, and it couldn't after its parent key changes either. **The binding stores the channel id the message was posted in.**
2. **"Every existence check reads the guild's cache" (design :57).** This is true of `existsInGuildAs` (`installPlan.ts:193`) and `readLiveResource` (`journeyDriftPlan.ts:308`). For a message, the precedent to copy is `lookupBoundChannel` (`lookupBoundChannel.ts:38`): fetch, answer `gone` only on Discord's own "unknown" error, and throw on anything else.
3. **"No crash recovery" (design :59)** means the ticket-type path: post, then write the row with `upsertBinding` (`resourceBindingsRepo.ts:319`). It doesn't mean the intent path (`recordIntent` → create → `settle`). An intent row for a message would only add branches that can never recover anything.
4. **"Messages go first in `KIND_ORDER`" (design :78)** holds only if `isAlreadyGone` (`discordErrors.ts:29-32`) also counts 10008 Unknown Message. If a message is deleted by hand between plan and apply, Discord answers 10008, which today would be reported as a failure.
5. **Drift (design :76) left the comparison open, but the answer is clear.** Only a message's author can edit it, so nobody but the bot can change what is posted. Drift therefore only ever means "the declaration has moved on".
   - A fingerprint stored at post time is exact.
   - A live comparison would only add noise from Discord's normalising: `attachment://` comes back as a CDN link, and colours and links are rewritten.
6. **Step 1's "As built" says install and repair reuse `buildMessagePayload`.** They can. But Post Embed's upload read (`readUploads`, `actionPostEmbed/index.ts:93-114`) lives in flows, which provisioning may not import, so it moves to `guild-uploads`.

## Decisions

From the design (Douglas, 2026-10-23):
- a message is a journey resource;
- its parent is a declared text channel, and only a message has one;
- it can't be adopted;
- editing it doesn't touch Discord until repair;
- a deleted message is reposted by install;
- a button nobody listens to answers "Nothing's hooked up to this yet", and install says so;
- the button prefix belongs to provisioning, and flows registers the handler.

My picks:

1. **`message` joins `RESOURCE_KINDS`, not `DISCORD_RESOURCE_KINDS`** (`resourceDeclaration.ts:16,37`).
   - Every helper typed `DiscordResourceKind` either reads the guild cache synchronously or runs the name match and the intent lifecycle. None of that fits a message.
   - The ownership fences stay right as they are, because a message can't be adopted or claimed by a second owner (`heldByNoOtherOwner` `resourceBindingsRepo.ts:484`, `loadGuildOwnership` `provisioningService.ts:117`, `ownerOf` `bindingOwner.ts:56`).
   - The wire's `DiscordResourceKind` and `web/src/flows/contractValues.ts` also stay as they are. The browser uses that list to reach for the channel and role directories, which it must never do for a message.
   - The type's doc comment changes from "objects in the Discord guild" to "objects in the guild's cache, which can be adopted and owned".
2. **The binding stores `message_channel_id` and `message_digest`.** These are two nullable text columns on `resource_bindings`, used only when `kind = 'message'` (correction 1).
3. **Drift compares a fingerprint, stored when the message is posted and after each repair.**
   - It is a SHA-256 of sorted-key JSON of `{ message, buttons }`.
   - The message is first parsed through the shape that fills in defaults, so `fields: []` and a missing `fields` hash the same.
   - Keys are sorted because **Postgres `jsonb` reorders object keys**. A `JSON.stringify` of the stored row would report every message out of date on Postgres, and never on SQLite.
   - No helper exists for this today, so a small `canonicalJson` is written beside the digest.
4. **No tokens at all in a resource message.** **Douglas?**
   - A posted message has no member and no run, so `{{subject.*}}`, `{{actor.*}}` and `{{var.*}}` can't render.
   - `{{guild.name}}` needs nothing from a run (`copyRendering.ts:112-121`). But rendering lives in the flows engine and takes a `FlowRunSeed`, so allowing it would need a second renderer in provisioning, and renaming the server would make every message drift.
   - So any `{{…}}` in a copy part, a picture or a button label is refused at save. The check uses the existing walk, `messageCopyLocations` (`messageParts.ts:129`) with `holdsCopyToken` (`copyTokens.ts`). There is no second walk.
   - This also refuses literal double braces.
5. **Buttons are `{ key, label, style }`: at most 25, laid out in order in rows of 5.**
   - The key follows the resource key pattern (at most 64 characters, `journeyBody.ts:72`), and keys are unique within a message.
   - The label is 1–80 characters.
   - The styles are `Primary`, `Secondary`, `Success` and `Danger`: the four Button Click has (`triggerButtonClick/index.ts:36-49`), and the four TestDiscord models (`messageSchemas.ts:52-58`).
   - There are no link buttons, because nothing could listen to one and each needs a URL. No emoji, and no rows chosen by hand.
6. **The customId is `mbtn:<buttonKey>`**, at most 69 characters.
   - `mbtn:` doesn't overlap `flow:` or `flowc:` under longest-prefix matching (`interactionsRegistry.ts:177-186`, `flows/constants.ts:8-27`).
   - The prefix, the builder and the parser live in provisioning.
   - These move from flows to `src/shared/discordButtons.ts`, and flows imports them from there:
     - the four style names and their discord.js map (`triggerButtonClick/index.ts:44-49`);
     - `DISCORD_CUSTOM_ID_MAX_LENGTH` and `DISCORD_BUTTON_LABEL_MAX_LENGTH` (`constants.ts:39,48`).
7. **Flows registers the press handler now**, with `registerDynamic('mbtn:', …)` in `initFlows`, beside `initFlows.ts:113,128`.
   - `registerDynamic` throws on a duplicate prefix (`interactionsRegistry.ts:66-71`), so there must be exactly one registrant, now and in step 3. Step 3 replaces only the handler's body.
   - The handler returns `{ status: 'skipped', message }`, which the registry sends as an ephemeral reply.
   - In step 2 the handler reads nothing and **wakes no parked Wait for Event run**. Today a `flow:` press wakes the presser's parked button-click waits (`flowTriggerDispatch.ts:60-66`). Whether a message button should do the same is step 3's call.
8. **The install note is unconditional** for any message with at least one button, because in step 2 nothing can listen to it. Step 3 swaps it for a lookup of the listening flow.
9. **A resource message pings nobody**: `allowedMentions: { parse: [] }` on both post and edit. Post Embed's `['users']` was for a run about a member. A standing sign in a channel shouldn't ping whoever it names each time it is posted or repaired.
10. **If a posted message's channel changes, install refuses rather than repairing.** **Douglas?**
    - Discord can't move a message. If the message still exists in its stored channel and the declaration names another one, the item is `blocked`: "It's posted in #verify, but this journey now puts it in another channel. Discord can't move a message: delete it there and install again."
    - The dashboard also locks the channel picker once the key is installed. This follows the key-permanence precedent (`installedKeys`, `journeyInstallState.ts`).
11. **Missing bot permissions block the whole install**, as Manage Channels does (`installPlan.ts:226-236`).
    - If any message is declared, the plan blocks when the bot lacks Send Messages, Embed Links or Read Message History. Fetching a single message needs Read Message History.
    - It also blocks on Attach Files when any message shows an upload.
    - No declared intent can deny those permissions: the access table only touches view, send, threads and reactions (`permissionIntent.ts:93-102`). The bot's own overwrite (`:215-218`) is left alone.
    - A channel whose own overwrites shut the bot out shows up when the message is fetched: Missing Access becomes a `blocked` item.
12. **Save rules, written so autosave doesn't wipe edits.**
    - **The problem.** A refused journey save re-reads the stored list over the screen (`useResourceAutosave.ts:233-252`; `resourceSaveQueue.ts:177-185` calls this destructive). A message being edited is often refusable mid-edit: a fresh empty embed, an icon added before its text, a title one character over.
    - **The server refuses at save** (`declarationsRefusal`) on:
      - `messageConfigSchema`, which runs `messageProblems`, the picture form and the title-link parse;
      - tokens;
      - duplicate button keys;
      - upload problems, in a separate async call because they need the database.
    - **The browser holds the list back from saving** while a message resource breaks a rule it can check:
      - the SDK's `zDiscordMessage` and `zMessageButton`;
      - a hand-written mirror of `messageProblems`, and of the token and duplicate-key rules. A drift test holds the mirror to the server's rules.

      A red chip says why. `isWorthSaving` is list-wide, so a held message also holds every other row's edits. The chip is the feedback, as it is today for an empty name.
    - **Server-only rules can still be refused and reverted**: the title link and picture links parsing as URLs, and upload problems. Those are rare and persistent, and the error banner names them.
13. **A message without a channel saves.** Install blocks it with "Pick the channel it goes in", and an amber chip says the same. Removing a channel row already clears its children's `parentKey` (`resourceRows.ts:447-453`), so the panel can produce this state.
14. **A new message row starts with one embed, titled with the resource's name**, so it can be saved as soon as it is added. If a text channel is declared, the message goes in the first one.
15. **No colour presets in a resource message's editor.** The swatches are Post Embed's field config (`actionPostEmbed/index.ts:136`), which the flows page doesn't have. The colour picker still works.
16. **On the Uploads page, a journey message's use links to `/flows`.** That page's group header is where a journey's resources are edited. There is no deep link to one journey's resources today, and adding one isn't part of this step.
17. **The upload reader is registered by a new `initProvisioning()`**, called from `bot.ts` before `initFlows`. The other three boot roots that register `flowUploadUses` call it too.

## The model

### The declaration (`logic/resourceDeclaration.ts`)

`ResourceDeclaration` gains two fields, both used only by messages:

```
message?: DiscordMessageInput        // required for kind 'message'
buttons?: readonly MessageButton[]   // { key, label, style }
```

`MessageButton` and `MESSAGE_BUTTON_STYLES` live in a new `logic/messageButtons.ts`, together with `messageButtonCustomId(key)`, `parseMessageButtonCustomId(id)` and `buildButtonRows(buttons)`.

`validateJourneyDeclaration` is structural only; it runs on every read (`journeysRepo.ts:82`).
- **Parent rule** (replaces `:221-225`):
  - a `message`'s parent must be a `textChannel`;
  - only a `message` may have a `textChannel` parent;
  - a `textChannel`'s parent is still a category;
  - a message without a parent is allowed (pick 13).
- **Shape rule** (beside `validateTicketTypeShape`, `:305`): a `message` carries `message`, and no `ticketType`, `permissions` or `adoptDiscordId`. No other kind carries `message` or `buttons`.
- **No content rules here.** A content rule checked on read would make one bad row 500 the whole flows list.

**Places the compiler finds** once `'message'` exists:
- `KIND_LABEL` (`installPlan.ts:171`, `resourceDrift.ts:237`, `unpublishPlan.ts:92`, `orphanedBindings.ts:187`);
- `KIND_ORDER` (`unpublishPlan.ts:128`);
- `normaliseResourceName` on both sides (`resourceName.ts`, `web/src/flows/resourceName.ts`). A message's name is trimmed and otherwise passed through, as a ticket type's is.

**Places the compiler won't find.** Each is an `!isDiscordResource` branch that assumes "therefore a ticket type", and each gets an explicit message branch:

| Site | Today, a message would… |
|---|---|
| `installPlan.ts:402` | be planned as a ticket type |
| `applyInstallPlan.ts:129` | go to `applyTicketType` |
| `journeyDriftPlan.ts:131,138` | be skipped silently |
| `unpublishPlan.ts:280` | be *forgotten*, never deleted |
| `applyUnpublishPlan.ts:111` | be forgotten |
| `unpublishPlan.ts:469` `plannedSettingsKept` | be listed as a kept setting |
| `orphanedBindings.ts:111` | read `stillInGuild: true, mayDelete: false` |
| `provisioningService.ts:445` `resolveJourneyResources` | be reported `stale` on every install |
| `journeyMergePlan.ts:195` | not be warned about as orphaned when left behind |
| `provisioningService.ts:225-228` `previewDrift`, `:319-321` `repairUnderLock` | never reach drift or repair. Both take the journey's rows from `ownership.bindings`, which `readGuildBindings` (`:117`) filters to Discord kinds; both read the journey's message rows from the raw `rows` instead |

`resolveJourneyResources` skips message rows, because no node's config holds a message id.

### Save-time rules (`src/web/api/journeyBody.ts`)

- **Wire.**
  - `ResourceDeclarationSchema` (`:208`) gains:
    - `message: DiscordMessageSchema.optional()` (the step-1 component);
    - `buttons: z.array(MessageButtonSchema).max(25).readonly().optional()`.
  - `MessageButton` and `MessageButtonStyle` are new named components.
  - The transform (`:234-240`) trims a message's name, as it trims a ticket type's.
  - `SchemaMatches` in `journeyBody.test-d.ts` holds the domain type to the wire.
- **`declarationsRefusal`** (`:311`) gains `messageResourceRefusal`. It calls `messageResourceProblems(declaration)` from provisioning, which checks:
  - `messageConfigSchema.safeParse`;
  - `messageCopyLocations` + `holdsCopyToken` over the message;
  - `holdsCopyToken` over each button label;
  - duplicate button keys.

  The refusal names the first problem, worded like `"Rules panel" embed 2 footer: <sentence>`.
- **`messageUploadsRefusal(guildId, resources)`** is async. The same three routes await it after the synchronous refusal (`journeyRoutes.ts:813,1328,1356`). It asks `messageUploadProblems` with the sizes this guild holds.
- **Size of a journey.** The 1 MiB body cap (`AGENTS.md`) limits a journey to about fifteen messages at Discord's maximum sizes. That is accepted: real panels are a few KB.

### Uploads, shared (`features-system/guild-uploads/logic/readMessageUploads.ts`)

Post Embed's `readUploads` moves here, with no change in behaviour. For this guild only, it:
1. reads the uploads' sizes;
2. judges them with `messageUploadProblems`;
3. reads the bytes.

It returns `{ ok, files } | { ok: false, problem }`, and the caller words the part. Post Embed, install and repair all call it. `guild-uploads` is already allowed to read `shared/discordMessage`.

### The binding (`data/resourceBindingsSchema.ts`, migration)

- **Columns:** `messageChannelId: string | null` and `messageDigest: string | null`. Both are null on every other kind.
- **Migration** `2026-10-25-Resource_Binding_Message_Post.ts`: `alterTable('resource_bindings').addColumn(...)` twice, both text and nullable; `down` drops both. The `2026-10-10` migration's `dropColumn` is the precedent on both dialects.
- **Repo:**
  - `upsertPostedMessage({ guildId, journeyKey, resourceKey, discordId, channelId, digest, name })` writes state `created`, on the same conflict target as `upsertBinding`.
  - `recordMessageDigest({ id, expectedDiscordId, digest })` is guarded like `renameBinding` (`:288`).
- **Test database:** `provisioningTestDb.ts` runs migrations by hand. It needs this one, and `2026-10-24-Create_Guild_Uploads` too, because install now reads uploads.

### Existence (`logic/lookupBoundMessage.ts`)

`lookupBoundMessage(guild, channelId, messageId)` answers `found` or `gone`, or throws:
- the channel isn't in the cache, or the fetch answers 10003: `gone`;
- `channel.messages.fetch({ message: id, force: true })` answers 10008: `gone`;
- anything else: it throws.

It uses `force` because a cached copy proves nothing after a gap in the gateway connection. `DISCORD_UNKNOWN_MESSAGE = 10008` joins `discordErrors.ts`, and `isAlreadyGone` counts it.

The planners stay synchronous. Each service wrapper reads every settled message row of the journey once, and passes in `messagePresence: ReadonlyMap<resourceKey, 'found' | 'gone' | { unreadable: string }>`. The `unreadable` sentence is `describeDiscordError`'s.
- **Callers:** `previewInstall`, `previewUnpublish`, `previewDrift` and `previewOrphans`.
- **Appliers** are async, and check again right before they act.

**Cost:** one GET per message on every install plan, install, drift check, repair, uninstall plan and orphan list. The published inventory (`publishedJourneyState.ts:100`, `publishedFlowState.ts:122`) calls `previewUnpublish`, so opening it pays the same. It is never paid per click.

### Install

`previewInstall` also reads the upload sizes of every message declaration, in one `sizesFor`. `buildInstallPlan` plans a message like this:

| State | Item |
|---|---|
| No parent key | `blocked`: "Pick the channel it goes in." |
| Settled row; presence `unreadable` | `blocked`: "Couldn't check it in <#channel>: …" |
| Settled row, `found`; stored channel ≠ the declared parent's bound id | `blocked` (pick 10) |
| Settled row, `found`, same channel | `reuse`. Install never edits; out of date is drift's job |
| Settled row, `gone` | `create`, reason "The message this journey posted no longer exists, so it will be posted again." |
| No row | `create` |
| A `create` whose message breaks `messageResourceProblems` or its uploads | `blocked`, naming the part |

Every message item with buttons carries the `note` "Nobody listens to its buttons yet — a press answers "Nothing's hooked up to this yet"." Install notes are already deduplicated and shown (`web/src/flows/installSummary.ts:147`).

`collectBlockers` gains the permission blockers of pick 11.

`applyInstallPlan` gets a message branch. `orderResourcesForApply` runs it after the parent, through `parentKey`:
1. Take the channel from `idByKey.get(parentKey)`. It must be a text channel in the cache.
2. `readMessageUploads`.
3. `channel.send({ ...buildMessagePayload(message, files), components: buildButtonRows(buttons), allowedMentions: { parse: [] } })`.
4. `upsertPostedMessage` with the channel id and the digest.

If Discord refuses, the apply stops and `describeDiscordError` words the reason, as today. If the row fails to write after the post, the item says "posted (id), but recording it failed — delete it by hand before installing again, or there'll be two". There is no crash recovery (correction 3).

### Drift (`logic/messageDrift.ts`, pure)

- **New helpers:** `messageDigest(message, buttons)` and `canonicalJson`.
- **New drift kind.** `RESOURCE_DRIFT_KINDS` gains `outOfDate` (`resourceDrift.ts:59`).
  - It carries no fields: what to write is the declaration, which repair already has.
  - These move with it: the `test-d` guard, `describeDrift`'s switch (`:471`) and `applyOneDrift`'s switch (`applyDriftRepair.ts:441`).
  - The browser's copy updates after `pnpm sdk:generate`.
- **`buildJourneyDriftPlan`'s message branch:**
  - a `found` message whose stored digest differs from the declaration's digest has drifted: `[{ kind: 'outOfDate' }]`, `repairable: true`;
  - a `gone` message is skipped, because install handles it;
  - a channel mismatch is skipped, because install blocks it;
  - anything else is clean.
- **`describeDrift`** says: "What's posted is older than this journey's message. Repair edits it in place, so it keeps its spot in the channel."
- **`LiveResourceSnapshot` is not bent to fit**, because a message has no name, parent or overwrites to compare.

### Repair

`repairUnderLock` prepares `messageEdits: Map<resourceKey, { channelId, messageId, edit } | { refusal }>`, as it already prepares `compiledOverwrites`. If a message's declaration now breaks `messageResourceProblems` or its uploads, the repair is refused, naming the part, and nothing is touched.

`applyOneDrift`'s `outOfDate` arm:

```
channel.messages.edit(messageId, {
  content: payload.content ?? '',        // PATCH leaves an absent member alone
  embeds: payload.embeds,
  components: buildButtonRows(buttons),  // [] when the buttons were removed
  files: payload.files,                  // always an array
  allowedMentions: { parse: [] },
})
```

- **No `attachments` key.** With `files` and no `attachments`, discord.js sends the new files' descriptors as the whole list (`discord.js/src/structures/MessagePayload.js:215-223,257`, v14.23.2). Discord keeps only what that list names, so the old pictures are replaced, not duplicated, and an empty `files` clears them.
- **Every upload is re-sent on every repair.** That is accepted.
- **A message deleted since the check** answers 10008, which becomes `failed`: "It was deleted since the check — install posts it again."
- **After an edit lands,** `recordMessageDigest` stores the new digest. If that write fails, it is a note, not a failure, like `recordLandedRename` (`applyDriftRepair.ts:554`). The next check says out of date again, and repairing again is harmless.

### Uninstall

- **Order:** `KIND_ORDER` becomes `message: 0`, `textChannel: 1`, `role: 2`, `category: 3`, `ticketType: 4`.
- **`buildUnpublishPlan`'s message branch:**
  - `created` and `found`: `delete`;
  - `gone`: `forget`, "already gone";
  - `unreadable`: `refuse` with the sentence (a new `RefusalReason`, `unreadable`).
- **Deleting:** `deleteFromGuild` calls `channel.messages.delete(id)`. Through `isAlreadyGone`, 10008 and 10003 count as success. The bot needs no Manage Messages to delete its own post.
- **Orphans:** `stillInGuild` comes from presence, and `describeOrphan` says "the message is still posted".

### The press (`flows/logic/messageButtonPress.ts`)

`handleMessageButtonPress(interaction)` answers anything that isn't a button with `skipped`. A button gets `{ status: 'skipped', message: NOTHING_HOOKED_UP }`.

The draft wording is: "Nothing's hooked up to this yet. Poke it all you like, babe — it isn't going to put out." It is in the bot's voice, for Douglas to tune.

**This file is the hand-off to step 3.** Its body becomes: message id → binding → the one listening trigger → that trigger's gate → the run. This sentence becomes the answer when nothing listens.

### Upload uses

- **`UploadUse`** (`guild-uploads/logic/uploadUsage.ts`) becomes a union:
  - `{ kind: 'flow', uploadId, flowId, flowName, nodeId, blockLabel, where, draftAuthorId? }`
  - `{ kind: 'journeyMessage', uploadId, journeyKey, journeyName, resourceKey, messageName, where }`
- **`flowUploadUses`** adds `kind: 'flow'`.
- **Provisioning's `journeyMessageUploadUses(guildId)`** reads `journeysRepo.listByGuildId`, then the `messageUploadPlaces` of each message resource.
  - The journeys are validated, so one malformed journey 500s the list. That is the cost `uploads-page.md:104` already accepted.
  - It never runs inside a transaction.
- **The no-reader error.** `uploadUsesForGuild`'s throw sentence names both wirings.
- **Wire:** `UploadUseSchema` (`uploadBody.ts:27`) becomes `z.discriminatedUnion('kind', …)`, following the `savedAs` precedent (`flowBody.ts:362`). `uploadBody.test-d.ts` holds it, and `UploadInUse` and `GuildUploadListing` follow.

### Dashboard

- **Vocabulary**
  - `RESOURCE_KIND_STYLES` (`resourceMeta.ts:41`) gains `message`: `IconMessage`, teal, "Message", no prefix, "e.g. Rules panel".
  - `RESOURCE_KIND_ORDER` (`:82`) puts it after `textChannel`.
  - `installSummary.ts` gains it in `KIND_NOUNS`.
  - `canAdopt` and `hasChannelPermissions` are false for a message.
  - `canHaveParent` (`resourceAdoption.ts:193`) becomes `parentKindFor(kind)`: a channel's parent is a category, and a message's is a text channel. `ResourcesPanel.tsx:777`'s picker then offers declared text channels for a message.
  - `declarationForNewResource` seeds a new message as in pick 14.
- **Rows.** `orderResourceRows` (`resourceRows.ts:80`) puts a message under its channel, one level deeper than the channel. Messages with no channel, or an unknown one, go in a group after the channels.
- **The row body**
  - Name, with "Only you see this name".
  - "Posted in", locked once installed (pick 10).
  - The compact preview, taken out of `MessageControl` as `MessagePreviewCard`, and **Edit message**.
- **The window.** `MessageEditor` gains two props:
  - `tokens={false}` hides the `{x}` button (`TextPartBox` already takes `takesTokens`, `:30`) and the Token tab in the picture popover (`PictureSlot.tsx:189`), through the editor scope.
  - `buttons={{ value, onChange }}` draws the mockup's button row under the embeds:
    - each button in its style, with "↳ Nothing listening yet" under it;
    - **+ Add button**, until there are 25. A new button is labelled "New button" and given a unique slug key (`slugifyResourceName`, `uniqueResourceKey`), so it never starts empty;
    - clicking a button opens a popover with its label (with a character counter), style and key.
  - Cancel restores both the message and the buttons.
  - Nothing is `disabled` during an upload, as in step 1.
  - `issues` come from the browser mirror (pick 12) and are placed by `placeMessageIssues`.
- **Saving**
  - `isWorthSaving` (`resourceSaveQueue.ts:189`) holds the list while the web mirror, `messageResourceProblems` (`web/src/flows/messageResourceProblems.ts`), reports anything.
  - `detectResourceProblems` gains two chips: a red `messageNotSaveable` (showing the first sentence) and an amber `messageNoChannel`. `docs/contracts/resource-chips.md` records both.
- **Both pages** hand the dialog `uploads` from `useGuildUploads`. The builder already has it (`FlowBuilderPage.tsx:491`); `FlowsListPage` gains it.
- **Drift dialog.** Nothing changes beyond the generated kind, since the sentence comes from the server.
- **Uploads page.** `UploadUses.tsx` renders both kinds. A journey use reads "Onboarding · message Rules panel · embed 1 image" and links to `/flows`. Its React key gains the kind.

## Slices

All four slices go out in one deploy. After A alone, the API would accept a kind that every `!isDiscordResource` branch reads as a ticket type.

| # | Change | Proof |
|---|---|---|
| **A** | **Kind, declaration, save rules, wire.** `'message'` in `RESOURCE_KINDS`; `message` and `buttons` on the declaration; `messageButtons.ts`; the button constants moved to `src/shared/discordButtons.ts`; the parent and shape rules; every `Record<ResourceKind>` and the `normaliseResourceName` pair; `messageResourceProblems`; `messageResourceRefusal` and `messageUploadsRefusal` on the three routes; `readMessageUploads` moved out of Post Embed; the wire schemas; `pnpm sdk:generate` | **`resourceDeclaration.test.ts`**: these are refused: a message under a category; a channel under a text channel; a message with `permissions`, with `adoptDiscordId`, or with no `message`; `buttons` on a role. A message with no parent passes. **`messageResourceProblems` table**: each of these is refused, naming the part: `{{subject.mention}}` in embed 2's footer, `{{guild.name}}` in the content, a token picture, a token in a button label. These are refused too: an empty embed, a lone footer icon, 6001 characters, duplicate button keys. A clean message passes. Sabotage: drop the token check and watch the four token rows pass when they should fail. **Routes** (`journeyRoutes.test.ts`): each of the three routes answers 400 with `"Rules panel" embed 2 footer: …`, and another guild's upload id gets 400 with the upload sentence. **Unchanged**: Post Embed's run tests pass on the moved `readMessageUploads`. **Gates**: `journeyBody.test-d.ts`, `resourceNameMirrorDrift`, `openApiSpec`, `generatedSdkIsCurrent` |
| **B** | **Install, uninstall, existence, the press, the reader.** The migration and repo methods; `lookupBoundMessage` and 10008; presence maps in the four previews; every row of the "won't find" table except drift and repair; `collectBlockers`; posting; `KIND_ORDER` and deleting; orphans; the `resolveJourneyResources` skip; `journeyMergePlan`; `messageButtonPress.ts` and its `registerDynamic`; `initProvisioning` and the four reader registrations; the `UploadUse` union, wire and SDK. **TestDiscord**: `DELETE /channels/:id/messages/:id` (204, sending MESSAGE_DELETE to a `GuildMessages` client); `ServerChannel.deleteMessage(id)`, for an operator deleting the post; `refuseHistory` also covering `GET …/messages/:messageId` | **Integration** (in the `provisioningDrift.integration.test.ts` style: real discord.js, SQLite and TestDiscord). Install posts one message in the declared channel, as one multipart send: content, 2 embeds, an uploaded thumbnail, and 7 buttons in rows of 5 + 2 with `mbtn:<key>` ids. The row holds the message id, channel id and digest. A second install is `reuse` and sends nothing. After `deleteMessage`, the plan is `create` with "no longer exists", and install reposts. A changed channel is `blocked`. `refuseHistory` gives a `blocked` item, not a 500. Uninstall deletes the message before its channel. A message deleted by hand mid-uninstall counts as success; sabotage: take 10008 out of `isAlreadyGone` and watch it fail. Tearing down a journey whose row is gone still deletes the message (correction 1). **Unit**: `buildButtonRows` at 0, 5, 6 and 25; the customId parser refuses `flow:x:y` and a 6th segment. **Press**: a fake button interaction gets the ephemeral sentence and touches nothing; a `flowc:` id still routes to choices. **Reader**: it finds a journey message's header icon and image, and ignores another guild's journey. Delete answers 409 listing the journey use; sabotage: don't register the reader and watch the 409 test fail. **Migration on SQLite**, through a real `Migrator`: up, down, up. **Live Postgres** (a throwaway `postgres:16`, env on the command line): migrate up, down, up; install, and read the row back |
| **C** | **Drift and repair.** `messageDigest` and `canonicalJson`; `outOfDate` in `RESOURCE_DRIFT_KINDS` and its three switches; the drift branch; `messageEdits` and the repair arm; `recordMessageDigest`; drift and repair reading raw rows for messages. **TestDiscord**: PATCH `takesFiles`; `editMessageSchema` gains `attachments`; `checkEdit` (`messageState.ts:296-301`) accepts `attachment://` naming a file in the same request, and an `attachments` list of exactly the new files' indices replaces the stored attachments. A list that keeps an existing attachment id faults, because keeping one is not modelled | **`messageDrift.test.ts`**: the same declaration with its keys in another order hashes the same, and so does one with `fields` absent vs `[]`. Sabotage: use `JSON.stringify` in place of `canonicalJson` and watch the reordered case fail. A changed button label changes the digest. **Integration**: install, check it is clean, change the title in the declaration, see `outOfDate`, repair. The repair edits the same message id rather than posting a new one: the content is new, the new upload is in `attachments` and the old one is gone, and removed buttons give `components: []`. It is then clean. Removed content becomes `''`. A repair whose declaration now has an empty embed is refused, with nothing sent. A message deleted between check and repair is `failed`, with the install sentence. Fixtures carry no raw `<@id>`, because TestDiscord faults on mention edits (`messageState.ts:285-294`). **Unchanged**: every existing drift and repair test |
| **D** | **Dashboard, docs.** Everything under "Dashboard" above; the web mirror and its chips; `MessagePreviewCard`; the window's `tokens` and `buttons` props; `UploadUses.tsx`. Docs: `resource-chips.md`; the button-constant note in `block-authoring.md`; `AGENTS.md` on provisioning's message kind, `initProvisioning` and the `mbtn:` prefix; the design doc's step 2 line and a "Step 2 as built"; an "As built" section here | **`resourceChipAgreement.test.ts`** gains message fixtures. A token, a duplicate key, an empty embed and over 6000 characters are red and refused. A clean message is clean and accepted. No channel is amber and accepted. **`messageResourceProblemsDrift.test.ts`** runs the server rules and the web mirror over one table. **`dom`**: with `tokens={false}` the window shows no `{x}` and no Token tab; Add button writes "New button" with a unique key; changing the style or label emits a new array; a 26th button is not offered; Cancel restores the message and the buttons; a held message stops the autosave and shows the chip; the channel picker offers only declared text channels and locks once installed; `UploadUses` renders a journey use linking to `/flows`. **e2e** (`web/e2e/journeyMessage.test.tsx`, after `journeyTicketType.test.tsx`): declare a channel and a message with an upload and two buttons; install, and TestDiscord holds the message; edit the title; drift shows out of date; repair; it is clean; uninstall deletes it. **Preview**: `seedMessageResource.ts` seeds four pages: the resources dialog with a message row open, the window with buttons, the drift dialog showing out of date, and the Uploads page with a journey use. `preview:shoot` at 1440 and 1280, checked by hand against mockup section 3 |

**From the plan review** (2026-10-24, folded in before building):
- **Every slice leaves web `tsc` green.** The web's `Record<ResourceKind>` tables (`RESOURCE_KIND_STYLES` `resourceMeta.ts:41`, `KIND_NOUNS` `installSummary.ts:58`) get their `message` entries in A. The narrowing of the `UploadUse` union in `UploadUses.tsx` lands in B. Any web copy of the drift kinds lands in C. D keeps the behaviour.
- **Exhaustive branches, not a list.** In A, each `!isDiscordResource` else-branch becomes an exhaustive switch on `kind`, so a `message` fails loudly (a thrown "not yet" in A) and the compiler finds the sites. The "won't find" table above becomes a checklist the compiler also enforces.
- **Two routes start calling Discord.** `previewUnpublish` now fetches each message, and `journeyRoutes.ts:597` and `flowRoutes.ts:1263` call it. Slice B checks how `rateLimit.ts` classifies each one and, if either is a GET, lists it as a GET that calls Discord.
- **The channel lock needs `installedKeys` to see message rows.** `flowJourneyIndex.ts:109` and `journeyInstallState.ts:70` must count a message's binding. A test in B checks that an installed message key appears in `installedKeys`.
- **`canonicalJson`'s reason.** The zod parse already emits keys in schema order, so `canonicalJson` is a defence against key order from any source, not just from `jsonb`. It stays.

**Review**: one reviewer pass after C, which covers new persistence, a migration, a new Discord write (editing in place) and a new interaction prefix. D is proved by its tests and sabotage checks. A second pass happens only if C's Critical findings need confirming.

## The live run

Run on an unboosted guild, against the production stack (Postgres, behind the tunnel). It includes **all of step 1's list**, none of which has run yet ([message-editor-step-1.md](message-editor-step-1.md), "The live run").

Step 1's checks:

1. **Step 1's migration.** An existing Post Embed flow posts the same embed after the deploy, and the log shows its warnings.
2. **Step 1's full message**, posted from Post Embed.
3. **`attachment://` in the header and footer icons** draws the picture. Check it on both a Post Embed and a resource message. If it doesn't draw, both lose uploads for icons.
4. **The upload limit.** Post about 9.5 MiB across several uploads, then two files of about 6 MiB each, to tell a per-file limit from a per-message one. Set `MESSAGE_LIMITS.uploadBytes` from the answer. It is still a guess, and step 2's save and install judge by it.
5. **The stale-tab refusal.** Then remove the bridge in a later deploy.
6. **An upload through the tunnel.** Nearly 8 MiB answers 201; one byte over answers the app's own 413; `cf-cache-status` is not `HIT`.

Step 2's own:

7. **Install a journey** with `#rules` and a message carrying plain text, two embeds, an uploaded image, uploaded header and footer icons, and three buttons. One message lands, and pressing a button answers the sentence, visible only to the presser.
8. **Drift and repair on Postgres.**
   - Right after install, drift says clean (the `jsonb` key-order case).
   - Edit the title and swap a picture: drift says out of date.
   - Repair: the message keeps its id and its place, **every picture shows exactly once** with none duplicated or broken, and drift says clean.
9. **Delete and uninstall.** Delete the message in Discord, and install reposts it with "no longer exists". Uninstall deletes the message, then the channel.
10. **Permissions.** Take Read Message History off the bot's role: the plan names the blocker.
11. **Gates.** The suite at its quiet baseline, root `tsc` at its baseline, web `tsc` at 0.

## Step 3 picks up

- The body of `flows/logic/messageButtonPress.ts`: the routing.
- The install note (pick 8), which becomes a lookup of the listening flow, through a hook provisioning defines and flows registers.
- "↳ Nothing listening yet" in the window, which becomes the listening flow's name.
- Freezing a button's key once a trigger names it.
- Whether pressing a message button wakes parked button-click waits (pick 7).

## Not in this

- Step 3: the trigger's picker, "+ New button" and "+ New message", one flow per button, and converting Deploy.
- Link, premium and emoji buttons, and button rows chosen by hand.
- Any token in a resource message, `{{guild.name}}` included.
- Moving a posted message to another channel (pick 10).
- ~~Noticing a moderator suppressing the message's embeds.~~ Built after all: see "Hidden embeds are out of date" under As built.
- A deep link from the Uploads page to one journey's resources.
- Colour presets in the resource window.
- Adopting an existing message, and crash recovery for a post (accepted, as for ticket types).

## Owner might disagree

- Keeping `message` outside `DISCORD_RESOURCE_KINDS`, under that name (pick 1).
- Refusing every token, `{{guild.name}}` included (pick 4).
- Flows registering the press handler now, and the press waking nothing (pick 7).
- Install blocking a changed channel rather than reposting (pick 10).
- The browser mirror that holds back saves, rather than a lenient save judged at install (pick 12).
- No pings from a resource message (pick 9).
- A half-edited message holds back the whole Resources list's autosave, including other rows' edits, until it's fixed (pick 12).
- One Discord fetch per message every time the install, uninstall or published view opens.
- Re-sending every upload on every repair.
- The press sentence's wording.

## As built

Built 2026-10-25, all four slices, as one change. The live run above has not happened. Where the build settled something the plan left open, or departed from it:

**A–C (server)**
- **An unreadable message goes to drift's `unchecked` list**, with why, rather than being called clean or offered for repair. Certifying a message nobody could look at would be a false clean, and repairing it would edit blind. Install and uninstall still block on it, as planned.
- **An announcement channel is accepted for a message** (`isMessageChannel`, `lookupBoundMessage.ts`). A Community server converts its `#rules` channel into one, and a message posted there is still the bot's to edit and delete.
- **A `#rules` *channel* resource converted to an announcement channel still reads as missing.** `existsInGuildAs` checks for a text channel, so install plans to create it again. That is the channel path, older than this step, and left out of it.
- **`canonicalJson` is guarded on its own.** Sabotage showed `messageDigest` can't guard it: the zod parse re-emits keys in schema order, so a reordered message hashed the same with `JSON.stringify` in its place. The key-order test now calls `canonicalJson` directly (`messageDrift.test.ts`).
- **Uninstall forgets a message's row only while it still names the post the plan read** (`ResourceBindingsRepo.forget` with the expected id). An install that reposted onto the same row in between would otherwise have its new post's record deleted, leaving a message with no record. The item says the record "had moved on", and its outcome is `refused`, not `forgotten`: the resource is still installed. Both uninstall dialogs (`web/src/flows/uninstallNotice.ts`) call a run "Partly done" when an item failed, or was refused without the plan having shown it as kept — an adopted resource the plan listed as left alone still counts as done.
- **Hidden embeds are out of date.** "Remove all embeds" (SUPPRESS_EMBEDS) is the one change anyone but the bot can make to its message, and with the declaration unchanged the digest alone called that clean. The same fetch that finds the message reports the flag (`readMessageState`, a second structure beside presence rather than a fourth presence value), and drift says `outOfDate` with `embedsHidden`. Repair always sends `flags: 0` (discord.js types `flags` on an edit as SuppressEmbeds only, so the edit holds `flags: []`), which shows the embeds again.
- **One message that can't be prepared refuses only itself.** `prepareMessageEdits` catches each message's preparation (uploads read, payload built): that item is refused ("couldn't be prepared. Nothing was changed; try again."), logged, and the other approved items still repair, rather than one bad row turning the whole repair into a 500.
- **The fingerprint is pinned.** `messageDrift.test.ts` holds one fixture's digest hex. Changing `messageDigest` or `canonicalJson` reads every stored `message_digest` as out of date, so the change needs a recompute — a migration, or one repair pass — and the test says so.
- **The import rule is a test.** `src/shared/discordMessage`, `src/shared/discordButtons.ts` and `src/features-system/guild-uploads` may not import `src/features/` (`src/shared/__tests__/dependencyDirection.test.ts`).
- **Without the bot's own member, the checks say so** (`guild.members.me` null), rather than naming permissions it may well have — in the message lookup and install's channel check.

**D (dashboard)**
- **No channel is orange, not amber.** `messageNoChannel` blocks install, so it wears the `blocksInstall` tier ("No channel"), and `resourceChipAgreement.test.ts` holds it against `buildInstallPlan`. `messageNotSaveable` is red ("Won’t save"), showing the first problem.
- **The browser mirror is `web/src/flows/messageResourceProblems.ts`.** It runs the SDK's zod first and sorts its complaints into the server's order (the generated zod lists fields alphabetically), then the spanning rules, tokens, button-label tokens and duplicate keys, with the server's sentences. A picture link is judged by the pattern alone; whether it parses as a URL stays server-only, as planned. `messageResourceProblemsDrift.test.ts` runs both over one 33-row table.
- **A button's key doesn't follow its label.** It starts as `new-button`, `new-button-2`, … and is edited in the button's popover ("Settle on it before a flow listens to this button"). Step 3 freezes it once a trigger names it.
- **New buttons are Primary.** The popover names the styles as Discord users see them: Blurple, Grey, Green, Red.
- **The channel picker locks by `readOnly`, not `disabled`** (focus), with a lock in place of the chevron. An installed message with no channel stays pickable, since there is nothing posted to move.
- **Escape in the message window closes only the window.** Mantine's modal listens for Escape on the window, so the Resources dialog under it would close too; it now ignores Escape while a message window is open (`ResourcesDialog.tsx`, held by the e2e).
- **The flows list reads the server's uploads only while a journey's resources are open.**
- **The window says what it's editing**: "Edit message", then "Rules panel, posted in #rules. Edits stay here until you install it — or repair it, once it's up."
- **The plain-text placeholder still says it can ping**, which a resource message can't (pick 9). Left as step 1 wrote it.
