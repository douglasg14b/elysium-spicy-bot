# An Uploads page: list, upload, delete, and what each picture is used by

> **Status**: Built 2026-10-24; live run pending. Slices A and B are described under "As built". Douglas approved the plan and all three picks ("build away").
> **Owner**: Douglas
> **Follows**: [message-editor-step-1.md](message-editor-step-1.md). That step shipped uploads with no delete and no overview ("Not in step 1: deleting an upload").
> **Mockup**: [uploads-page.mockup.html](../../nimbalyst-local/mockups/uploads-page.mockup.html)

## The gap

A server can upload pictures from the message editor, but nothing shows what it holds or lets it remove anything. A server that reaches its 200 MB cap stays stuck there. An author also can't tell whether a picture is still used before getting rid of it.

## What it does

- **A sidebar page, "Uploads"**, after Flows. It has:
  - a meter showing "38.4 MB of 200 MB used";
  - a drop zone that takes several pictures at once;
  - a grid of cards, newest first, filtered by All / In use / Unused.
- **Each card shows:**
  - the picture, its type, name and size;
  - who uploaded it (their server display name, or their id if they've left) and when;
  - **where it's used.** Each use is one row naming the flow (with a link), the block, and the part, such as "Welcome flow · Post Embed · embed 1 thumbnail". A use that lives only in someone's unsaved draft is marked DRAFT.
- **Delete** opens a dialog.
  - If nothing uses the picture, the dialog deletes it. It also says that messages the bot has already posted keep their copy, because Discord holds those copies, not us.
  - If something uses it, the dialog refuses and lists each use, so the author knows what to swap out first.
- **The server decides.** The page's list can be out of date, so the delete route checks for uses again and refuses (409) with the current list.

## The model

### What uses an upload: a reader hook

- `guild-uploads` imports no feature (AGENTS.md), but flows knows where pictures sit. So `guild-uploads` defines `registerUploadUsageReader(reader)`, following the `ticketTypeProvider` / `resourceWriteBack` precedent. A reader is `(guildId) => Promise<readonly UploadUse[]>`.
- **Flows registers one reader in `initFlows`.** It walks every flow's saved graph and every draft for the guild.
  - It finds any field whose control is `message`, not Post Embed by name, and reads its pictures with `messagePictures` + `parsePictureRef` from `src/shared/discordMessage/`.
  - Each use it returns: `{ uploadId, flowId, flowName, nodeId, blockLabel, where, draftAuthorId? }`.
- Step 2's message resources will register a second reader. *(As built: `UploadUse` names a flow and a node, which a message resource has neither of, so step 2 also widens that type and its wire shape.)*
- **A use in a draft counts as a use.** Deleting the picture would quietly break somebody's unsaved work.

### Routes (`uploadRoutes.ts`)

- **`GET /{guildId}/uploads`** gains `uses` on each upload, plus the server's `totalBytes` and cap, so the page needs one call.
  - It reads every flow and draft graph of the guild. That's the same read the flows list does today; no new kind of cost.
  - **It never runs inside a transaction** (SQLite's single connection).
- **`DELETE /{guildId}/uploads/{uploadId}`** (`deleteGuildUpload`):
  - 204 when deleted;
  - 404 when there's no such upload in this server;
  - 409 `{ error, uses }` when something uses it.
  - It runs on the same per-server queue `storeGuildUpload` already uses, so an upload and a delete of the same picture can't interleave.
- **Rate limit:** the delete never calls Discord, so it joins `DATABASE_ONLY_WRITES`. It goes in `rateLimitClassification.test.ts` too.

### The race that's accepted

A flow can be saved naming the picture in the moment between the delete's check and the delete itself. Nothing is lost in that case:
- a run of that flow fails with "that uploaded picture isn't in this server";
- the flow's next save or check reports that same sentence on the node. *(As built: not the save in the window itself. It read the server's uploads before the delete, so it judges the flow ready.)*

Holding the per-server queue across flow saves would mean taking a lock in the flow routes, which isn't worth it for this.

### The page (`web/src/pages/UploadsPage.tsx`)

- **Calls:**
  - the list with `useQuery(listGuildUploadsOptions(...))`;
  - uploads with the SDK's `uploadGuildImage`, one picture after another, each showing its own progress;
  - deletes with `useMutation(deleteGuildUploadMutation())`.
- Pictures show through `uploadImageUrl`, and are cached for good because an upload never changes.
- **Never `disabled` on anything focused while an upload is in flight** (memory note on focus).
- The editor's "Already uploaded" grid reads the same list, so a delete is gone from it on its next load.

## Slices

| # | Change | Proof |
|---|---|---|
| **A** | Reader hook, flows' reader, `uses`/`totalBytes` on the list, the delete route, rate limit, `pnpm sdk:generate` | Flows' reader finds a picture in a live graph, a draft, a non-first embed, a header and a footer icon; it ignores another server's flows; it finds the `message` field by control, not by block type (fixture block). Delete: 204 when unused; 409 listing a live use and a draft use; 404 for another server's id (sabotage: drop the use check, watch the 409 test fail). The list never reads `bytes`. Gates: classification, spec, SDK |
| **B** | The page, the sidebar entry, preview seed and screenshots | `dom`: cards show their uses and the DRAFT mark; the filter works; Delete on an unused picture removes it; Delete on a used one shows the refusal with its uses; a 409 that comes back while the page thought it unused shows the server's list; several dropped pictures all upload; nothing is disabled during an upload. `preview:shoot` at 1440 and 1280, checked by hand against the mockup |

One review pass after A.

## As built

### Slice A (2026-10-24)

- **The hook** is `guild-uploads/logic/uploadUsage.ts`: `registerUploadUsageReader` (a plain list, as `registerActivitySubscriber`), `uploadUsesForGuild` (every reader at once, joined), and `clearUploadUsageReadersForTests`.
  - Asking with no reader registered throws. That catches a boot root that wired none; it can't tell that one of several readers is missing.
  - Registered by `initFlows`, by `web/e2e/support/bootBot.ts`, and by the two whole-app route tests (`uploadRoutes.test.ts`, `uploadServing.test.ts`).
- **Flows' reader** is `flows/logic/flowUploadUses.ts`. It never runs in a transaction.
  - It finds `message` fields through `messageFieldsOf` from `uploadReferences.ts`, now exported and carrying the block, so the save-time check and the reader find them the same way.
  - It reads a message's uploads through `messageUploadPlaces`, new in `shared/discordMessage/messageParts.ts`. That is now the one reading of `upload:` refs off a message: `messageUploadIds` and `messageUploadProblems` use it too.
  - **It reads drafts, then flows.** A save that lands on the flow writes the graph and discards its author's draft in one commit. Read in this order, a picture moving from draft to flow between the two reads is still seen. Read the other way round, it would be in neither.
  - One use per place, so a picture shown twice in one node is two uses.
  - **A draft's use is listed only if the saved flow doesn't already show the picture at that node and part.** So DRAFT marks a use that is only in a draft. It carries `draftAuthorId` and the draft's own name (a rename is part of the draft).
  - `where` is `messagePictures`' own wording ("embed 2 header icon"), with no field label in front. No shipped block has two `message` fields; one that did would make `where` ambiguous.
  - **A field its `visibleWhen` hides still counts.** The picture stays in `node.data`, and switching the choice back shows it again. The fixture block `actionSometimesPostsMessage` proves it.
  - A node whose block is gone is skipped.
- **The delete** is `guild-uploads/logic/deleteGuildUpload.ts`. The queue moved to `logic/oneAtATimePerGuild.ts`, shared with `storeGuildUpload`. Inside one queued step, in order:
  1. does this server hold the id (`guildUploadsRepo.holds`)? If not, 404. So an id copied from another server is a 404 even when one of this server's flows names it.
  2. what uses it? If anything does, 409.
  3. `guildUploadsRepo.delete(guildId, uploadId)`. If no row goes, it throws: only this queue deletes uploads, and step 1 just found the row.
- **Wire shapes** (`uploadBody.ts`):
  - `UploadUse` (no `uploadId`), held to the domain type by `SchemaMatches` (`uploadBody.test-d.ts`).
  - `GuildUploadListing` (`GuildUpload` + `uses`) and `GuildUploadList` (`uploads`, `totalBytes`, `limitBytes`). `totalBytes` is added up from the listed rows, so it matches them.
  - `UploadInUse` (`ErrorBody` + `uses`).
  - The upload's own answer stays plain `GuildUpload`.
- **The SDK's `ApiError` carries `uses`** (empty for every other refusal, as `issues` is), so the page can show a 409's list.
- **Copy:** `UPLOAD_GUILD_FULL_SENTENCE` now points at the Uploads page, which slice B builds. The 409 says `UPLOAD_IN_USE_SENTENCE`.
- **The builder reads the same list, uses included.** Every builder open now walks the guild's flows and drafts. That's the plan's "same read the flows list does". It also means one draft whose stored graph fails validation makes the list a 500 for the whole server, as it already does for the flows list. Not split into a lighter route: the plan accepted the cost.
- **The builder's uploads hook** (`web/src/flows/useGuildUploads.ts`) keeps the list in step after an upload, and writes through `writeSavedAnswer`:
  - a new picture (201) goes on top with no uses and adds to `totalBytes`;
  - a re-upload (200) the list already has moves to the top as it was;
  - with no list loaded, or a re-upload the list doesn't have, it fetches the list again.
- **Not done:** `flow_drafts` has no `guild_id` index, and `listByGuildId` is the first read by guild. The table is small; add the index in a later migration if it grows.
- **Proof:**
  - `flowUploadUses.test.ts`, `uploadUsage.test.ts`, `oneAtATimePerGuild.test.ts`, the repo's delete case, `apiError.test.ts`, and the list and delete cases in `uploadRoutes.test.ts`.
  - Sabotage, each test failing then passing once restored:
    - with the use check removed, "refuses with 409 and every use while a saved flow or a draft shows it, and keeps it" failed (204, expected 409);
    - with the delete taken off the queue, "holds a delete until the write queued before it for the same guild has finished" failed;
    - with hidden fields skipped, "counts a picture a hidden message field still holds" failed.

### Slice B (as built)

- **The page** is `web/src/pages/UploadsPage.tsx`, routed at `/uploads`, with a sidebar entry after Flows (marked NEW, as Flows still is). Its parts are in `web/src/uploads/`, and the page only wires them together.
- **One upload path.** `uploads/keepGuildUpload.ts` holds the upload, the cache patches (`withKeptFirst`, `withoutUpload`) and the wording of a refusal (`uploadRefusalSentence`). The builder's `flows/useGuildUploads.ts` is now just a hook over it. So flows depends on uploads and not the reverse, and the page and the builder's picture box share one query key.
  - **A file over 8 MB is refused before it is sent**, on both the page and the builder. The server would refuse it from its declared length alone, but by then the browser is streaming megabytes at a server that has already answered, and the 413 can arrive as a connection reset.
  - Each patch goes through `writeSavedAnswer` as an updater. A new picture's bytes are counted once, even when a read that already holds it landed first.
- **Mirrors.** The cap (`uploads/uploadLimits.ts`) and the delete route's not-found sentence (`uploads/serverSentences.ts`) are hand-written mirrors. `uploadSizeLabelDrift.test.ts` and `uploadSentenceMirrors.test.ts` hold them to the server's values. The accepted types come from the SDK's `zGuildUpload` (`uploads/uploadTypes.ts`).
- **The batch** (`uploads/useUploadQueue.ts`) sends one file at a time. A drop during a batch joins its end. Each file shows waiting, uploading, kept, already held (under the name the server kept), or refused in the server's words. The list is read again once the batch ends.
  - Leaving the page stops the batch. The picture on its way finishes, and the ones still waiting are not sent.
  - A file dropped beside the drop zone is held by a `window` listener, so the browser does not open it in place of the dashboard.
- **Delete** (`uploads/DeleteUploadDialog.tsx`):
  - A 409 turns the dialog into the refusal with the server's `uses`, and moves focus to its Close.
  - A 404 with the route's own sentence is "Already gone": the dialog closes and the card goes. Any other 404 is an ordinary error.
  - After a delete, focus goes to the page heading. After Keep it or Close, it goes back to the card's Delete button.
- **Nothing is ever `disabled`** while an upload or delete is in flight; Mantine's `Button loading` would be. A busy button changes its words and ignores a second click.
- **The meter rounds the used figure down**, so a server with room left never reads "200 MB of 200 MB".
- **Proof:**
  - The `dom` suite `UploadsPage.test.tsx`; `keepGuildUpload.test.ts`; `byteSize.test.ts`; `timestamps.test.ts`; the editor's oversized-file case.
  - The delete and upload tests hold the list's follow-up read, so they assert the page's own patch.
  - Sabotage, each test failing then passing once restored:
    - with `withoutUpload` returning the list unchanged, the delete tests failed;
    - with `withKeptFirst` skipped, the batch test failed;
    - with the 409 focus effect removed, the 409 test failed;
    - earlier, with `loading` on Delete, "disables nothing" failed;
    - with the batch sent all at once, the one-at-a-time test failed.
- **Preview:** `web/e2e/preview/scenario/seedUploads.ts` seeds the pages `uploads`, `uploads-delete-unused` and `uploads-delete-used`.

## Not in this

- Uploader and draft-author names; the page shows "you" or the Discord id, since the API has no member lookup.
- Renaming a picture.
- Replacing a picture everywhere it's used.
- Deleting several at once.
