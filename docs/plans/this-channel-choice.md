# Post where it happened, close the ticket it happened in

> **Status**: Planned 2026-10-27; Douglas: "reference the channel that the thing happened in … I like that." Built 2026-10-28, uncommitted — see [As built](#as-built). Not run live.
> **Owner**: Douglas
> **Follows**: [block-message-buttons-step-3.md](block-message-buttons-step-3.md), committed in `56937c4`.

## The gap (found by Douglas building a verification ticket)

A Button Click on an Open Ticket post runs in the ticket channel, about the ticket's member, with the ticket's id in `ticketId`. Yet from that run an author can't:

1. **Close the ticket.** Close Ticket takes a ticket id as text; the builder never offers `{{var.ticketId}}` (Button Click declares no outputs — step 2, Decision 3), so the author would have to know to type it.
2. **Post into the ticket.** Post Embed and Send Message take a channel from the picker only. "Where the button was pressed" isn't offered, and a channel picker refuses `{{var.ticketChannelId}}` (no block in the flow records it).

## What this does

Two generic choices, each needing the run's `channel` (`FlowContextRequirement`), so they work after any trigger that happens in a channel (Button Click, Message Sent, Reaction Added) and are greyed and refused at save where there is none (Schedule, Member Joins, after a park that drops the channel — whatever `effectiveRequirements` / the builder's `requirementAvailableAt` already say about `channel`).

1. **Post Embed and Send Message: where to post.**
   - "The channel this happened in" (needs `channel`) or "A channel I pick" (the existing picker).
   - Default: **pick**, so every saved node means what it meant (absent = default). The picker is shown only for "pick" (`visibleWhen`).
   - One shared definition for both blocks, in the shape of `blocks/memberChoice.ts`: the field, its schema piece, the card part (shown only when not the default — the card says "this channel" instead of a channel name), and a reader returning the channel to send to.
   - **No sentinel in the snowflake field.** `channelId` stays a snowflake or `{{var.x}}`; the choice is its own key (memory note: a display string must not carry a binding).
   - The run's channel must be one the bot can send to in this guild — the same check `requireChannelInGuild` makes today. A run whose channel is a DM or isn't sendable fails by name.
2. **Close Ticket: which ticket.**
   - "The ticket in this channel" (needs `channel`) or "A ticket ID" (the existing text field, `{{var.ticketId}}` placeholder).
   - Default: **ticket ID**, so saved nodes keep working. The text field is shown only for that choice.
   - "The ticket in this channel" finds the ticket by the run's channel (`getTicketByChannel`, the tickets service — flows may import tickets) and checks it is this guild's. No ticket there fails by name, in the bot's voice: this isn't a ticket channel.
   - Everything after finding the ticket is unchanged.

## Decisions

1. **Defaults keep old meanings**; no migration. New nodes start on the default too — an author picks "this channel" once.
2. **Only these three blocks.** Open Ticket, In Channel, Wait for Event and Ask a Question keep what they have. Other channel pickers can take the shared choice later if a case turns up.
3. **The schema states the conditional rule** (picker required only for "pick", ticket id only for "ticket ID") the way the repo already does for a field shown by `visibleWhen` — check how a hidden field's requiredness is handled (`isFieldVisible`, conformance, `withDeclaredNodeData`, field-rule export) and follow it rather than inventing a refine.
4. Field keys and option values use words the engine vocabulary gate allows; no block type named outside its directory.

## Tests

- Each block: "this channel" sends to / closes in the run's channel; the default behaves as before; a stored node with no choice key behaves as before.
- Requirements: "this channel" needs `channel`; refused at save below a Schedule; greyed in the builder.
- Close Ticket in a channel that is no ticket's fails by name; another guild's ticket is not found.
- Card shows the choice only when not the default.
- Sabotage: the reader ignoring the choice; Close Ticket skipping the guild check.

## As built

Built 2026-10-28, uncommitted, never run live.

- **Shared definition**: `src/features/flows/blocks/channelChoice.ts`, in the shape of `memberChoice.ts` — `channelChoiceShape` (spread into the schema: `where: z.enum(['channel', 'here']).default('channel')` and `channelId: z.string().min(1).optional()`), `checkChannelChoice` (the block's `superRefine`: "Which channel? Pick one — or post in the channel this happened in." only when picking and the id is absent, the `trigger.messageSent` precedent, so an empty pick stays a *too short* complaint that pending-resource forgiveness still covers), `CHANNEL_CHOICE_FIELD` ("Where": "A channel I pick" / "The channel this happened in", the latter `requires: ['channel']`), `CHANNEL_PICKER_FIELD` (the picker, `visibleWhen` the default), `CHANNEL_CHOICE_CARD_PART`, and `channelFor` (both arms through `requireChannelInGuild`).
- **Keys and values**: Post Embed and Send Message `where: 'channel' | 'here'` (Message Sent's own words for its `where`); Close Ticket `source: 'id' | 'here'`, kept in its own directory (`ticket` is a word the engine vocabulary gate rejects, and only that block finds a ticket). `pick` is not an allowed word, so it appears only in labels.
- **Close Ticket**: `ticketToClose` resolves the ticket per choice and checks the row is this guild's on both arms. "Here" looks up `getTicketByChannel`, **counting a thread toward the channel it sits under** (as In Channel? and Message Sent do — added after review). No ticket: "Close Ticket went looking for a ticket in this channel (id) and came up empty — this isn't a ticket channel."
- **Channel and parks**: `channel` survives a park (the snapshot keeps `channelId`, `rebuildResumeContext` fetches it, `REQUIREMENT_ABSENT_WHEN.channel.afterParking` is false), so a wait above does not refuse or grey "here". The executor leaves `channel` to blocks (`RUN_CHECKS`), so **unlike `memberFor`, a missing run channel is not treated as a regression**: both readers throw by name ("…isn't in a channel the bot can reach — it's gone, walled off, or was never there"). `block-authoring.md`'s `channel` bullet said a resumed run has no channel; corrected.
- **Builder**: greying is free — `ChoiceControls` disables an option whose `requires` the node cannot rely on. No web source changed.
- **Card**: the card shows the option's label, so it reads "The channel this happened in · "House rules"" and "The ticket in this channel" rather than a bare "this channel" — a literal card part cannot carry `visibleWhen`, and adding that would be new contract surface for one wording.
- **Field rules export**: `channelId` and `ticketId` are no longer required keys, so the builder's live sentence for an emptied picker or id box is "Can't be empty." (was "Fill this in."); a node never filled in gets the refine's sentence on Save. Accepted, as on Message Sent.
- **Open, for Douglas**: Ticket Event runs carry the ticket's channel when it resolves (`ticketEventDispatch.ts`), but `trigger.ticketEvent` does not declare `channel`, so "here" is refused below it. Declaring it would open "Ticket claimed → post here" and "close the ticket in this channel" there (and change In Channel? below it); left as the code decides. Also: an absent `channelId` with a declared-resource sidecar (no product path writes it) is now refused by the refine rather than forgiven — the same exposure Message Sent already has.
- **Tests**: `blocks/__tests__/channelChoice.test.ts` (run, requirements, save refusal below Schedule and acceptance below a button with a wait, empty pick forgiveness, the card through `/api/nodes` and the browser's interpreter, shared declarations), `actionCloseTicket.test.ts` (here, thread, no ticket, other guild both arms, lost channel, stored node), `postEmbedRun.test.ts` (a "here" post with buttons recorded against the run's channel), `web/src/flows/__tests__/channelAvailability.test.tsx` (greyed with the reason, not greyed after a park).
