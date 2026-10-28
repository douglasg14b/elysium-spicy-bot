# Contract — Authoring a flow block

- **Status**: Active (2026-09-12)
- **Applies to**: `src/features/flows/blocks/`
- **Audience**: anyone adding a capability to the flow engine

A **block** is a definition — one thing a flow can do. A **node** is an instance of a block
placed on someone's canvas. This document is the whole contract for writing a block. If you
can read this, you can add one; if you find yourself needing something it does not describe,
see [When the contract cannot express what you need](#when-the-contract-cannot-express-what-you-need)
— that is a real part of the process, not a failure.

## The one-directory rule

Adding a block means **creating one directory** and nothing else:

```
src/features/flows/blocks/actionRenameChannel/
    index.ts          # exports `block`
    __tests__/        # optional, and yours
```

No registry to append to, no barrel line to add, and **no file under `web/src/flows`**. The
registry finds your block by scanning this tree at startup, and the builder draws its palette
entry, its card, its form, and its output handles from what your manifest declares. If you ever
have to edit a shared file to make a block appear, something has regressed — say so rather
than editing the shared file.

Then run `pnpm sdk:generate`. It writes nothing of yours: it regenerates the committed spec and
dashboard SDK, which carry the rules the builder checks your fields against as the author types
(see [Your schema is checked in the browser](#your-schema-is-checked-in-the-browser--write-nothing-for-it)).
The suite fails until you have.

Two rules the scan enforces, both as named errors rather than a block quietly missing:

- the directory must contain `index.ts` exporting a const named **`block`**
- no two blocks may declare the same `type`

A directory whose name starts with `_` or `.` is skipped, which is how scratch and fixture
trees live here harmlessly.

### Discovery happens once, at startup

Because the scan reads the filesystem, it is asynchronous, and the registry refuses a read that
arrives before it finishes rather than reporting your block as missing. `initFlows()` awaits
discovery and `bot.ts` awaits `initFlows()` before the web server starts, so nothing you write
inside a block or a handler has to think about it.

It matters in exactly one place — **a test that reads the registry**, directly or through the
executor or save-time validation:

```ts
beforeAll(async () => {
    await ensureBlocksDiscovered();
});
```

Skip it and the failure names itself. Calling it more than once is free; it scans once and hands
every later caller the same registry.

## The manifest

`block` is a `BlockManifest<TConfig>`, where `TConfig` is your validated config — what your
schema produces and what your `run` receives. Every member is required unless the table below
marks it optional; arrays are declared empty rather than omitted, so a reader can see you meant it.

| Member | What it is |
| --- | --- |
| `type` | Stable identifier, `<kind>.<camelCaseName>` — e.g. `action.assignRole`. **Every saved graph stores this string.** Renaming it breaks existing flows, so choose it once. |
| `kind` | `trigger`, `condition`, or `action`. Palette styling, and which gateway dispatchers treat it as a starting point. It does **not** change what your entry point looks like. |
| `label` | Short name shown in the palette, on the card, and in the inspector header. |
| `description` | One line, in the product's voice — the same voice as the rest of the bot. Do not write it generic. |
| `group` | Palette section: `triggers`, `conditions`, or `actions`. |
| `icon` | One emoji. It is the glyph in the palette and on the card. |
| `configSchema` | A Zod **object** schema. This is the authority on `node.data`: it validates at save time and again before your block runs. |
| `configFields` | The form, in the order the inspector should render it. See [Config fields](#config-fields). |
| `cardSummary` | **Optional.** The one-line config summary on the canvas card, e.g. `Assign @Moderator`. See [Card summary](#card-summary). Omit it and the card falls back to "Click to configure" — fine for a block with nothing worth summarising, but check the real thing looks right before deciding that's you. |
| `note` | **Optional.** A block-level aside rendered under the form — presentation only, never read by the engine. For what is true of the block *as a whole*: a caveat spanning every field, or the reassurance that a block with no fields is meant to have none. Prefer a field's own `description` when the copy is about one field; a note that would read identically under a single control is a description wearing a disguise. Omit it rather than declaring it empty — conformance rejects a present-but-empty one. |
| `handles` | Every way a run can leave your block. See [Output handles](#output-handles). |
| `outputs` | Values your block writes for later blocks to read, via `context.setOutput`. Read by the builder to offer an author the variables in scope. Discriminated on `naming` — `fixed` carries the name, `authored` names the config field holding it. See [Run variables](#run-variables). |
| `requires` | Run context you cannot work without. See [Context requirements](#context-requirements). |
| `capabilities` | Discord permissions the bot needs for your block to work. Not yet checked against what the bot holds — but `manageRoles` is read as "this block changes a member's roles": a `rolePicker` on such a block naming `@everyone`, a managed role, or one carrying any of `PRIVILEGED_ROLE_PERMISSIONS` (`logic/roleSafety.ts`) is a readiness issue (`logic/guildReferences.ts`) — stored, but never switched on — and the block asks `changeableRole` (`logic/roleSafety.ts`) again in its own `run`. |
| `emits` | What your action causes that can start a trigger — usually `[]`, and always `[]` on a trigger. Server-only. See [What a block causes](#what-a-block-causes--emits). |
| `startedBy` | **Optional. Triggers only.** What fires you: `buttonClick`, `levelUp`, `memberJoin`, `memberLeave`, `messageSent`, `reactionAdd`, `scheduleDue`, or `ticketChanged`. `scheduleDue` is a schedule coming due: nothing on the gateway announces it, so `logic/reconcileGuildSchedules.ts` keeps a `flow_schedules` row per node with its next time and `logic/fireDueSchedules.ts` starts the due ones from the shared run tick, through an `onTick` hook `initFlows` hands the scheduler — the engine never names schedules. Its runs are about nobody, carry no channel, and are never limited. The gateway dispatchers select on this, so a new trigger for an existing source needs no dispatcher edit. Every dispatcher but the button's starts each run through one function, `startTriggeredRun` in `engine/triggeredRun.ts`, which isolates and logs a failure per run and is the only place a run start can be limited — only `messageSent` passes the flood limit. The button's (`logic/messageButtonPress.ts`, a press on a journey message's `mbtn:` button) starts its run through `startButtonRun` in `engine/flowTriggerDispatch.ts`, which asks the trigger's gate before waking parked button-click waits, and only on a node whose `startedBy` is `buttonClick` that names the pressed button in a `messageButton` field — see [Conformance](#conformance). `ticketChanged` is a committed ticket change the ticket service announces through its subscriber seam; its dispatcher lives in `logic/ticketEventDispatch.ts` rather than `engine/`, because `ticket` is a word the engine vocabulary gate rejects, and it is the one source whose runs can be started by another run — see [How deep in a chain](#how-deep-in-a-chain--contextchaindepth). Leave it off any condition or action. |
| `canSuspend` | Whether `run` may park the run. State it truthfully; conformance holds you to it. |
| `run` | The entry point. See [The entry point](#the-entry-point). |

**Your manifest is served to the browser.** `GET /api/nodes` sends every member except
`configSchema`, `run` and `emits`, so the builder can draw your node — palette entry, card, and
inspector form — from what you declare rather than from a copy of it. That is a subtraction,
not a list: a member added to `BlockManifest` is public to every authenticated dashboard user
the moment it exists. A server-only member must be named in `NON_WIRE_MEMBERS` in
`src/web/api/nodeRoutes.ts`, which will not compile until that route withholds it as well —
the list and the route cannot drift.

### Your schema is checked in the browser — write nothing for it

The builder checks a field as the author types — empty, too long, out of range, a whole number,
too few entries, a `.regex()` — and you declare none of it. When the dashboard SDK is generated,
your `configSchema` is read with zod's own JSON Schema export
(`src/features/flows/logic/blockFieldRules.ts`) and its rules go into the spec as your block's
entry in `FlowBlockFieldRules`; the SDK turns that into the zod the builder checks a node with.
Nothing about it is served at runtime. The server words its own complaints about the same rules
with the same function, so a message does not change when Save answers. The rules come from the
schema, so they cannot disagree with it: change `.max(2000)` and the browser follows.

**The one step this adds: run `pnpm sdk:generate` after adding a block or changing its schema**
(`pnpm dev` and `pnpm build` run it for you). It writes no file of yours — it regenerates the
committed spec and SDK — and the suite fails until it has been run
(`generatedSdkIsCurrent.test.ts`, and the spec drift test).

What the browser cannot be given faithfully stays on the server, and the builder hears about it
when the author leaves the field: a `.refine()` or `.superRefine()`, a format such as `.url()`, a
rule about an entry inside a list, a number your schema coerces. Write those as you would anyway —
**your wording is what the author reads**, so give `.refine()` and `.regex()` a message in the
product's voice. A `.regex()` message travels to the browser as it is, so it must be a fixed
sentence and the pattern must have no flags; the spec emit fails, naming your field, if not.

The emit can stop you in one more way: it fails, naming your block and field, if your schema uses
a JSON Schema keyword nobody has decided about yet (`multipleOf`, say). Decide it — teach the
browser the rule, or add the keyword to `SERVER_ONLY_KEYWORDS` in `blockFieldRules.ts` saying why
the re-check is enough — rather than restructuring the schema to dodge it.

## The entry point

Every block — trigger, condition, action, suspending or not — implements exactly one method:

```ts
run(config: TConfig, context: FlowRunContext): Promise<FlowStepOutcome> | FlowStepOutcome
```

`config` is already validated against your schema. Return one of three outcomes:

```ts
{ kind: 'continue' }                       // carry on out of the default handle
{ kind: 'continue', handle: 'true' }        // carry on out of a named handle you declared
{ kind: 'suspend', suspension: { … } }      // park this run
{ kind: 'fail', error: 'why, readably' }    // stop this run, with a message worth reading
```

That is the complete set, and it is **frozen**. There is deliberately no "finished
successfully" or "stopped deliberately" outcome: a flow ends when its last block runs, and an
author ends a path by wiring nothing after it. Whether a journey *succeeded* lives in the roles
someone holds and the records the flow wrote — never in the engine's own state.

Notes that save time:

- A **trigger** returns `{ kind: 'continue' }`. Triggers are pass-through; they exist so the
  graph has a starting point.
- A **condition** returns `{ kind: 'continue', handle: 'true' }` or `'false'` — declare both
  handles.
- Throwing is allowed. The executor records the error against your node and fails the run. Use
  `fail` when you know what went wrong and can say it usefully; throw when you genuinely did
  not expect it.
- `run` may be synchronous. Do not make it `async` for decoration.

### Parking a run

A suspending block sets `canSuspend: true` and returns what it wants to wait for. It never
persists anything itself — the executor owns where to resume, the visit budget, and the log:

```ts
{ kind: 'suspend', suspension: { wakeAt: new Date(Date.now() + config.durationMs) } }
{ kind: 'suspend', suspension: { waitKind: 'reactionAdd', waitConfig: { eventKind: 'reactionAdd' } } }
```

Include `wakeAt` to be woken by time, `waitKind`/`waitConfig` to be woken by a Discord event,
or both when an event-wait also has a timeout. A parked run survives a restart, so assume
nothing about what is still in memory when you wake.

The wait kinds are `memberJoin`, `reactionAdd`, `buttonClick` and `message`, always for the
run's own member. They live in three copies kept together — `flowWaitKindSchema` in
`actionWaitForEvent`, `FlowWaitKind` in `data/flowRunsSchema.ts` and `waitConfigSchema` in
`data/flowRunsRepo.ts` — and a new kind goes into all three, with a `FLOW_RUN_ENTITY_VERSION`
bump. `message` is woken differently from the others: not by a query per event, but from the
engine's in-memory index of parked message waits, which every park, claim and release keeps
current. Its `waitConfig` carries the resolved `channelId` (threads under it count; absent is
anywhere) and a required `parkedAt`, where the catch-up for replies sent while the bot was down
starts looking. The scheduler holds due message waits until that catch-up has run. A reply in a
private thread the bot has not been added to never reaches it — Discord does not send the bot
those messages — so it is never heard, live or by the catch-up. `parkedAt` is now or just after
`context.eventAt`, whichever is later: `eventAt` is Discord's timestamp for the message that
started or woke this leg, and starting after it keeps that message from counting as a reply to
the wait it caused when Discord's clock runs ahead of the bot's. Live wake-ups draw from the
message flood limit (`engine/messageActivityLimit.ts`); a refused one stays parked.

#### Counting a time limit from the last message — `quietWindow`

Beside a `wakeAt`, a suspension may carry a `quietWindow` (`{ durationMs, who, channelId? }`):
count the deadline from the last qualifying message rather than from now. **The scheduler
does the counting, not you.** When the park comes due it looks up the latest message — the
run's member's, or anyone's, optionally in one channel and the threads under it — and if
that message plus `durationMs` is still ahead, it moves `wakeAt` there instead of waking
you. You see `timeout` only once it has genuinely gone quiet, so nothing you posted on the
parking leg is re-posted and no visit is spent per message.

Do not build the window by hand. `blocks/quietTimeout.ts` is the shared fragment — spread
`quietTimeoutShape` into your schema, append `quietTimeoutFields` to your form, refine with
`checkQuietTimeout`, and park with `toQuietWindow(config, durationMs, context.guild)` — so every
block words and validates the option the same way. Set `wakeAt` to now plus the same
`durationMs`, and call `toQuietWindow` before posting anything: it throws for a channel the bot
cannot read, which would otherwise never record a message. A block that reads the activity
record for one channel without waiting — Time Since — makes the same refusal through the
fragment's exported `checkChannelUsable`, passing its own field label and consequence, rather
than a second copy of the check. It words a channel missing from the cache — deleted, perhaps
since a `{{var}}` recorded it — as one that no longer exists, apart from a cached one the bot
cannot view.

### Parking on controls you posted — set `waitMessageId`

If your block parks by **posting a message with buttons**, it must also return the id of what
it posted:

```ts
const posted = await context.channel.send({ /* … */ });
return { kind: 'suspend', suspension: { waitMessageId: posted.id } };
```

This is not optional bookkeeping, and **nothing will tell you if you forget it**. A run can park
at the same node twice — an author who wires a branch back to your block asks again — and every
other column is identical across those two parks: same `resumeNodeId`, same `suspended` status.
The message id is the only value that differs, which makes it the only thing that can tell one
park from the next.

Two consequences follow, and a block that omits it silently loses both:

- **A press from the earlier park advances the run a second time.** `claimForResume` narrows its
  conditional `UPDATE` on this id, so a claim names *a park* rather than a run. Without an id
  there is nothing to narrow on.
- **The buttons are never disabled.** `engine/waitMessageControls.ts` releases the controls when
  a park closes by any route, and it needs to be told which message to edit.

The dispatcher that handles your block's presses must pass the message the press arrived on as
`resumeFlowRun`'s `claimedWaitMessageId`. `action.prompt` and `engine/flowChoiceDispatch.ts` are
the worked example; copy their shape.

Note that the disabling is **tidiness, not the guarantee** — a client holding a stale render can
still send the press, and the park-scoped claim is what makes that harmless. Do not treat a
successful edit as a security boundary.

**Discord's button limits come from `src/shared/discordButtons.ts`**, not from flows: the four
style names and their discord.js map (`BUTTON_STYLES`, `BUTTON_STYLE_MAP`), the customId and
label lengths (`DISCORD_CUSTOM_ID_MAX_LENGTH`, `DISCORD_BUTTON_LABEL_MAX_LENGTH`) and the row
sizes. A journey's message resource posts buttons too, and provisioning may not import flows, so
the constants moved there; a block that posts buttons imports them from there rather than
declaring its own. Its customIds keep flows' prefix (`flowc:`); `mbtn:` belongs to the message resource, and
`flow:` only to the retired trigger buttons' bridge (`engine/flowTriggerDispatch.ts`).

### Waking up

**A parked run resumes at your node, not the one after it.** Your `run` is called a second
time, with `context.resume` set to why you woke:

```ts
run(config, context) {
    if (context.resume) {
        // Second call: we parked earlier and something has now happened.
        return context.resume === 'timeout'
            ? { kind: 'continue', handle: 'timeout' }   // gave up waiting
            : { kind: 'continue' };                      // the event arrived
    }

    return { kind: 'suspend', suspension: { /* … */ } };
}
```

`context.resume` is `'event'` when the gateway event you asked for arrived, and `'timeout'`
when your `wakeAt` came due first. A block that waits only on the clock only ever sees
`'timeout'`, and can treat any resume as "carry on".

Two things follow, and both matter:

- **Check `context.resume` before anything else.** Forget it and you park again immediately,
  every time, forever. Conformance drives this directly — it parks your block, then wakes it
  with each reason and fails you if you ask to park again — so the mistake is caught, but only
  once you have a conformance run over your block.
- It is set **only** on the node that parked, and only when that block declares `canSuspend`.
  The nodes your run reaches afterwards see a context with no `resume`, so they cannot mistake
  your wake-up for their own.

This is what keeps the executor free of block names: it hands you the reason and follows
whichever of *your* declared handles you answer with, exactly as it would a condition's.

## Config fields

Each entry names a `node.data` key and picks a control. The **schema validates; the field list
only renders** — never the other way round.

| `control` | Stores | Use it for |
| --- | --- | --- |
| `rolePicker` | role id | any role. Never make someone type a snowflake. |
| `channelPicker` | channel id, or one `{{var.<name>}}` | any channel. Same. Also offers channels earlier blocks record — see [A picker holding a variable](#a-picker-holding-a-variable). Set `optional: true` when the block can do without one and empty means something (`quietChannelId` in `blocks/quietTimeout.ts`: anywhere) — the pick becomes clearable, and clearing removes the key. Without it a pick cannot be undone, and a required picker writes `''` on change. |
| `categoryPicker` | category id | a category: the guild's own, plus categories the flow declares, through the same `<field>Key` sidecar install fills in. No `{{var}}` — nothing records a category. A required pick writes `''` on change, so a schema that needs one while shown takes `z.string().min(1).optional()` and refuses only an absent id in its refinement: an empty pick naming a declared, uninstalled category is the *too short* complaint save forgives (`trigger.messageSent`). |
| `ticketTypePicker` | ticket type key | one of the guild's own declared ticket types, offered by label from its ticket config. Never hardcode the seeded `support`/`verification` as options — they are only what a fresh guild starts with. A stored key the guild no longer declares shows as not available here; what it means at run time is your call (Open Ticket fails by name, Has Open Ticket still answers from the records, Ticket Event matches nothing). Also offers the ticket types the flow's journey declares, through the same `<field>Key` sidecar install fills in with the type's key. Picking one removes the field until then; save forgives the missing value while the declared type waits, as it forgives an empty snowflake. No `{{var}}` — nothing records a ticket type. Set `optional: true` when no type means something (Ticket Event: any type) — clearing removes the key, and a declared type waiting on install keeps the flow from going live, so "any type" never runs in its place. |
| `text` | string | one line. `maxLength`, `placeholder`, `rendersTokens`. Set `optional: true` when the schema is `.optional()` over a non-empty floor (`z.string().min(1).optional()`, a url) — clearing the box then removes the key instead of writing `''`, which such a schema rejects and `validateNodeData` then holds the whole flow back from going live over. A field whose description says "leave empty for none" needs it. |
| `longText` | string | a message body. `maxLength`, `placeholder`, `rendersTokens`. |
| `duration` | milliseconds | any span. Shows a number plus a unit, so nobody hand-computes `604800000`. Set `optional: true` when absence is meaningful — clearing it removes the key rather than writing a zero. `placeholder` hints the empty number box — worth having chiefly on an `optional` field (e.g. `'No limit'`), where an empty box is a real setting rather than a blank. A field with a `defaultValue` is never empty, so a hint for it could never render. |
| `segmented` | string | a few short choices, all visible at once. Needs `options`. Roughly two to four, but **label width decides**: segments split the inspector's width evenly, so one-word labels fit and full clauses do not. |
| `select` | string | a dropdown. Needs `options`. Use it once the labels are long enough to be unreadable side by side, or there are more of them than segments can hold — `action.waitForEvent` picks this for its four event kinds, which would not read as four segments in the inspector's width. |
| `colour` | `#RRGGBB` | a colour. `swatches` to suggest some. |
| `textList` | `string[]` | an ordered list of short strings an author types. `placeholder`, `maxLength` (of **one entry**), `minEntries`, `maxEntries`, `addLabel`. |
| `objectList` | `Record<string, unknown>[]` | an ordered list of **records** — `textList` one dimension up. Needs `columns`; also takes `minEntries`, `maxEntries`, `addLabel`. See below. |
| `eligibility` | an `Eligibility` object | who is allowed. Declares no options: the principals are a closed vocabulary the control reads from `engine/eligibility.ts`. |
| `variableSelect` | a bare variable name | one variable an earlier block records, picked by name. `valueKind` narrows it to one kind; leave it off to take any variable. See [Reading a variable by name](#reading-a-variable-by-name). |
| `timeOfDay` | `HH:MM`, 24-hour | a time of day on the server's clock. Drawn as hour, minute (any minute, searchable) and AM/PM, with the server's zone under it — or the ask to pick one, linking to Server Settings, while none is picked. Conformance holds the schema to the stored shape: it must take `00:00` and `23:59` and refuse `24:00` and `9:00` — `z.string().regex(/^([01]\d\|2[0-3]):[0-5]\d$/, '…')`. |
| `daysOfWeek` | `BlockDayKey[]` (`'mon'` … `'sun'`) | any of the seven days, offered Monday first as chips and written in week order. The keys are declared once, as `BLOCK_DAY_KEYS` in `blocks/manifest.ts` (mirrored in the browser under the vocabulary drift gate) — build your enum from them. Conformance holds the schema to exactly those seven keys. Its own `defaultValue: readonly string[]`, like `textList`'s. Refuse repeats with `.refine()`, not `uniqueItems`, and sort with a `.transform()` inside the field if order must not matter to you (`trigger.schedule`). |
| `message` | a message object: `{ content?, embeds }`, up to 10 embeds | a whole Discord message — plain text above, embeds with header and footer icons, fields, thumbnail and image — edited in its own window, since the inspector is too narrow to draw an embed. Build the schema from `messageConfigSchema` in `src/shared/discordMessage/`, never by hand: its picture parts take `upload:<id>`, an http(s) link or a token, and its `superRefine` holds the rules that span parts (an empty message or embed, an icon with no text beside it, Discord's 6000 characters counted outside tokens). `swatches`: the embed colours offered, the first one colouring a new embed. `defaultValue` is schema input and must parse, and an empty message does not — so declare none, as Post Embed does: the window opens on one fresh embed and writes it on the first edit, and an untouched node gets "Fill this in." on Save. Always copy — there is no `rendersTokens` to forget (see [Copy and `{{tokens}}`](#copy-and-tokens)). Complaints under it (`message.embeds.0.title`) reach the control as `issues`, paths relative to the field: the inspector counts them, and the window marks the part each names. Conformance probes the schema for the stored shape: it must take `{ embeds: [{ title: 'a' }] }` and refuse `{}` and `'x'`. The field exports to the browser as `unchecked`; the window checks each part live against the SDK's `zDiscordMessage`, built from the same `messageShape`. **Buttons under it:** declare `buttonsKey: 'buttons'` and add `buttons: messageButtonsConfigSchema.optional()` (`provisioning/logic/messageButtonSchema.ts`) to the schema — a sidecar key, as a picker's `<field>Key` is, so the message value keeps the shape every message shares. The window draws and edits them under the embeds; the key needs no field of its own (conformance probes it for a button list and refuses one a field also writes), and a save keeps it (`withDeclaredNodeData`). The rules are a journey message's (`messageButtonProblems`), labels take no tokens, and the refinement stays out of the field rules — the server's re-check carries every sentence. Post it with `renderedMessageIssue` and `messageWithButtons` (`blocks/messageWithButtons.ts`, which renders the buttons as provisioning's `mbtn:<buttonKey>` rows), then hand the sent message to `recordPostedMessage` (`logic/recordPostedMessage.ts`), which writes `flow_posted_messages` when it carried buttons. Post Embed and Open Ticket are the worked examples. |
| `messageButton` | `{ messageKey, buttonKey }`, two resource keys in the flow's own journey | one button on one of the journey's message resources: pick a message, then a button, or make either on the spot ("+ New button on this message", "+ New message in…"), which writes into the journey's Resources. **Only a trigger with `startedBy: 'buttonClick'` may declare one** — see [Conformance](#conformance). Not a resource picker: no `<field>Key` sidecar, nothing written back at install, since a press finds its message through the message's binding. Readiness judges it against the journey's declarations (`messageButtonIssues`, `logic/messageButtonReferences.ts`): a message the journey doesn't declare, a button the message no longer has, two triggers of one flow on one button. One flow per button: the picker greys a button another flow names, and going live on one is refused naming that flow (`logic/buttonClaims.ts`). Conformance probes the schema for the stored shape: it must take `{ messageKey: 'a', buttonKey: 'b' }` and refuse `{}` and `'x'`. Exports to the browser as `unchecked`, as `eligibility` does. |

### Fields that only sometimes apply — `visibleWhen`

Any field may declare `visibleWhen: { field, equals }`: show it only while the sibling
`field` holds one of `equals`. `quietChannelId` in `blocks/quietTimeout.ts` is the worked
example — the channel only shows while counting from a last message.

**Hidden means absent to every reader**, not merely undrawn. Save-time validation and the
executor both parse the node through `visibleNodeData`, so neither your schema, your
`superRefine` nor `run` ever sees a hidden field, and the executor never renders or
resolves one; the builder neither checks, places issues under, nor summarises it; and a
hidden picker's resource sidecar neither holds the flow back nor is blamed (install still
writes its id, so showing the field again finds it there). A node usually
still *holds* a value for a hidden field — the builder seeds every default on drop, and
switching the sibling clears nothing — so presence never decides. `isFieldVisible` in
`blocks/manifest.ts` (mirrored in `web/src/flows/variables.ts`) does, reading the sibling's
stored value or its default through `effectiveFieldValue`.

That shapes your schema. A field with `visibleWhen` is **optional** — absent is what it is
while hidden. Per-key limits (`.max()`, a name shape) are fine: they only ever judge it
while shown. A rule that also depends on the sibling belongs in your block's own
`superRefine`, as `checkQuietTimeout` does. Conformance holds the rest:

- the sibling exists and is a `select` or `segmented`
- it declares a `defaultValue` equal to its schema `.default()`, so every reader agrees what
  an untouched node shows
- it has no `visibleWhen` of its own — one level, no chains
- every `equals` value is one of its options
- the field carrying `visibleWhen` is optional in the schema

There is no clearing on switch, and none is needed: a value nobody reads cannot hurt.

### Reading a variable by name

A `variableSelect` field stores a **bare name** — never a `{{var.…}}` token — and may
declare the `valueKind` it can use. The builder offers the variables in scope at the node
whose kind matches, when one is declared, shows a stored name that is no longer offered as
"not available here", and says so when there is nothing to pick.

Leave `valueKind` off and the field takes **any variable**, of any kind or none: the
builder offers every variable in scope ("Pick a variable"), and save drops the kind rule
below — the path refusals still apply. `condition.compare` is the worked example: it
compares whatever the variable holds, so a Set Variable's text or number, which carry no
kind, are fair game. A block taking any variable has the most shape-checking to do at run
time, since nothing at save narrowed what it can be handed. Read a number — typed into a
field or held in a variable — with `parseAuthoredNumber` or `readNumber` from
`blocks/authoredNumber.ts`, never `Number()`: they refuse hex, exponents, blank, and
anything too big to hold exactly, so a snowflake ID stays text.

The executor passes the name through untouched, unlike a [picker holding a
variable](#a-picker-holding-a-variable), whose token it resolves and fails on when unset.
So your block reads `context.variables[name]` itself and decides what "unset" means — a
"No record" exit, say. The bag carries no types, so check the value's shape at run time
and fail by name when it is wrong. `condition.timeSince` is the worked example: unset,
`null` or `''` leaves by No record, and anything that is not a strict time fails the run
naming the variable. The schema takes the shared spelling:
`z.string().regex(VARIABLE_NAME_SHAPE, VARIABLE_NAME_MESSAGE)` from `blocks/variableName.ts`.

Save refuses a name that:

- no block in the flow records
- is recorded only by blocks that cannot run first on a path here — after this block, or on
  a branch that cannot lead to it (the builder's own over-approximation, so this rule never
  refuses a name the builder offers)
- is recorded only by blocks a run can reach **through** this one — a loop that checks
  first and counts after, so the first visit always finds it unset. This one *can* refuse
  a name the builder offered: the builder offers by ancestry, while save asks whether the
  value can be set before the block's first visit
- **any** recording block records as another kind, a kindless one included — the message
  names both blocks. This one *can* refuse a name the builder offered: the builder offers
  the nearest producer's kind, while the bag keeps whichever block wrote last, anywhere.
  Only a field that declares a kind is held to it.

### A list of records — `objectList`

Use it when one entry is several values that belong together, the way an embed
field is `{ name, value, inline }`. Each entry carries the same declared
`columns`, and a column is `text`, `longText` or `toggle` — nothing else. A
column wanting a role picker would be a form inside a list row, which is a
different control with a different layout problem rather than a wider member
here.

```ts
{
    key: 'fields',
    label: 'Fields',
    control: 'objectList',
    columns: [
        { key: 'name',   label: 'Heading', control: 'text',     maxLength: 256,  rendersTokens: true },
        { key: 'value',  label: 'Text',    control: 'longText', maxLength: 1024, rendersTokens: true },
        { key: 'inline', label: 'Side by side', control: 'toggle' },
    ],
    maxEntries: 25,
    addLabel: 'Add a field',
    defaultValue: [],
}
```

Three things worth knowing before you declare one:

- **`rendersTokens` works per column**. `copyLocationsOf` finds each copy
  column of each row alongside the scalar fields, and both the executor and
  save-time validation walk by it.
- **Conformance checks the columns against the schema** (`checkFieldColumns`).
  An entry's keys live inside an array element, so the key-for-key agreement
  between `configFields` and the schema's top level does not reach them — a
  column named `title` over a schema expecting `name` would otherwise render a
  row whose every keystroke is discarded at save.
- **The card counts rather than lists.** A record has no single string to show,
  so `cardSummary` renders `3 fields`, taking the noun from the field's own
  `label`.

`defaultValue` is the starting value when a node is dropped on the canvas. It is **schema
input**: if your schema also carries a `.default()` for that key, the two must be the same
value. Declaring the default in one place and not the other is the drift this contract exists
to prevent, so conformance treats disagreement — and a schema default the field forgot to
mirror — as a failure.

## Card summary

The canvas card shows your `label`, then one more line underneath — the current config, at a
glance, without opening the inspector: `Assign @Moderator`, `#general · "Say something…"`,
`Wait 5m`. `cardSummary` is how you say what that line is, without the browser knowing your
`type` or your fields' meaning.

It's an ordered list of **parts**, concatenated with no separator of their own:

```ts
cardSummary: [
    { key: 'roleId', prefix: 'Assign ', emptyText: 'no role picked' },
]
// -> "Assign @Moderator", or "Assign no role picked" before a role is chosen

cardSummary: [
    { key: 'channelId', emptyText: 'no channel picked' },
    { key: 'message', prefix: ' · ', quote: true, truncate: 20, hideWhenEmpty: true },
]
// -> "#general", or "#general · "Say something…"" once a message is set
```

Each part is **either** a field reference (`key`, naming a `configFields` entry) **or** a
literal (`text`) — never both, never neither. A block with nothing to reference at all still
summarises with a literal: `trigger.memberJoin` declares `[{ text: 'Any new member' }]`.

A field reference renders the field's *current* `node.data` value, resolved and formatted the
way that field's own `control` already implies:

| `control` | Renders as |
| --- | --- |
| `rolePicker` | `@name` |
| `channelPicker` | `#name` |
| `categoryPicker` | the category's bare name — no `#`, since nobody posts in one |
| `ticketTypePicker` | the type's label; a key the guild no longer declares shows as the key itself, since "no type picked" would misstate a node that names one; a declared type still waiting on install shows as "‹label› (after install)" rather than the part's empty copy |
| `duration` | `5m` (via the same formatter the inspector uses) |
| `segmented` / `select` | the matching option's `label`, not the raw stored value — `action.waitForEvent`'s `eventKind: 'buttonClick'` renders as "a button click", never `buttonClick` |
| `text` / `longText` / `colour` | the raw string value |
| `textList` | the entries joined on ` · `, blanks dropped |
| `objectList` | a count plus the field's own label, e.g. `3 fields` — a record has no one string to show |
| `eligibility` | a short phrase, or nothing at all when the gate is open |
| `variableSelect` | the bare variable name |
| `timeOfDay` | the 12-hour clock: `9:00 AM` |
| `daysOfWeek` | the days in week order, `Mon, Wed, Fri` — or `Every day` when all seven are picked |
| `message` | its headline: the first embed's title, else its body, else the plain text, else `2 embeds`. A message with nothing in it reads as unset. Post Embed: `[{ key: 'channelId', emptyText: 'no channel picked' }, { key: 'message', prefix: ' · ', quote: true, truncate: 20, hideWhenEmpty: true }]` → `#rules · "House rules"` |
| `messageButton` | the message's name and the button's label, `Rules panel · Verify`, read from the journey's declarations; a key they no longer hold shows as the key itself, since "no button picked" would misstate a node that names one. Button Click: `[{ key: 'button', emptyText: 'no button picked', stopIfEmpty: true }, …]` |

A part whose field is currently hidden by its `visibleWhen` renders **nothing** — not its
value, not its `emptyText`, and its `stopIfEmpty` does not cut the line short.

A part may carry its **own** `visibleWhen`, with the same shape and the same one-level rules
as a field's, and it then renders nothing — the same way — while that choice holds none of
`equals`. For a field that is never hidden but whose value reads well under one choice only:
`trigger.schedule`'s `repeat` prints "Every day" only while it repeats daily, so its card
reads "Every day at 9:00 AM", "Mon, Wed, Fri at 9:00 AM" or "Every 30 minutes".

`cardSummary` never repeats that resolution logic; it only says which field, what surrounds it,
and what to show in its place when it's unset:

| Option | Does |
| --- | --- |
| `prefix` / `suffix` | Literal text immediately before/after the resolved value, **only when the value renders** — so it disappears along with the value under `hideWhenEmpty`, rather than leaving a dangling `" · "`. |
| `quote` | Wraps the resolved value in `"double quotes"`. For message-shaped fields. |
| `truncate` | Maximum characters of the resolved value before an ellipsis. Card-summary truncation, not the field's own `maxLength` — a card line is shorter than an inspector field. |
| `emptyText` | Rendered **in place of the value**, still inside this part's `prefix`/`suffix`, when the field is unset — so `prefix: 'Assign '` with `emptyText: 'no role picked'` reads "Assign no role picked". `quote` and `truncate` are skipped, since empty copy is not the author's own text. Omit it and an unset field renders as nothing, which is rarely what you want — declare it. (Under `stopIfEmpty` it *is* the whole line, decorations and all discarded.) |
| `hideWhenEmpty` | Drop this part (and its `prefix`/`suffix`) entirely when the field is unset, rather than showing `emptyText`. For a trailing, genuinely optional detail (`action.sendMessage`'s message preview) where "channel, nothing else" reads better than "channel, no message yet". |
| `stopIfEmpty` | When the field is unset, render only this part's `emptyText` as the **entire** summary and discard every part after it. For when later parts stop making sense without this one — a `trigger.buttonClick` with no button picked has no gate worth showing either. Requires `emptyText` — conformance rejects `stopIfEmpty` without it, since otherwise the empty case renders nothing. |

`hideWhenEmpty` and `stopIfEmpty` are mutually exclusive on one part: the first drops just that
part, the second discards the whole line, and a part cannot mean both.

Conformance checks that every `key` here names a real `configFields` entry, that `truncate` is
a positive whole number when set, that a part is well-formed (exactly one of `key`/`text`,
`hideWhenEmpty` and `stopIfEmpty` not both set), and that a part's `visibleWhen` names a
defaulted, unconditional choice offering each `equals` value — the field rules, shared. It does **not** check that the composed text
reads well — that's a judgement call, same as `label` and `description`.

## Output handles

```ts
handles: [{ label: 'Next', tone: 'neutral' }]                       // one exit
handles: [                                                          // a condition
    { id: 'true',  label: 'Yes', tone: 'positive' },
    { id: 'false', label: 'No',  tone: 'negative' },
]
handles: [                                                          // an event wait
    { label: 'It happened', tone: 'positive' },
    { id: 'timeout', label: 'Timed out', tone: 'caution' },
]
```

A handle with no `id` is the **default** exit — the edge the graph stores with no source
handle. You get exactly one of those. `tone` is meaning, not colour (`neutral`, `positive`,
`negative`, `caution`); the builder decides what that looks like, so the engine never carries
a stylesheet.

Every block declares at least one handle, including one that usually ends a path: an author
ends the path by connecting nothing to it, not by you declaring no way out.

Mark an exit `warnIfUnconnected: true` when its silent dead end is rarely what an author
meant — a "No record" they may not know exists. While it is unconnected on a node whose
other exits are wired, the builder says so in amber on the card and in the inspector,
stating what a run taking it does: "No record isn't connected — runs that land here just
stop", or, on a block that can park, "…runs that land here fail" — a run that woke and
leaves by a named exit wired to nothing fails rather than ending quietly. It is advice,
never a save refusal. Leave it off a plain No/false: "No → end" is an ordinary flow, and a
warning on it would sit on most cards and teach authors to ignore amber.

An exit that can only fire while an optional field is filled in takes
`warnIfUnconnected: { whenFieldSet: '<field key>' }` instead: the builder warns only while
that field holds a value on the node — stored or its default, and not hidden by its
`visibleWhen`. Wait for Event's and Ask a Question's "Timed out" exits are the worked
example, keyed on `timeoutMs`: both default to no time limit, and a plain `true` would warn
on nearly every node, about an exit no run could take. The field must be optional in your
schema — a required one is set on every node, which is `true` spelled the long way.

An exit that only some choices make reachable in an ordinary run takes
`warnIfUnconnected: { whenField: '<field key>', equals: ['<value>', …] }`: the builder warns
only while that `select` or `segmented` field holds one of `equals`, read exactly as
`visibleWhen` reads its sibling — stored or its default, and never while the field itself is
hidden. Time Since's "No record" is the worked example: from "When this run started" a run
lands there only if it was parked before runs recorded their start, and from "When the member
joined" only for a leaver the bot never cached, so it warns for the message and saved-time
sources alone. The field must declare a default, and every `equals` value must be one of its
options.

Conformance accepts `true`, either condition shape with exactly its own keys, or absent —
nothing else.

**On a block that can park, warn only about an exit you take on waking, and name it.** The
builder tells the author a run landing on a warned exit of a parking block *fails*, because
the executor fails a run that woke and leaves by a named exit wired to nothing. A default exit,
or a named one you also take before parking, only stops — and the warning would say the wrong
thing. Conformance refuses a warned default exit on a `canSuspend` block; whether a named exit
is only taken on waking cannot be read off a declaration, so that half is yours to keep.

## Context requirements

`requires` says what your block needs to be present on the run:

- `subject` — the member the run is **about**. **Absent on a run whose trigger supplies
  nobody** (see the trigger paragraph below) — and absent never means "the member left".
  Declare it if you read the member, and read it through `requireSubject(context)` from
  `blocks/types.ts`, never `context.subject` directly: the executor has already refused to
  run your block without one, so the helper hands you the member, and throws a named error
  only if that check ever regressed. **On a run started by a departure (`memberLeave`) they
  have already left**, and are typed `GuildMember | PartialGuildMember` for it: an uncached
  leaver arrives with an id and a user, no roles. Acting on them fails at Discord — though a
  block may decide that "already gone" is success, as Kick Member does — and reading their
  roles or boost answers from what the bot last knew, not from the guild. A park keeps the
  subject: resume fetches the member again, and fails the run if they have left.
- `actor` — the member who caused the **current step**, which is not always the subject and is
  not always anybody. **Absent on a resumed run**: the clock woke it, so nobody acted. **Absent
  on a run from a trigger that does not say who acted** — Member Leaves, since Discord does not
  say who kicked them. A ticket change always names someone: the person, or the bot when a flow
  made it; one who has since left arrives as a partial member, as a departed subject does.
- `channel` — where the run is operating. **Absent on a run started by a member joining or
  leaving**, which happens nowhere in particular, and absent on a resumed run, because a parked
  run does not yet remember where it was.
- `interaction` — the interaction that started it. **Absent on any gateway-started run and on
  every resumed run**, because the token expires when the run parks.

Every one of the four can be absent, so declaring one lets a graph placing your block where it
could never be satisfied be flagged at save time — marked on your node, naming the requirement,
and held back from going live — instead of quietly taking the wrong branch. The executor makes
the same comparison before your `run`, and fails the step by name on a miss — except
`channel`, which it leaves to you, because a channel deleted while a run was parked resumes as
nowhere on purpose (In Channel? answers No).

**A choice can need something your block does not.** A `select` or `segmented` option may
declare its own `requires`: Time Since needs a member only for "The member's last message" and
"When the member joined", so the block declares `requires: []` and those two options declare
`['subject']`. While the field is shown and holds that option — stored, or its default — the
node needs it, exactly as if the block had declared it; the builder disables the option where
the run cannot carry it. A **built-in token** in your copy counts the same way: `{{subject.*}}`
needs `subject`, `{{actor.mention}}` needs `actor`, `{{guild.name}}` nothing
(`TOKEN_REQUIREMENTS` in `engine/copyRendering.ts`). A node's *effective requirements* are the
three together, worked out once in `engine/nodeRequirements.ts` for the validator and the
executor alike. Read the member only where your config says you need one — Time Since calls
`requireSubject` on its member sources alone.

**On a trigger, `requires` reads the other way round.** A trigger is never reached by an edge,
so nothing upstream could fail to satisfy it — what it declares is what its own event
**establishes**, and save-time validation reads it as the supply side when deciding whether a
downstream block's requirement can be met on that path. A button click establishes an actor, a
channel and an interaction; a member join establishes only an actor. **A trigger that leaves
`subject` out of `requires` starts runs about nobody** — no member, no stand-in — and nothing
needing a member may sit where it reaches. If you add a trigger, declare everything its event
genuinely provides: under-declaring rejects graphs that should be legal, and over-declaring
accepts ones that will misbehave at runtime. `trigger.schedule` is the shipped example of a
trigger about nobody: it declares `requires: []`, because the clock started the run — no
member, no actor, no channel — so a block that picks its own channel (Send Message, Post Embed)
works below it and one that acts on the member is refused.

If you find yourself reading something off `context` that you did not declare, declare it.

### When the run started — `context.startedAt`

Every run carries `context.startedAt`, a `Date` taken as the trigger fired. It is written
into the run's snapshot at the first park and never rewritten, so a run resumed after any
number of waits reports the same instant. It is **undefined on a run parked before the
snapshot recorded it** — treat that as "no record", and never substitute the row's
`createdAt`, which is when the run first parked, not when it began.

### How deep in a chain — `context.chainDepth`

Every run carries `context.chainDepth`, a whole number: `FLOW_ROOT_CHAIN_DEPTH` (1) for a
run started by a person's act or any ordinary event, and N+1 for a run started by a change
a depth-N run made. The executor settles an absent depth as the root in one place. It
is written into the snapshot at the first park like `startedAt`, so a run that waits and
then acts keeps its place; a run parked before depth was recorded reads as the root. A start
that would pass `FLOW_MAX_CHAIN_DEPTH` (5) is refused and logged, which is what stops
two flows setting each other off forever.

**A block whose action can start other runs hands its depth on.** Today that is any
block that changes a ticket: pass `{ actorId: context.guild.client.user.id, chainDepth:
context.chainDepth }` as the ticket service's `change` (Open Ticket, Close Ticket). A flow's
change is the bot's change, so `actorId` is the bot's own id — never null — and a Ticket
Event run that change starts has the bot as its actor. Depth comes from `chainDepth`, not
from who acted. The service
requires a `change` on every announcing call, so there is no default to fall back on by
forgetting. Only a ticket change carries depth across today: Kick Member → Member Leaves
goes through Discord's gateway, which cannot carry one, so that run restarts at the root.
Award XP is not a second such path — XP a flow awards never sets off Level Reached.

### What a block causes — `emits`

The depth cap stops a chain at run time; `emits` is how a flow is stopped from going live
into one at all. When a flow is switched on, or saved while on, `findFlowCycleThrough`
(`engine/flowCycles.ts`) refuses it if it would close a loop with the guild's other live
flows — one flow's action starting another, which (perhaps through more) starts the first
again. It knows what your block causes only from what you declare here:

```ts
// action.openTicket: the ticket it opens is announced as opened, of the type picked here.
emits: [{ startedBy: 'ticketChanged', carries: { event: { value: 'opened' }, ticketType: { fromField: 'ticketType' } } }]

// action.kickMember: a kick is a departure, so it starts every Member Leaves trigger.
emits: [{ startedBy: 'memberLeave' }]
```

`startedBy` is the trigger source your action fires. `carries` says what the caused event is
known to carry, keyed by the **listening trigger's** config field: `{ value }` is a literal,
`{ fromField }` whatever your node holds in one of your own fields. A trigger node listens to
your emission when it is started by that source, its raw `node.data` parses against its
schema (one that does not parse matches nothing, as its dispatcher treats it), and for every
carried key its value is unset — any — or equals yours.

**Unknown matches.** A key you leave out of `carries`, or a `fromField` unset on the node,
could be anything, so it matches whatever the listener holds. That is how to say "I can't
know": Close Ticket closes a `{{var}}` ticket, so it carries `event: closed` and no type, and
starts every Ticket Event listening for closed. Over-refusing is the accepted cost of never
missing a loop.

**When to declare.** Whenever your action can reach a trigger: changing a ticket, kicking a
member, anything a dispatcher listens for. Declare `[]` when it cannot — and say why in a
comment when a reader might wonder. Posting never reaches a trigger (the activity recorder
drops bot authors, so a bot's message starts no Message Sent run and earns no XP), and Award XP
never sets off Level Reached (`awardFlowXp` notifies no level-up subscriber — if that changes,
it becomes an emission). A trigger always declares `[]`: it is the event, not an action.

`emits` is server-only (`NON_WIRE_MEMBERS`) — nothing in the builder reads it. Conformance
holds it to the rules under [Conformance](#conformance), including the one check that looks
across blocks.

## Run variables

`context.variables` is a read-only bag of named values earlier blocks produced. It is scalar
only — `string | number | boolean | null` — and that is a deliberate limit rather than an
oversight: a variable holds an id or a reference, never evidence. If you are reaching for a
place to stash a message body or an attachment url, the bag is the wrong home for it.

A variable lasts **one run**. Other runs, other flows and journeys never see it, and nothing
is kept per member between runs.

You **write** to it through the one channel on the context:

```ts
run(config, context) {
    const channel = await openTicketChannel(context.subject);
    context.setOutput('ticketChannelId', channel.id);
    return { kind: 'continue' };
}
```

Four things follow from how that is wired, and each of them has bitten somebody:

- **Keys are flat and yours.** The executor does not qualify them by node id, so
  `setOutput('ticketChannelId', …)` is read back as `{{var.ticketChannelId}}` and nothing else.
  A namespaced store and a flat token cannot both be true. Two nodes writing one key is
  last-writer-wins today; nothing rejects it yet, so pick names that say what they hold.
  Sharing a name **on purpose** is fine when both blocks mean the same thing by it:
  `action.openTicket` and `condition.hasOpenTicket` both write `ticketChannelId` (from
  `TICKET_VARIABLES` in the tickets feature), so either branch can feed one later block —
  and `trigger.ticketEvent`'s dispatcher seeds the same two names, so Close Ticket works on
  the ticket that started the run with nothing to wire.
- **Your writes land after you return.** You cannot read back what you just wrote — you already
  have the value, and a bag that changed mid-`run` would make "what this node was handed" depend
  on where in the function you looked. A block that throws records nothing.
- **It survives a park.** The bag rides the suspension and is reseeded from the run's row on
  resume, so a value written before a wait is readable after it. That is the whole reason
  `setOutput` is a method on the context rather than a slot on the step outcome: a suspending
  block writes on its *resume* leg, when it is returning `continue`.
- **It is size-capped** (`FLOW_MAX_VARIABLES_SIZE`). Over the cap fails the run naming the keys.
  Never a silent drop: a variable that vanished would send a later block down a branch its
  author never drew.

`outputs` **is read** — by the builder, which offers an author the variables in scope at a
node and shows, on your block's own inspector, the `{{var.…}}` token later blocks use to read
what you write. A block that calls `setOutput` and declares nothing produces a variable that
is invisible to whoever has to reference it, so the two are halves of one statement.

Declare each output under the naming that matches how your block gets the name:

```ts
// The block decides the name, and it is the same every run.
outputs: [{ naming: 'fixed', key: 'ticketId', label: 'The ticket' }]

// The author decides, through a config field — `action.pickRandom`'s shape.
outputs: [{ naming: 'authored', fromField: 'outputKey', label: 'The picked option' }]
```

`fromField` names a **config field**, never the variable: the variable is whatever the author
typed into that field, resolved per node by `resolveOutputName`. Conformance rejects a
`fromField` naming no declared field, so a renamed config key fails the suite rather than
silently producing a node whose output nothing can resolve.

Optional members on either naming:

- **`valueKind`** — what the value *is*, from `BLOCK_OUTPUT_VALUE_KINDS`: `'channel'` (taken
  by the channel picker) or `'time'` (an ISO-8601 UTC string, `new Date().toISOString()`,
  taken by a `variableSelect` field). Not every kind has a picker. Declare it and the
  controls taking that kind offer your output; leave it off and the value is readable in
  copy only. A channel id you record should say so.
- **`valueKindFrom`** — instead of `valueKind`, when the kind depends on a choice the author
  makes: `{ field, kinds }` names a `select` or `segmented` field with a default, and maps
  its option values to kinds. An option left out of `kinds` means "no kind" —
  `action.setVariable` maps only `time`, so its text, numbers and booleans have none. Never both;
  conformance checks the field, its default, the option keys and the kinds. Read either
  through `resolveOutputValueKind`, never `valueKind` directly.
- **`handle`** — the exit a run leaves by when you wrote this, if only one does. A condition
  that finds something writes it on the branch where it found it; declaring
  `handle: 'true'` stops the builder offering it down No, where it is absent. Must name one of
  your own `handles`.

```ts
// condition.hasOpenTicket: recorded on Yes only, and usable as a channel.
outputs: [{ naming: 'fixed', key: 'ticketChannelId', label: 'Ticket channel', valueKind: 'channel', handle: 'true' }]
```

### A picker holding a variable

A picker listed in `PICKER_VALUE_KINDS` (`channelPicker` today) may hold exactly one
`{{var.<name>}}` instead of an id. The builder offers in-scope outputs of the picker's kind in a
"From earlier blocks" group, and the executor swaps the token for the recorded id before `run` —
so your block still receives a plain id and never knows. Nothing else may surround the token.

Save refuses the token on a **trigger's** picker (its dispatcher reads the stored value before
any run exists), refuses a name that no block in the flow declares with the picker's kind,
and refuses one that **any** block declares as another kind — a text value sharing a
channel's name would otherwise reach Discord as a channel id. The message names both blocks.
At run time a name that was never recorded, was recorded `null`, or is not a string fails the
step naming the field. So when a block finds no id to record, write `null` rather than skipping
the write: a value left by an earlier visit would otherwise survive and be used.

A new picker joins by adding its kind to `BLOCK_OUTPUT_VALUE_KINDS` and a row to
`PICKER_VALUE_KINDS`, then giving its builder control the same option group.

Still unchecked: that what you declare is what you actually write. Nothing compares `outputs`
against your `setOutput` calls — declaring one and writing another is a manifest bug found by
reading, and the builder will confidently offer a name nothing produces.

## Copy and `{{tokens}}`

A config field whose value is **copy a member reads** declares `rendersTokens: true`, and the
executor expands its tokens between validating your config and calling `run`. Your block
receives finished text and never learns that tokens exist:

```ts
{ key: 'message', label: 'Message', control: 'longText', maxLength: 2000, rendersTokens: true }
```

Available in this slice, and nothing else:

| Token | Fills in |
| --- | --- |
| `{{subject.mention}}` | A ping for the member the run is about |
| `{{subject.username}}` | Their username, unpinged |
| `{{subject.displayName}}` | What the member list calls them: server nickname, else display name, else username |
| `{{subject.id}}` | Their user id |
| `{{subject.accountAge}}` | How old their account is, `3 days`, read at render time |
| `{{subject.avatarUrl}}` | A link to their avatar — never empty, so it is the token a `message` picture takes |
| `{{actor.mention}}` | Whoever caused this step. **Refused at save after a block that parks, in a parking block's own copy** (rendered again on waking), **and below a trigger that does not say who acted** (Member Leaves) |
| `{{guild.name}}` | The server's name |
| `{{var.<name>}}` | A value an earlier block recorded |

The `text` and `longText` arms carry the flag, as do an `objectList`'s `text` and `longText`
**columns**. A `message` field carries none: it is always copy — every text part, and every
picture that is not an upload. Elsewhere the flag is **off by default** — which is the right default, because most string
fields are not copy: a message id, an emoji, a button label. Turning it on for one of those would
turn a stray brace into a failed run. Forgetting it on a field that *is* copy is the more visible
mistake: the braces are posted verbatim.

Every copy string a node holds — a field, a column of a list row, a part of a message — is found
by one walk, `copyLocationsOf` (`engine/copyRendering.ts`), which the executor renders by and
save-time validation (`checkCopyTokens`, the token requirements) checks by. Each location is
`{ path, where, maxLength, checkRendered? }`; the executor writes a rendered string back at its
path, copying only the containers on the way. A message's locations come from
`messageCopyLocations` in `src/shared/discordMessage/`, and a token's requirement is the same
there as anywhere: `{{subject.mention}}` in embed 3's footer needs a member. A failure names the
part an author sees — `"Fields" Text on entry 2`, `"Message" embed 2 field 1 text`,
`"Message" embed 1 footer icon` — because "the Fields field is wrong" is unactionable on a list of
twenty.

Four things fail rather than degrade, all of them naming the node:

- a token outside the table above, **rejected when the flow is saved** — except `{{var.<name>}}`,
  which is still accepted on sight. The builder now warns about a name nothing upstream writes,
  but a *save-time* refusal has to decide what to do with a variable written on only one branch
  of a split, which is a real graph; see `checkCopyTokens` in `engine/graphValidation.ts`
- a `{{var.…}}` nothing recorded by the time your block runs
- copy that exceeds the field's `maxLength` **once rendered** — which is not the length the
  author typed, since `{{subject.mention}}` is 19 characters that expand to about 22
- a `message`'s picture whose tokens did not come out as an http(s) link — `upload:<id>`
  included, so a value read from member text is never attached as an upload. The location
  carries the rule (`checkRendered`), and the executor asks it right after rendering, the one
  place that still knows the picture was copy

There is deliberately no expression language, no conditionals, and no formatting. A flow builder
is not a template engine.

### Sending rendered copy — pin the mention allowlist

Rendered copy carries **member-controlled text**: `{{subject.username}}` is whatever the member
called themselves. A member named `@everyone` turns any flow that greets them by name into a
guild-wide ping sent with the bot's permissions.

So a block that sends copy passes an explicit allowlist, never a bare string:

```ts
await channel.send({ content: rendered, allowedMentions: { parse: ['users'] } });
```

Use `{ parse: ['users'] }` where `{{subject.mention}}` must still ping the one member it names —
Post Embed's plain text above its embeds included — and `{ parse: [] }` where nothing should
mention anyone. Every shipped
send path does this — `action.sendMessage`, `action.sendDM`, and `action.postEmbed` and `action.openTicket`'s
message through `messageWithButtons` — and the test
helper `__tests__/support/sentCopy.ts` throws on a bare-string payload so a fourth path cannot
quietly skip it and stay green.

Nothing checks this at compile time. It is the one rule in the copy contract that depends on the
author reading it.

## Where a new graph rule goes

Two functions in `engine/graphValidation.ts`, and picking the wrong one has already caused one
outage:

- **`validateFlowGraph`** — corruption only: dangling edge endpoints, duplicate node ids. It
  runs on **read**, and the repo *throws* from it, so a rule added here makes every flow in a
  guild unloadable the moment one stored row stops satisfying it — not just the bad one.
- **`validateAuthoredGraph`** — everything that makes a flow *wrong* rather than unreadable:
  fan-out, handles a block does not declare, unsatisfiable context requirements. It decides
  whether a flow may go **live**, not whether it may be stored: a graph failing it saves as an
  incomplete flow that cannot be enabled, reached through `flowReadinessIssues` in
  `logic/flowReadiness.ts`. Never on read, so no stored graph is retroactively stranded.

New rule? It is almost always the second one.

A rule that needs the flow's **server** rather than its graph sits beside the second:
`guildReferenceIssues` (`logic/guildReferences.ts`) refuses a picked channel, category or role
that is not one of the server's own, read from its cache, and a role a `manageRoles` block may not
change. Its issues are ordinary readiness issues, asked through `flowReadinessIssuesInGuild` by
every caller holding the guild — the routes and the flows list — so the builder's marks and
the switch-on refusal agree. The seed script, which has no Discord client, asks only the graph.
A block that posts resolves its channel the same way at run time, from `context.guild`'s cache
(`blocks/channelInGuild.ts`) — never `context.client.channels`, which reaches every server the
bot is in.

`uploadReferenceIssues` (`logic/uploadReferences.ts`) sits beside `guildReferenceIssues`, and
reports two things: an uploaded picture a
`message` field shows that this server does not hold — deleted, or copied from another server's
flow — at the part (`message.embeds.0.image`), and a message showing more than 10 uploads or more
than `MESSAGE_LIMITS.uploadBytes` of them at `message`. The rules are `messageUploadProblems`
(`src/shared/discordMessage/`), which Post Embed's `run` asks again. Readiness stays
synchronous, because it is asked inside `flowsRepo.mutate`'s transaction, so the uploads arrive
as an `UploadIndex` — `flowReadinessIssuesInGuild`'s fourth argument — that the caller awaits
first with `loadUploadIndex(guildId, graphs)`, **outside any transaction**: SQLite has one
connection, and a query inside the transaction waits on it forever. The load makes no query when
no graph names an upload. An index answers only for the graphs it was loaded for, and judging
another throws; a caller judging a row that changed since its read asks `uploadIndexCovers`
first. A new rule that needs the database takes the same shape: load before the transaction,
judge synchronously.

One rule is neither, because it is not about one graph: **a loop between flows** —
`findFlowCycleThrough` in `engine/flowCycles.ts`. It is a conflict between a flow and the
guild's other live flows, so it is asked only as a flow goes live (`decidePut` in
`src/web/api/flowRoutes.ts`, and the seed script), and it stays out of `flowReadinessIssues`:
its message names other flows, and a refusal carrying issues would lock the builder's switch
and mark cards by node ids that are not on this canvas. A rule like it — about how flows
relate rather than how one is built — goes beside it, not into either function above.

## Conformance

```bash
npx vitest run src/features/flows/__tests__/blockConformance.test.ts
```

Conformance is what makes this contract cheap to change: extend the manifest and every block
that has not caught up fails by name. It checks, from your declaration alone, that

- every required member is present and the right shape
- every vocabulary word you used is in its vocabulary
- your declared fields and your schema describe the same config, **in both directions** — a
  declared field the schema ignores, and a schema key no field lets an author set
- every declared default is one the schema accepts, and agrees with any schema default
- your handles are well formed: at least one, no duplicate ids, at most one default, all
  labelled, and any `warnIfUnconnected` exactly `true`, `{ whenFieldSet }` naming one of your
  own optional fields, or `{ whenField, equals }` naming a defaulted choice offering each value
  — and never on the default exit of a block that can park
- your outputs are well formed: labelled, named one of the two ways, any `handle` one of your
  own, any `valueKind` a real value kind, any `valueKindFrom` naming a defaulted choice whose
  options map to real kinds, and never both
- every `visibleWhen` names a defaulted, unconditional choice offering each `equals` value,
  over a field the schema leaves optional — see [Fields that only sometimes
  apply](#fields-that-only-sometimes-apply--visiblewhen)
- every `variableSelect` takes the shared name spelling, and names a real kind if it names
  one at all
- your `cardSummary`, if you declared one, only references fields that exist and is otherwise
  well formed — see [Card summary](#card-summary)
- a `message` field's `buttonsKey` names a schema key, not one a field writes, whose schema takes a
  list of buttons and refuses anything else (`checkButtonsKey`); only a `message` field declares one
- a `messageButton` field sits only on a trigger with `startedBy: 'buttonClick'`
  (`checkMessageButtonSource`): that is the only block a press runs, and anywhere else the field
  would claim the button and be listed as its listener while nothing ever answered it
- your `emits` is `[]` on a trigger; each emission names a source in the vocabulary; each
  carried value is exactly `{ value }` or `{ fromField }`; and a `fromField` names one of your
  own fields that cannot hold a `{{var}}` — not `rendersTokens`, not a `message`, not a picker in
  `PICKER_VALUE_KINDS` — since a written token would compare unequal to everything and hide a
  loop

and, when driven with a config and a context, that `run` returns a declared outcome and
continues only by a handle you declared.

**One check is not from your declaration alone:** `checkEmissionTargets`, run over the whole
registry. Whether what you carry means anything depends on the triggers listening for it, so
it checks that every carried key is a field some trigger on that source declares (a typo would
match every listener) and that every `{ value }` literal is one of that field's options when it
has any (a typo would match none, and the loop check would miss a real loop).

One thing it does **not** check: that a handle you declared is actually reachable. Proving that
means driving a block down every path, which needs a config and a context per path that only
you know. Cover your own branches in your own test.

## When the contract cannot express what you need

**Extend the vocabulary. Do not work around it.**

The lists above — kinds, palette groups, control types, handle tones, context requirements,
capabilities — are closed unions, and *that is the extension point*. A block needing a control
nobody has built yet adds it to the vocabulary, implements it once in the builder, and every
future block gets it. A block that instead special-cases around the gap has bought itself a
day and cost everyone the property this contract exists for: the twelfth block is as cheap as
the second.

So, in order:

1. If you need a new control, requirement, capability, or tone: add the member, implement it
   once, document it here.
2. If you need something the manifest has no member for at all: that is a contract change.
   Change the manifest, the conformance suite, and this document together, and migrate every
   existing block in the same change. Two ways to declare one fact must never coexist.
3. If you think you need a fourth step outcome: you almost certainly do not — read
   [The entry point](#the-entry-point) again. If you still do, the block contract is wrong
   somewhere else. Treat it as a report about the contract, not as an enum to append to.

### Extending the vocabulary or the manifest means stating it in the spec too

The one-directory rule covers **adding a block**. Changing the *contract* — a new vocabulary
member under step 1, or a new manifest member under step 2 — is the case where you do edit a
shared file: `src/web/api/nodeBody.ts`, which states the served descriptor (`NodeDescriptor`,
every `BlockConfigField` arm, exits, outputs, the vocabularies) as the zod the OpenAPI spec is
built from. The browser's types are generated from that spec, so there is no browser file to
edit — run `pnpm sdk:generate` (which `pnpm dev` runs) and the builder sees the change.

You do not have to remember this rule. Each schema there is held to its manifest type both ways,
member by member — every control arm, both output arms, both exit-warning forms, the nested
objects — so a member or arm added to `manifest.ts` and not stated there fails `pnpm test`
(`src/web/api/__tests__/nodeBody.test-d.ts`, naming the check that drifted) and root `tsc`.
Then pick one of two fixes:

- the member is for the builder → state it in `nodeBody.ts`, then regenerate the SDK
- the member is server-only → add it to `NON_WIRE_MEMBERS` in `src/web/api/nodeRoutes.ts`, which
  will not compile until the route withholds it too

A new control also fails web `tsc -b` in `controls/renderControl.tsx` once the SDK is
regenerated, until the builder implements it.

Everything a manifest declares except `configSchema`, `run` and `emits` is served to the browser by
`GET /api/nodes`, so a new member is published to every authenticated dashboard user by
default. That is the reason the second option has to be a deliberate act.

#### The mirrors that remain

Anything the builder has to *know* rather than be *sent* is still copied by hand — the web
workspace cannot import the bot's code, because one `import type` from `src/` would pull the
whole bot tree into `tsc -b` and break `pnpm build:web` — and each copy carries its own gate:

| Browser copy | Authority in `src/` | Gate |
| --- | --- | --- |
| `web/src/flows/builtinTokens.ts` | `RENDERABLE_TOKENS` and `TOKEN_REQUIREMENTS` in `engine/copyRendering.ts` | `src/web/api/__tests__/builtinTokenDrift.test.ts` |
| `REQUIREMENT_ABSENT_WHEN` in `web/src/flows/variables.ts` | `REQUIREMENT_ABSENT_WHEN` in `engine/graphValidation.ts` | `src/web/api/__tests__/builtinTokenDrift.test.ts` |
| `web/src/flows/ticketChannelName.ts` | `buildTicketChannelNameForType` in `tickets/logic/ticketTypes.ts` | `src/features/tickets/logic/__tests__/ticketChannelNamePreviewDrift.test.ts` |
| `web/src/flows/messageEditor/messageCharacters.ts` — the message window's 6000-character meter | `MESSAGE_LIMITS.totalCharacters` and `messageCharacterCount(message, 'outsideTokens')` in `src/shared/discordMessage/` | `src/shared/discordMessage/__tests__/messageMeterDrift.test.ts` |
| `partPath` / `partLabel` in `web/src/flows/messageEditor/messageDraft.ts` — where the window marks a complaint, and what it calls each part | `messageCopyLocations` / `messagePictures` in `src/shared/discordMessage/messageParts.ts` | `src/shared/discordMessage/__tests__/messageMeterDrift.test.ts` |

A message's per-part limits are not on this list: they travel in the spec as `DiscordMessage`
(`src/web/api/messageBody.ts`), and the window reads its counters and sentences from the SDK's
`zDiscordMessage` (`messageEditor/partRules.ts`). Only the total spans parts, so only the total is
copied. Its gate counts token-bearing messages through both, not just the number.

**A gate lives beside its authority, not beside the copy.** The token gates answer to
something under `src/web/api/`; the channel-name one to the ticketing feature, so it sits there;
the message ones to `src/shared/discordMessage/`.
A gate placed
beside the browser copy would run in the workspace that cannot import the authority.

Two things a gate of this kind must do, both learned the hard way:

- **Compare behaviour, not just data.** The ticket mirror duplicates a sanitizer as well as a
  template. Comparing the template strings passed while the mirror had dropped its `.toLowerCase()`.
- **Drive it with input that can tell the difference.** That same gate ran only on `someone` —
  already lowercase and pure ASCII — so no assertion could fail. It now runs both implementations
  over mixed-case and non-ASCII subjects. A gate is only as strong as its worst input.

Every block that ships is written against this contract — the earlier shape, with three
separate per-kind entry points, is gone. There is one way to declare a block.
