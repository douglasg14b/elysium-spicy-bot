import { useRef } from 'react';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
    ApiError,
    claimTicket,
    closeTicket,
    getTicketQueryKey,
    listTicketsQueryKey,
    reopenTicket,
    unclaimTicket,
    type TicketActionResult,
    type TicketSummary,
} from '@brattybot/web-sdk';
import { TICKET_ACTION_PRESENTATION, type TicketAction } from './ticketActions';
import { formatTicketNumber } from './ticketPresentation';

/**
 * The SDK call behind each action, one route apiece. The route declares the ticket id in
 * its path as a string.
 *
 * A `Record`, so a fifth action is a compile error here rather than a button the dashboard
 * renders and cannot send.
 */
const TICKET_ACTION_CALLS: Readonly<
    Record<TicketAction, (path: { readonly guildId: string; readonly ticketId: string }) => Promise<TicketActionResult>>
> = {
    claim: async (path) => (await claimTicket({ path })).data,
    unclaim: async (path) => (await unclaimTicket({ path })).data,
    close: async (path) => (await closeTicket({ path })).data,
    reopen: async (path) => (await reopenTicket({ path })).data,
};

/** One action on one ticket, as a button asks for it. */
interface TicketActionRequest {
    readonly guildId: string;
    readonly ticket: Pick<TicketSummary, 'id' | 'ticketNumber'>;
    readonly action: TicketAction;
}

export interface TicketActionControls {
    /**
     * The action in flight, identified by ticket *and* action, or null. A bare ticket id
     * would spin both of a row's buttons at once.
     */
    readonly acting: { readonly ticketId: number; readonly action: TicketAction } | null;
    /** Take `action` on `ticket`. Ignored while another action is in flight. */
    readonly act: (ticket: TicketActionRequest['ticket'], action: TicketAction) => void;
}

/**
 * The lifecycle actions, as the ticket list and the ticket page both offer them.
 *
 * Says what happened in a notification, then re-reads the guild's ticket list and the
 * acted-on ticket and waits for it — inside the mutation, so `acting` spans the re-read and
 * a button does not come back to life showing the ticket as it was. Both pages re-read
 * rather than patching from the response: the list's counts are guild-wide and a changed
 * ticket may no longer match the filter. Cached answers no page is showing are dropped
 * rather than kept, so going back to the other page reads afresh instead of offering
 * buttons for a state the ticket has left.
 *
 * **`syncWarning` stays on screen until dismissed.** The row moved and the Discord channel
 * did not, which is something an operator has to go and fix by hand — on a close, the
 * subject may still be able to read it. Not an error, because the ticket really moved.
 *
 * One action at a time, across the page: every action ends in a re-read, so two in flight
 * would race each other's re-read as well as each other — and a double-click's second
 * transition would get a 409 for an action that succeeded.
 */
export function useTicketAction(guildId: string | undefined): TicketActionControls {
    const queryClient = useQueryClient();
    /*
     * The re-entry guard, set before the click's handler returns. `mutation.isPending`
     * reaches the page a macrotask later, through the query client's notify scheduler, so it
     * alone would let a second click in that gap start a second action.
     */
    const inFlight = useRef(false);

    const mutation = useMutation({
        mutationFn: ({ guildId: forGuild, ticket, action }: TicketActionRequest) =>
            TICKET_ACTION_CALLS[action]({ guildId: forGuild, ticketId: String(ticket.id) }),
        onSuccess: async (result, { guildId: forGuild, ticket, action }) => {
            notifications.show({
                color: 'brand',
                title: 'Done',
                message: `${formatTicketNumber(ticket.ticketNumber)} ${TICKET_ACTION_PRESENTATION[action].done}.`,
            });
            if (result.syncWarning) {
                notifications.show({
                    color: 'red',
                    title: 'Discord did not keep up',
                    message: result.syncWarning,
                    autoClose: false,
                });
            }
            const touched: readonly QueryKey[] = [
                listTicketsQueryKey({ path: { guildId: forGuild } }),
                getTicketQueryKey({ path: { guildId: forGuild, ticketId: String(ticket.id) } }),
            ];
            for (const queryKey of touched) queryClient.removeQueries({ queryKey, type: 'inactive' });
            await Promise.all(touched.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        },
        onError: (error, { action }) => {
            const message =
                error instanceof ApiError
                    ? error.message
                    : `Couldn't ${TICKET_ACTION_PRESENTATION[action].label.toLowerCase()} that ticket.`;
            notifications.show({ color: 'red', title: 'No dice', message });
        },
        onSettled: () => {
            inFlight.current = false;
        },
    });

    const acting =
        mutation.isPending && mutation.variables
            ? { ticketId: mutation.variables.ticket.id, action: mutation.variables.action }
            : null;

    return {
        acting,
        act: (ticket, action) => {
            if (!guildId || inFlight.current) return;
            inFlight.current = true;
            mutation.mutate({ guildId, ticket, action });
        },
    };
}
