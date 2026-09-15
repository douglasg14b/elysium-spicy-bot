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
| Types | `logic/ticketTypes.ts` | Permission model and channel-name template, **per ticket type**, declared as data. |
| Presentation | `logic/ticketPresentation.ts` | Renders a row as an embed plus buttons. |
| Handlers | `components/*` | Thin. `resolveTicketAction` does the shared gate; the service enforces the state rules. |

Ticketing is a **base capability**. Flows consume it through adapter blocks (`action.openTicket`, `action.closeTicket`, `condition.hasOpenTicket`) in the flows→tickets direction only.

`logic/ticketState.ts` is the old embed-as-record implementation. It is superseded and being removed.
