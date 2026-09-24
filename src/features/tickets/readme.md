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
| Orchestration | `logic/applyTicketTransition.ts` | **The one path a lifecycle change takes.** Commit the row → sync the channel → re-render the state message → announce, in that order, for all six callers: the four buttons, `action.closeTicket`, and the dashboard. Takes a `Guild`, never an interaction. |
| Handlers | `components/*` | Thin. `resolveTicketAction` does the shared gate; the service enforces the state rules; `applyTicketTransition` does the Discord sequence. |

Ticketing is a **base capability**. Flows consume it through adapter blocks (`action.openTicket`, `action.closeTicket`, `condition.hasOpenTicket`) in the flows→tickets direction only.

## Two rules that are easy to break

**Ticket types are guild data, and absence is a refusal.** `getTicketTypeDefinition(config, type)` returns `undefined` when a guild does not declare a type, and every surface resolves it *once* at its entry point — `resolveTicketAction` for the buttons, the two open paths for creation — then passes a non-optional `TicketTypeDefinition` down. Do not paper over absence with `definition!` or a default: a guessed permission model re-permissions a real channel. Deleting a type is refused by name while any ticket holds it (`logic/ticketTypeInUse.ts`), including *deleted* tickets, whose rows still have to render their own label.

**`logic/setTicketTypes.ts` and `logic/ticketTypeInUse.ts` are the shared validate-and-persist authority**, and they now have a production caller: `src/web/api/ticketRoutes.ts`. One set of template-token rules and one in-use refusal, so the dashboard and any future Discord type editor cannot drift apart in what they accept or how they say no.

**Every `config` edit goes through `ticketingRepo.mutateConfig`.** `config` is a single JSON blob holding every ticket setting, so any edit is a whole-blob rewrite and a `get`-then-`update` pair lets two concurrent editors — two browser tabs, or the dashboard and the Discord modal — silently discard each other's save across an HTTP round trip. `mutateConfig` does the read, the merge and the write in one transaction. **Not `entityVersion`:** that column is a schema-migration marker here, hardcoded to `1` by every writer and compared by nothing, so overloading it as an optimistic-concurrency counter would give one name two meanings.

**One residual race, and it differs by dialect — do not read one arm as the other.** `deleteTicketType` counts the tickets holding a type inside the mutation, so no concurrent *config* writer can interleave. But `ticketTypeUsage` queries through the module-level `database` singleton rather than the transaction's connection, and what that costs depends on the backend:

- **postgres**: the count does not see the transaction's snapshot, so a ticket *opened* in that one-statement window is not serialized against it. The type can be deleted out from under a live ticket. `getTicketTypeDefinition` then refuses by name rather than guessing at a permission model, which is why this is a gap and not a corruption.
- **sqlite**: cannot happen. The transaction's `SELECT` holds a SHARED lock, so the concurrent insert raises `SQLITE_BUSY` and fails loudly instead of slipping through. The *different* exposure here is that a member opening a ticket can fail while an admin is editing config.

Closing the postgres half means threading a transaction handle through `ticketTypeUsage` and `ticketsRepo`, which the Discord refusal path shares. **Only the sqlite arm runs in CI**, so the postgres behaviour above is reasoned, not exercised.

**Every write records who the people were.** `subjectUsername`/`subjectNickname`, `openerUsername`/`openerNickname` and `claimerUsername`/`claimerNickname` are snapshots, so a non-Discord surface can render a row without fetching members. Claiming re-resolves the claimer *inside* the guarded `UPDATE`; unclaiming clears the claimer's names with the claim; close and reopen re-resolve nothing, because they change no person. `stateMessageId` records the in-channel message so a caller with no interaction can still re-render the embed.
