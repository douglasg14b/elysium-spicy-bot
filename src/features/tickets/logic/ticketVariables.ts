/**
 * The names a flow records a ticket under, for later blocks to read as
 * `{{var.ticketId}}` and `{{var.ticketChannelId}}`.
 *
 * Shared by every flow block that hands a ticket on — `action.openTicket` for the one
 * it opens, `condition.hasOpenTicket` for the one it finds — on purpose: "has one?
 * post in it; no? open one, then post in it" then converges on a single Send Message
 * reading the same name whichever branch the run took.
 *
 * Here rather than in either block's folder, because a block is one self-contained
 * directory and neither should depend on the other. Tickets still import nothing
 * from flows; these are only the names.
 */
export const TICKET_VARIABLES = {
    ticketId: 'ticketId',
    ticketChannelId: 'ticketChannelId',
} as const;
