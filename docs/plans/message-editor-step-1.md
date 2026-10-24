# The message editor, on Post Embed

> **Status**: Built 2026-10-24; live run pending. Slices A–D and E's docs are done (see "As built"); E's live run is listed under "The live run".
> **Owner**: Douglas
> **Design**: [message-resource-and-embed-editor.md](message-resource-and-embed-editor.md), step 1. Mockup: [message-editor.mockup.html](../../nimbalyst-local/mockups/message-editor.mockup.html)
> **Next**: step 2 (the message resource) reuses the message model, the control and the uploads built here. It gets its own plan.

## The gap

Post Embed posts one embed from flat keys (`actionPostEmbed/index.ts:108-136`). It can't post plain text above the embed, more than one embed, a header icon or a footer icon, and its pictures can only be links. Its form is twelve boxes in a narrow side panel.

## Decisions

From the design (Douglas, 2026-10-23):

- A MEE6-style click-to-edit window.
- Up to 10 embeds, plus plain text above them.
- Header and footer icons.
- Uploads are kept per server in the database, attached to the message, and checked by their contents.
- The upload route is an exception to the 1 MiB cap and sits in the Discord-free rate group.
- Uploads are shown only through a signed-in route.
- No deleting uploads in this step.
- Existing nodes keep working.

My picks:

- **Existing nodes are rewritten once by a data migration, and the schema reads only the new shape.** Reading the old shape isn't a judgement call; three things block it:
  - The field-rule emit needs a plain top-level `z.object` (`blockFieldRules.ts:296-302`). A `z.preprocess` that lifts old keys fails `pnpm sdk:generate`.
  - Conformance refuses a schema key that no drawn field edits (`conformance.ts:1037-1043`). The old keys can't stay in the schema once the form stops drawing them.
  - Zod strips unknown keys, so an old row would parse to `{ channelId }` and post nothing. The browser also reads raw `node.data`, so it would need a second reader for the old shape.
- **One key: `{ channelId, message }`.** `channelId` stays a `channelPicker` with its `channelIdKey` sidecar, and `message` is one new `message` control. Four reasons:
  - A control edits one key (`renderControl.tsx:38-46`).
  - `visibleIssues` drops stale complaints by top-level key (`validationIssues.ts:55-60`), so any edit in the window clears that message's stale marks together.
  - `pendingFields` only exempts top-level keys (`nodeDataValidation.ts:128-137`), so `channelId` has to stay top-level.
  - Step 2's resource declaration holds the same `message` object.

  The `eligibility` control is the precedent for one control over one object-valued key.
- **The message model lives in `src/shared/discordMessage/`, outside flows.** Step 2's provisioning must not import flows (`provisioning/__tests__/dependencyDirection.test.ts`). Living outside flows also keeps embed words (thumbnail, footer, upload) out of the engine vocabulary gate, which scans `blocks/*.ts` (`engineVocabulary.test.ts:73-78`).
- **Uploads live in `src/features-system/guild-uploads/`**, shaped like `guild-settings`, for the same reason.
- **A picture part is one string**: `upload:<uuid>`, an http(s) link, or text holding a token.
  - Links and tokens are already one string today (`embedImageUrlSchema`), so the migration copies `imageUrl`/`thumbnailUrl` across unchanged.
  - Copy rendering treats the string as copy. An `upload:` value has no braces, so it passes through untouched.
  - One parser, `parsePictureRef`, is the only reader.
- **The upload body is raw bytes (`application/octet-stream`)**, with the display name in a `name` query parameter. Not multipart, not base64:
  - hey-api emits `bodySerializer: null` for an octet-stream body.
  - `@hono/zod-openapi` attaches validators to JSON and form bodies only, so the handler reads `c.req.arrayBuffer()`.
  - The request-rule walk only walks JSON bodies (`requestMessages.ts:156`).
  - Octet-stream isn't a CORS-safelisted content type, so a cross-site form can't send it at all. The cookie is also `SameSite=Lax` (`session.ts:84`).
  - Base64 would add a third to every body.
- **The editor shows an upload with `<img src="/api/guilds/{guildId}/uploads/{uploadId}">`.**
  - `setupClient` pins `parseAs: 'json'` and `Accept: application/json` for every SDK call.
  - `requireAuth` judges a request without the user header on the cookie alone (`middleware.ts:23`), so the image request is authenticated.
  - One helper, `uploadImageUrl`, in `web/src/api/`, builds the URL. A root test holds its path to the spec's `getGuildUpload` path.
- **Size caps**:
  - 8 MiB per picture (`8 * 1024 * 1024` bytes), the mockup's number. It is also that route's body cap. Every sentence a person reads says "8 MB", as Discord itself does, so the drop zone and the 413 agree.
  - 10 MiB of uploads per message, as one named constant, `MESSAGE_LIMITS.uploadBytes`. Discord's bot upload limit is believed to be 10 MiB on an unboosted server, but it is not certain whether that applies per file or per message, so the constant takes the stricter reading. Slice E measures it.
  - At most 10 distinct uploads per message (`MESSAGE_LIMITS.attachments`), Discord's file limit for one message.
  - The same upload used twice in one message is attached once.
- **Uploads are deduplicated per server by SHA-256, and each server has a 200 MiB cap in total.** The route sits in the Discord-free budget, so 8 MiB a request needs a ceiling. There was no delete in this step, so a server at the cap was stuck until the delete step; the delete route has since shipped ([uploads-page.md](uploads-page.md), slice A).
- **The window edits the node live.**
  - Every change goes through `onChange`, as every inspector control does today.
  - Undo, the draft autosave and the re-check on blur keep working. React's `onBlur` bubbles out of Mantine's portal.
  - **Cancel puts back the message as it was when the window opened**, with one `onChange`. Done closes the window.
  - A buffered draft that commits on Done would hide the window's edits from the server's re-check until Done.
- **`content` pings users**: `allowedMentions: { parse: ['users'] }`, as Send Message does. Today's `{ parse: [] }` was for embed bodies, which can't ping anyway.
- **The browser gets the message's type and per-part limits from the spec, with no hand-written mirror.**
  - A refinement-free `DiscordMessage` component is registered beside `DiscordResourceKind` (`openApiDocument.ts:44-46`).
  - It is built by the same `messageShape` function as the block's schema, with a plain `z.string()` in place of the refined picture.
  - `ControlChange` and the window's draft type are the generated `DiscordMessage`, so there is no hand-written type in `web/`.
  - The 6000-character total and the upload cap can't be stated as a part's rule. They are two mirrored constants, gated beside their authority the way `builtinTokenDrift` is.

## The model

### The message (`src/shared/discordMessage/`)

`messageShape({ picture })` is a function, so the block and the wire build the same structure:

```
{
  content?: string 1..2000,
  embeds: array(embed).max(10),
}
embed = {
  color?: '#RRGGBB',
  author?: { name: 1..256, iconUrl?: picture },
  title?: 1..256,
  url?: http(s) link,
  description?: 1..4096,
  fields: array({ name 1..256, value 1..1024, inline: boolean.default(false) }).max(25).default([]),
  thumbnail?: picture,
  image?: picture,
  footer?: { text: 1..2048, iconUrl?: picture },
  timestamp: boolean.default(false),
}
```

- **The block passes the refined `pictureRefSchema`**: an upload ref, a link, or text with a token. `src/web/api/messageBody.ts` passes `z.string()` and names the result `DiscordMessage`.
- **`messageProblems(message): { path, message }[]`** is a pure function holding the rules that span parts. Each is worded in the product's voice and addressed to its path:
  - The message needs content or at least one embed.
  - An embed can't be empty: "Embed 2 is empty — give it a title, some words, a field or a picture, or bin it".
  - A header or footer icon needs text beside it, because Discord drops the icon.
- **Where it runs:**
  - `messageConfigSchema = messageShape({ picture: pictureRefSchema }).superRefine` calls `messageProblems`, so the paths land under `message`.
  - `ruleOrderProblem` skips `custom` checks, and refinements don't appear in the JSON Schema export, so the emit is unaffected.
  - Step 2's journey route calls `messageProblems` from its handler, because a request schema refuses refines (the `declarationsRefusal` pattern in `journeyBody.ts`).
- **`timestamp` is a real boolean.** Today's string enum on a top-level segmented field exists only because of `checkFieldDefault`, and this value is built whole by the control.
- **Absent means left out.** The editor removes a cleared part rather than writing `''`, which the `.min(1)`s refuse.
- **`MESSAGE_LIMITS`** holds the 6000 total, the upload cap and the 10-file cap.
- **`messageCharacterCount(message)`** counts title, description, field names and values, footer text and author name across every embed, which is Discord's rule.
- **`messageCopyLocations(message)`** lists `{ path, where, maxLength }` for every copy string:
  - `content`;
  - each embed's title, description, author name and footer text;
  - each field's name and value;
  - each picture that isn't an upload.
  - `where` reads `"Message" embed 2 title` or `"Message" embed 1 field 3 text`, numbered from one.
  - It **runs on raw `node.data` at save time**, before the schema has judged it. It returns nothing for a value that isn't an object, skips any part that isn't a string, and leaves shape errors to the schema.
- **`messageUploadIds(message)`** lists each upload once.
- **`buildMessagePayload(message, uploads)`** returns `{ content?, embeds: EmbedBuilder[], files: [{ attachment: Buffer, name }] }`. Upload pictures become `attachment://<uploadId>.<ext>`. Step 2's install and repair use it too.

### The control

- **Vocabulary and arms.** `BLOCK_CONTROL_TYPES` gains `message`. Its `BlockConfigField` arm takes `swatches?` (the first one colours a new embed) and `defaultValue?`. It also needs:
  - its arm in `CONFIG_FIELD_ARMS` and the union (`nodeBody.ts`), which the `satisfies` and `nodeBody.test-d.ts` force;
  - its case in `renderControl.tsx` and in `cardSummary.ts`;
  - its value in the `ControlChange` union (`controls/types.ts`).
- **Conformance.**
  - `controlShapeProbes` gains a `message` entry: the schema must accept `{ embeds: [{ title: 'a' }] }` and refuse `{}` and `'x'`. That stops a block putting the control over a schema of another shape.
  - `isTokenField` counts a `message` field as copy-bearing. That keeps an embed title out of `emits.fromField`, since a written token would hide a loop.
  - The doc comments that name `isCopyField`/`renderNodeCopy` in `manifest.ts` are updated to match.
- **Nested errors.**
  - `fieldRuleIssueMessage` only words one-segment paths, so nested complaints carry the schema's own sentences.
  - `placeIssues` (`validationIssues.ts`) gains a third output, `nested: Map<fieldKey, { path, message }[]>`, for dotted paths under a drawn `message` field. Every other control's dotted issues stay at node level, as today.
  - `ControlProps` gains `issues?`, with paths relative to the field. The inspector shows "2 problems in this message", and the window marks the part each path names. Nothing is dropped.
  - `controlErrorProp.test.ts` needs no exemption: the control still reads `error` for its top-level "Fill this in.".
- **Field rules in the browser.**
  - `message` exports as `type: object` with keywords in `SERVER_ONLY_KEYWORDS`, so it is `unchecked` in `FlowBlockFieldRules`, and the emit passes.
  - **Why today's `.refine` passes:** `flowBlockFieldRulesSchema` builds fresh zod from JSON Schema keywords, and a block schema is never a request schema (node data is `z.record` on the wire). So `attachRequestMessages` never sees a block's `.refine`, and `.url()` exports as the server-only `format`.
  - The `DiscordMessage` component *is* walked as a request, so it carries only limits and fixed-sentence patterns. The window checks each part live against `zDiscordMessage` and reads its counters from that zod.
- **Defaults.** `defaultDataFor` needs no change. Post Embed declares no default message, because a declared default must parse and the rules need a non-empty one.
  - The window starts with one fresh embed in the first swatch's colour, and writes it on the first edit.
  - An untouched node gets "Fill this in." on Save.

### Tokens: one walk instead of two

- **Today there are two walks.** The executor (`executor.ts` `renderNodeCopy`) and save-time validation (`copyRendering.ts` `visibleCopyStrings`, read by `nodeRequirements.ts` and `graphValidation.ts`) each walk scalar copy fields and `objectList` columns separately.
- **Both are replaced by one `copyLocationsOf(field, value)`** in `copyRendering.ts`. It returns `{ path, where, maxLength }` for:
  - a `text`/`longText` field with `rendersTokens`;
  - each copy column of each `objectList` row;
  - every `messageCopyLocations` entry of a `message` field.
- `visibleCopyStrings` becomes a map over it. `renderNodeCopy` renders each location and writes it back with an immutable `setAtPath`, rebuilding only the containers it changes.
- **Nothing else changes**: not `TOKEN_REQUIREMENTS`, `checkCopyTokens`, the requirement causes, or the builder's token mirror. `{{subject.mention}}` in embed 3's footer needs a member through the same rule as in Send Message.
- A rendered picture is judged by a shared `renderedPictureProblem`, which is today's `renderedUrlProblem`.

### Uploads

- **Table `guild_uploads`.**
  - Columns: `id` serial/autoincrement, `upload_id` text unique (uuid), `guild_id`, `file_name` (for display, cleaned, ≤100), `content_type`, `byte_size` integer, `sha256`, `bytes` (**`bytea` on Postgres, `blob` on SQLite**), `uploaded_by`, `created_at`.
  - Indexes: unique `(guild_id, sha256)`, and `(guild_id, created_at)`.
  - The schema types `bytes` as `ColumnType<Buffer, Buffer, never>`.
  - Registered on `Database` and in `SqlDatePlugin` (`createdAt`) only. With no JSON or boolean columns, it is absent from both SQLite plugins, and `coerceSqliteBindingValue` passes a Buffer through.
  - Migration: `<date>-Create_Guild_Uploads.ts`.
- **Repo.** **Every read takes the guild**, so a config naming another server's upload id finds nothing.
  - `create` (returns the existing row on a hash match)
  - `listForGuild` (metadata only, never `bytes`)
  - `bytesFor(guildId, uploadId)`
  - `sizesFor(guildId, ids)`
  - `filesFor(guildId, ids)`
  - `totalBytesForGuild`
- **Sniffing.** `detectImageType(bytes)` reads the magic bytes:
  - PNG: `89 50 4E 47 0D 0A 1A 0A`
  - JPEG: `FF D8 FF`
  - GIF: `GIF87a` / `GIF89a`
  - WebP: `RIFF????WEBP`
  - Anything else is a 415: "PNG, JPG, GIF or WebP only — that's none of them". The stored type and extension come from the sniff, never from the name.
- **Routes.** `uploadRoutes.ts` is an `apiRouter` mounted at `/api/guilds`, so it gets `requireAuth`, the rate limiter and `requireGuildAccess`.
  - `POST /{guildId}/uploads?name=` (`uploadGuildImage`): octet-stream body. Answers 201 with a `GuildUpload`, 200 on a dedupe, 413, 415, and 409 when the server is at its cap.
  - `GET /{guildId}/uploads` (`listGuildUploads`): metadata, newest first.
  - `GET /{guildId}/uploads/{uploadId}` (`getGuildUpload`): the bytes, with the response declared as `image/*` binary and `X-Content-Type-Options: nosniff`. It answers `Cache-Control: private, max-age=31536000, immutable`, since an upload's bytes never change, and `noStoreApiResponses` leaves a route's own `Cache-Control` alone; every other `/api` answer, refusals from this route included, stays `private, no-store`.
- **Body limit.** `app.use('/api/*', apiBodyLimit)` becomes one middleware that picks the cap by route: `UPLOAD_BODY_LIMIT_BYTES` (8 MiB) for `POST /api/guilds/:guildId/uploads`, `API_BODY_LIMIT_BYTES` for everything else. Stacking a second `bodyLimit` wouldn't exempt the route, because both would run. The upload's 413 has its own sentence.
- **Rate limit.**
  - Add `{ method: 'POST', path: /^uploads$/ }` to `DATABASE_ONLY_WRITES` (`rateLimit.ts`).
  - Add `uploadGuildImage`, `listGuildUploads` and `getGuildUpload` as `general` in `EXPECTED_BUDGET` (`rateLimitClassification.test.ts`).
- **Error maps.** The 413/415 entries in `openApi.ts` say "not sent as JSON". The upload route gets its own error map instead of `GUILD_SCOPED_BODY_ERRORS`.

### Post Embed

- **Config**: `{ channelId, message }`, with `capabilities: ['sendMessages', 'embedLinks', 'attachFiles']`. `attachFiles` is new, in `BLOCK_CAPABILITIES` and in `nodeBody`.
- **`run`**, in this order (as built — see "As built"):
  1. The rendered message's text parts are trimmed, and a part left blank is dropped (`trimMessageText`).
  2. A field left blank after rendering fails, as today's check does, per embed.
  3. `messageProblems` again on the rendered message — an embed or message left empty, and the 6000 total.
  4. The channel (`requireChannelInGuild`, nearly always the cache).
  5. The uploads it names, for this guild only: sizes first, judged by `messageUploadProblems` — a missing upload fails naming the part ("`"Message" embed 1 image: That uploaded picture isn't in this server.`"), and more than 10 uploads or more than the byte cap fail giving the number — then the bytes.
  6. `channel.send({ ...buildMessagePayload(), allowedMentions: { parse: ['users'] } })`.
  - A rendered picture that is not a link is refused by the executor while rendering, not by `run` (`checkRendered` on its copy location).
- **Save time.** `uploadReferenceIssues(graph, uploadIndex)` in `logic/`, beside `guildReferenceIssues`.
  - It reports an upload id this guild doesn't hold at paths such as `message.embeds.N.image`, and a message showing more than 10 uploads or whose uploads together go over the cap at `message` — the same `messageUploadProblems` the run asks.
  - `flowReadinessIssuesInGuild` is synchronous and has nine callers (`deployFlowButtons.ts`, `flowBody.ts`, `flowDraftRoutes.ts`, and six in `flowRoutes.ts`). It takes the upload index as a fourth argument.
  - Each caller first awaits `loadUploadIndex(guildId, graphs)`, which makes no query when no graph names an upload. That load must never run inside a `flowsRepo` transaction: SQLite has one connection, and a query inside a transaction deadlocks.
- **Card**: `[{ key: 'channelId', emptyText: 'no channel picked' }, { key: 'message', prefix: ' · ', quote: true, truncate: 20, hideWhenEmpty: true }]`. A `message` value renders as its headline: the first embed's title, else its body, else the plain text, else `N embeds`. Add this row to the contract's card table.

### The migration (`<date>-Post_Embed_Message_Shape.ts`)

- **Pattern**: `2026-10-10-Owner_Keyed_Resource_Bindings.ts`. Select the rows, loop in TypeScript, and write back with `JSON.stringify`, on the production stack: `SqliteJsonPlugin` parses `flows.graph` and `flow_drafts.graph`. The SQLite arm opens its own `db.transaction()`.
- **What it rewrites**: both `flows.graph` and `flow_drafts.graph`. Nothing else holds Post Embed config:
  - journeys hold no graph;
  - parked runs execute the live `flow.graph` (`flowRunResume.ts`) and keep only ids in their snapshot;
  - Post Embed can't park.
- **The transform** is frozen inside the migration file and never imported from the block:
  - `title`, `description`, `color` and `url` move into embed 0;
  - `authorName` becomes `author.name`, and `footerText` becomes `footer.text`;
  - `imageUrl` becomes `image`, and `thumbnailUrl` becomes `thumbnail`;
  - `fields` move as they are, with `inline` defaulted;
  - `showTimestamp: 'true'` becomes `timestamp: true`;
  - empty strings (`''`) are dropped;
  - `channelId`, `channelIdKey` and any unknown key stay at the top level.
- **Idempotent**: a node that already has `message` is skipped. `FLOW_GRAPH_VERSION` stays 1: nothing branches on it, and it is checked on every read of a stored graph (`validateFlowGraph` in `flowsRepo`/`flowDraftsRepo`), so bumping it to fence off stale builder tabs would make one row the migration missed fail its guild's whole flow list.
- **`down`** writes embed 0 back to the flat keys and loses everything else: plain text, other embeds, icons and uploads. The file header says so.
- **Deploy notes**:
  - `dockerEntrypoint.sh` runs migrations before the bot starts.
  - Rolling back without running `down` leaves every Post Embed unparseable.
  - A builder tab left open across the deploy still holds the old `/api/nodes` descriptor and the old graph. Stored as sent, its flat Post Embed nodes would lose their keys to `withDeclaredNodeData` — on a switched-off flow straight in `flows.graph`, erasing the embed the migration carried across. So every save carrying a Post Embed node with an old flat key and no `message` — the flow save, create, the draft autosave and the check — is refused with "Reload the page, then save again" (`staleBuilderRefusal`, `src/web/api/staleBuilderGraph.ts`). It is a one-deploy bridge, to be removed once no tab can predate it.

## Slices

| # | Change | Proof |
|---|---|---|
| **A** | **Uploads backend.** `guild-uploads` schema, repo and migration; registration on `Database` and `SqlDatePlugin`; `detectImageType`; `uploadRoutes.ts` and its mount; the per-route body limit; `DATABASE_ONLY_WRITES`; dedupe; the per-server cap; `pnpm sdk:generate` | **Repo tests on SQLite**: bytes round-trip byte for byte; the list never selects `bytes`; every read is scoped to the guild (another guild's id finds nothing). **Sniffer table test**: the four types, and four lookalikes (a `.png` that is text, an SVG, a truncated header, a `RIFF` that isn't WebP). **Route tests**: 201, then 200 on a re-upload; 415; an upload of 8 MiB + 1 byte gets 413 with the upload sentence; **a 2 MiB body to any other `/api` route still gets 413** (sabotage: route every path to the upload cap); a foreign guild gets 403. **Gates**: classification, `everyRouteInSpec`, `openApiSpec`, `generatedSdkIsCurrent`. **Generated SDK**: check `uploadGuildImage` has `bodySerializer: null` and an octet-stream `Content-Type`. **Live Postgres** (Docker `postgres:16`): migrate, upload a PNG, read it back and compare SHA-256; `bytea` comes back as a Buffer |
| **B** | **Message model, control and token walk.** `src/shared/discordMessage/` (`messageShape`, `messageProblems`, limits, count, copy locations, picture refs, upload ids, payload builder); `message` in the vocabulary, the manifest arm, `nodeBody`, `controlShapeProbes`, `isTokenField`, the manifest comments; the `DiscordMessage` component; `copyLocationsOf`, with `visibleCopyStrings` and `renderNodeCopy` on it; `placeIssues` `nested` and `ControlProps.issues`; a minimal `MessageControl` (mini preview and issue count, no window yet) so web `tsc -b` passes | **Model unit tests**: the schema at each limit and one over; each `messageProblems` rule at its path; `messageCharacterCount` against Discord's rule; `messageCopyLocations` labels, and its result for a non-object and for a part that isn't a string. **Drift**: one fixture set through the block's schema and through `zDiscordMessage` agrees on every case except picture form. **Unchanged behaviour**: every existing `runVariables`, `subjectAbsentRuns` and copy test passes on the `objectList` path, since the walk under them was replaced. **A synthetic block with a `message` field**: `{{subject.mention}}` in embed 2 field 1 is refused at save under a trigger about nobody, naming `"Message" embed 2 field 1 text`, and the executor expands it (sabotage: drop the `message` arm from `copyLocationsOf`, and both fail). **Conformance**: refuses a `message` field over `z.string()`, and refuses one named in `emits.fromField`. **Spec**: `nodeBody.test-d.ts` passes, and the `blockFieldRules` emit passes with the field `unchecked`. **`validationIssues`**: an issue at `message.embeds.0.title` goes to `nested`, and `fields.0.name` on an `objectList` stays at node level |
| **C** | **Post Embed on the new shape.** Block schema, fields, card, `run` with attachments, `attachFiles`; `uploadReferenceIssues`, and the index on all nine callers of `flowReadinessIssuesInGuild`; the migration; TestDiscord learns multipart (`payload_json` plus `files[n]`; `restRouter.ts` refuses it today) and the embed members it refuses today (`author`, `url`, `image`, `thumbnail`, `footer.icon_url`, `attachments`; `messageSchemas.ts`); retarget the tests that break by construction (listed below the table) | **Migration on SQLite** through a real `Migrator`, after the pattern in `ownerKeyedResourceBindingsMigration.test.ts`. Seed old-shape nodes in both tables: one complete; one incomplete (`title: ''`); one with a `channelIdKey` sidecar; one with fields and `showTimestamp: 'true'`; one with tokens in the image. Also seed a Send Message node and an already-migrated node. Run up, down, then up again: pin the exact serialized output, and check that **every complete migrated node passes the live `validateNodeData`**, which ties the frozen transform to today's schema. **Live Postgres**: seed, up, down, up. **Run tests against TestDiscord**: content plus 2 embeds plus an uploaded thumbnail arrives as one multipart message; the file is named `<id>.png` and the embed points at `attachment://<id>.png`; an upload used twice is attached once; a missing upload, another guild's upload, and a total over the cap each fail by name; `allowedMentions` is `users`. **Save time**: another guild's upload id is a readiness issue, and the flow can't be switched on |
| **D** | **The window.** In `web/src/flows/messageEditor/`, a full-width Mantine `Modal` with: a stage that looks like Discord; parts you click to edit, with counters from `zDiscordMessage` and the `{x}` `VariablePicker` (which appends, as today); the colour swatch (`ColourControl`'s swatches); move, duplicate and delete; Add embed ("n of 10"); the picture popover (Upload, Link and Token tabs, and "Already uploaded to this server"); Preview mode, with `copyPreview` stand-ins and a placeholder face for `{{subject.avatarUrl}}`; the footer meter; Cancel restoring the opening snapshot. Pure edit operations live in `messageDraft.ts`. The page supplies `context.uploads` (`{ items, upload(file) }`) from `listGuildUploads` and `uploadGuildImage`, so the control fetches nothing. Pictures render through `uploadImageUrl` | **`dom` tests**: clicking the title edits it and emits a new object, never a mutated one; clearing a part removes it; add, move, duplicate and delete work, and the tenth embed hides Add; a nested issue marks its part and the inspector's count; Cancel emits the snapshot; **no input is ever `disabled` while an upload is in flight**; the popover's upload goes through `installFakeApi` and writes `upload:<id>`. **`messageDraft.test.ts`** covers the operations. **e2e** (`web/e2e/postEmbedMessage.test.tsx`): open a migrated Post Embed, upload a PNG, set a footer icon, save, run the flow against TestDiscord, and the message carries the file. **Preview**: a `pnpm preview:dashboard` seed with a two-embed Post Embed; `preview:shoot` at 1440 and 1280 with the window open, and both checked by hand |
| **E** | **Docs and live checks.** `block-authoring.md` (a control table row, a card table row, the copy section on nested copy, the allowlist line, mirror table rows for the two constants); `AGENTS.md` (the uploads route group, the body-limit exception); the PRD and build order; the step 1 line in the design doc; an "As built" section in this plan | **Live guild, unboosted**: an existing Post Embed flow posts the same embed after the migration; plain text plus 3 embeds, header and footer icons from uploads, and a token thumbnail all post; a message carrying about 9.5 MiB of uploads shows whether Discord takes it or answers 413, and whether the limit is per file or per message, and the constant is set from that answer; `attachment://` really draws in `author.icon_url` and `footer.icon_url`. **Suite**: full suite at the quiet baseline, root `tsc` at baseline, web `tsc` at 0 |

**Tests that break by construction**, retargeted in C:

- `blockFieldRules.test.ts`: use `action.kickMember`'s `reason` instead.
- `newNodes.test.ts`.
- `nodeDataValidation.test.ts`: its dotted paths become `message.embeds.0.…`.
- `runVariables.test.ts`.
- `subjectAbsentRuns.test.ts`.
- `pendingResourceFields.test.ts`: the comment only.

Nothing under `web/` or `templates/` names Post Embed.

**Review**: one reviewer pass after C, and one after D. This step adds a persisted table holding bytes, a graph-rewriting migration and a new control, and replaces the engine's copy walk.

## As built

### Slices A–C

**Live Postgres** (throwaway `postgres:16`, env on the command line, container removed after):

- **Slice A**: the `guild_uploads` migration and the `bytea` round-trip passed.
- **Slice C's migration**, first run: up, down, up passed; `graph` still `jsonb`; 3 warnings.
- **Re-run after the review fixes** (the title-link rule and the deploy note changed the migration): seeded a flow mixing flat Post Embeds (complete, a spaced title link and image, an unparseable `https://a%zz/x` title link), an already-migrated node with plain text, two embeds and an upload, a Send Message node, a flow with no Post Embed, and a flat draft. Up, down, up passed; both `graph` columns stayed `jsonb`; each up logged 3 warnings (the spaced title link, the spaced image, the unparseable title link); down cut the migrated node to embed 0 without its upload; the second up matched the first everywhere else, and the flow with no Post Embed was never rewritten.

**Deviations from the plan above**, from the slice C review:

- **Upload rules have one home**: `messageUploadProblems` in `src/shared/discordMessage/`, asked by `uploadReferenceIssues` at save and by Post Embed's `run`. It adds Discord's 10-file cap (`MESSAGE_LIMITS.attachments`). The byte cap has one name, `MESSAGE_LIMITS.uploadBytes`; `DISCORD_MESSAGE_UPLOAD_LIMIT_BYTES` is gone.
- **The 6000 total is judged at save** by `messageProblems`, counting only the text outside `{{tokens}}`, so it never refuses a message that could post. The run judges it again once rendered.
- **A picture token must render to a link**, judged by the executor (`checkRendered` on a message picture's copy location) — so `{{var.pic}}` holding `upload:<id>` is refused, never attached.
- **Rendered text parts are trimmed** and a blank one dropped before the run's checks, so an all-blank message fails in the product's words rather than with Discord's 400.
- **Title links must parse** (`URL.canParse`), checked server-side in `messageConfigSchema`; the wire keeps the pattern. The migration's warning agrees.
- **Stale builder tabs** are refused at save rather than allowed to write flat drafts (see the deploy notes); `FLOW_GRAPH_VERSION` was deliberately not bumped.
- **A flow PUT judges only what it can refuse**: a switch-off or a rename is never judged, so never refused. Uploads are read for the graph being judged only, and the post-write read happens only when that read does not cover the graph(s) written.

### Slice D — the window

`web/src/flows/messageEditor/`. The inspector's `MessageControl` shows a compact preview, "N problems in this message" and **Edit message**, which opens the window.

- **The window** is a centred Mantine `Modal`, 1180px wide. The stage is drawn in Discord's colours: the bot's name and APP badge, the plain text under it, then the embeds. An Edit / Preview toggle sits in the header. Preview fills tokens with the builder's stand-ins (`copyPreview`) and shows a stand-in face for a picture only a run can fill, such as `{{subject.avatarUrl}}`.
- **Live edits.** Every edit goes straight through `onChange`. It is applied to the latest message (a ref), not the one a render saw, so an upload that answers late doesn't undo typing done since.
- **Closing.**
  - **Cancel** puts back the message as it was when the window opened, with one `onChange`; a node that had no message gets its key removed.
  - **Done, the X ("Close, keeping the changes") and Escape** all keep the changes. Escape inside a popover closes the popover, Escape in a part being typed into finishes the part, and only otherwise does it close the window. Mantine's own `closeOnEscape` is off.
- **The `cancelled` ref is set by Cancel alone**, never by closing or unmounting. That makes it StrictMode-safe: an earlier version kept state in a ref across StrictMode's mount, cleanup, mount, thought it had closed the moment it opened, and took no edits in `pnpm dev`. The window's tests render under `StrictMode` (`renderStrict`) so that fails in the suite. It also means an upload that lands after Done still writes, and one that lands after Cancel doesn't.
- **The meter** in the footer counts as a save counts: the embeds' text outside `{{tokens}}`, against 6000. It is the hand mirror in `messageCharacters.ts`, gated by `messageMeterDrift.test.ts`. Every per-part counter and sentence is read from the SDK's `zDiscordMessage` (`partRules.ts`), and so are `MAX_EMBEDS` and `MAX_FIELDS`.
- **During an upload nothing is `disabled`**, because a focused input that is disabled loses its focus. The embed tools that renumber embeds (move, duplicate, delete) are held instead, because an upload lands on the embed at the position it was sent from. The `Tool` component's own `inert` prop renders `aria-disabled="true"`, drops the click, and adds "waits for the upload to finish" to the tooltip. It is not the HTML `inert` attribute. Add embed only appends, so it is never held.
- **Colour** is written by the `ColorPicker`'s `onChangeEnd`, so a drag commits once, as one undo step. The picker is keyed by the colour, so a colour set from outside (undo, "No colour") shows.
- **The picture popover** has Upload, Link and Token tabs, plus "Already uploaded to this server". The page supplies `context.uploads` from `useGuildUploads` (`listGuildUploads`, `uploadGuildImage`), so no control fetches. A finished upload goes to the top of the cached list.
- **Tests and preview.** Tests: `MessageEditor.test.tsx`, `messageDraft.test.ts`, `messageIssues.test.ts`, and the e2e `web/e2e/postEmbedMessage.test.tsx`. The `preview:dashboard` seed is `web/e2e/preview/scenario/seedMessageEditor.ts`.

**Deviation from the plan**: it planned two mirrored constants, the 6000 total and the upload cap (Decisions, and E's mirror-table rows). Only the total is mirrored. The window never judges the upload total: the save's readiness issue does, and the window shows it like any other complaint. The only upload-size words in `web/` are the literal "up to 8 MB" in `PictureSlot.tsx`, a hand copy of `UPLOAD_SIZE_LABEL` with no gate.

### Slice E — docs

Done 2026-10-24:

- `docs/contracts/block-authoring.md`: the `message` control row and its card row; the copy section on the one walk, nested copy and `checkRendered`; the token table, which had been missing four tokens since before this step; `uploadReferenceIssues` beside `guildReferenceIssues`; the two message mirrors.
- `AGENTS.md`: `guild-uploads`, `shared/discordMessage`, the bridge, the upload's rate-limit group, `uploadImageUrl`.
- `infra/README.md`: the body-limit exception, and the picture's cache header.
- Notes in the PRD and the build order.
- The design doc's step 1 line, and its "Step 1 as built".

## The live run

Slice E's second half. On an unboosted guild, against the production stack (Postgres, behind the tunnel). Nothing below has been run.

1. **The migration.** An existing Post Embed flow, saved before the deploy, posts the same embed after it: title, body, colour, fields, image, thumbnail, author and footer, and the timestamp if it had one. `dockerEntrypoint.sh` migrates before the bot starts. Check its log for the migration's warnings.
2. **The full message.** One Post Embed must arrive as one message:
   - plain text pinging the member;
   - three embeds;
   - a header icon and a footer icon from uploads;
   - a thumbnail from `{{subject.avatarUrl}}`.
3. **`attachment://` in the icons.** Discord must draw the uploaded picture in `author.icon_url` and `footer.icon_url`, not only in `thumbnail` and `image`. If it doesn't, an upload can't be offered for the icons, and the picture popover must change.
4. **The upload limit**, which sets `MESSAGE_LIMITS.uploadBytes` (and the sentence in `messageUploadProblems` that quotes it).
   - Post a message carrying about 9.5 MiB across several uploads, each under 8 MiB. Record whether Discord takes it or answers 413.
   - Then find out whether the limit is per file or per message: send more than 10 MiB in total, with every file under it (two of about 6 MiB). Today's 10 MiB cap refuses that at save and in `run` before Discord sees it, so this probe needs the constant raised in a local build, or a direct REST send.
   - If the limit is per message, set the constant to the measured total. If it is per file, the per-message cap is the wrong rule: the 8 MiB per picture already sits under it. Say which in the constant's comment.
5. **The stale-tab refusal.** Open a builder tab on the old build, deploy, and save from that tab. The save is refused with "Reload the page, then save again", and the stored graph still holds `message`. Then remove the bridge in a later deploy (see `AGENTS.md`).
6. **The upload through the tunnel**, at `brattybot.fettra.app`:
   - an upload of nearly 8 MiB answers 201;
   - one byte over answers the app's 413 sentence, not a Cloudflare page;
   - the picture shows in the window;
   - its response is not served from Cloudflare's cache (`cf-cache-status` is not `HIT`).

   The hand-set rules in `infra/README.md` §6 are the North America geo-block and the login rate limit. **Neither caps a request body.** The only edge cap is the zone plan's own request-body limit, 100 MB on the Free plan. Confirm the zone's plan rather than trust that number.
7. **The suite**: the full suite at the quiet baseline, root `tsc` at its baseline, and web `tsc` at 0.

## Owner might disagree

- `{ channelId, message }`, rather than `content` and `embeds` at the top level.
- The window writes live and Cancel restores, rather than buffering edits until Done.
- Dedupe, plus a 200 MiB cap per server with no delete yet (the delete has since shipped: [uploads-page.md](uploads-page.md), slice A). The alternative is no cap until the delete step.
- 10 MiB per message as the working guess until E measures it.
- Editor images load through `<img src>` and the cookie, not through the SDK. A session that expires mid-edit shows a broken picture rather than the sign-in panel. The alternative is one SDK call per image with `parseAs: 'blob'` and object URLs.
- The card shows the headline, not "N embeds", when the message has a title.
- Post Embed may post plain text with no embed at all, because the same model serves step 2's messages.

## Open questions

- Discord's upload limit for a bot, and whether it applies per file or per message (slice E).
- Whether hey-api's octet-stream call sets `Content-Type: application/octet-stream` or keeps the client's JSON default. Slice A finds out; if it keeps the JSON default, the call passes the header itself.
- Whether `attachment://` links draw in the header and footer icons (`author.icon_url`, `footer.icon_url`). Slice E checks.
