## Logic & Data

Ticketing logic & data follows 2 paths:

1. Per-ticket data
    - Each ticket is a **row in the `tickets` table**. The embed in the channel is a *rendering* of that row, not the record itself.
    - A ticket therefore *has* a channel rather than being one: `channelId` is nullable, and losing the channel does not destroy the ticket.
    - **This is a reversal.** Ticket state used to live as base64 JSON in a pinned message, which meant every question cost several Discord API calls and a deleted message silently destroyed the ticket.
2. Server ticketing config/data
    - Server ticketing config/setup state is stored in the database as a ticketing config entity
    - All interactions with this use internal logic and our database
    - All interactions with this should update an embed

## Layers

Read them in this order; the boundary between the first two is the point.

| Layer | Where | Rule |
|---|---|---|
| Service | `ticketService.ts` | Decides. No discord.js, no flows — it must never import from `src/features/flows/`. |
| Channel ops | `logic/ticketChannelOps.ts` | Applies Discord effects for a decision already made. Takes a `Guild`, never an interaction. |
| Types | `data/ticketingSchema.ts` + `logic/ticketTypes.ts` | A ticket type is **a record in `ticketing_config.config.ticketTypes`**, declared by the operator — not a constant. `data/` owns the shape and `data/defaultTicketTypes.ts` is the seed; `logic/ticketTypes.ts` holds the lookup, the channel-name renderer and the discord.js bitfield translation. |
| Presentation | `logic/ticketPresentation.ts` | Renders a row as an embed plus buttons. |
| Handlers | `components/*` | Thin. `resolveTicketAction` does the shared gate; the service enforces the state rules. |

Ticketing is a **base capability**. Flows consume it through adapter blocks (`action.openTicket`, `action.closeTicket`, `condition.hasOpenTicket`) in the flows→tickets direction only.

## Two rules that are easy to break

**Ticket types are guild data, and absence is a refusal.** `getTicketTypeDefinition(config, type)` returns `undefined` when a guild does not declare a type, and every surface resolves it *once* at its entry point — `resolveTicketAction` for the buttons, the two open paths for creation — then passes a non-optional `TicketTypeDefinition` down. Do not paper over absence with `definition!` or a default: a guessed permission model re-permissions a real channel. Deleting a type is refused by name while any ticket holds it (`logic/ticketTypeInUse.ts`), including *deleted* tickets, whose rows still have to render their own label.

**`logic/setTicketTypes.ts` and `logic/ticketTypeInUse.ts` have no production caller yet.** They are the shared validate-and-persist authority — `upsertTicketType`, `deleteTicketType`, the template-token rules and the in-use refusal — written so the dashboard config route and a future Discord type editor go through one set of rules and one refusal instead of two. Covered by unit tests, reachable from nothing else, and deliberately so: an operator cannot yet add a type, and that surface is the next slice. Two known gaps to close when the route lands: both functions read-modify-write the whole `config` blob with no `entityVersion` guard (last write wins between two concurrent editors), and the delete's in-use check and its write are separate statements.

**Every write records who the people were.** `subjectUsername`/`subjectNickname`, `openerUsername`/`openerNickname` and `claimerUsername`/`claimerNickname` are snapshots, so a non-Discord surface can render a row without fetching members. Claiming re-resolves the claimer *inside* the guarded `UPDATE`; unclaiming clears the claimer's names with the claim; close and reopen re-resolve nothing, because they change no person. `stateMessageId` records the in-channel message so a caller with no interaction can still re-render the embed.
