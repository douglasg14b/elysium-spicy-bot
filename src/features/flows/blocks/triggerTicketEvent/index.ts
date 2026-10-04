import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { TICKET_CHANGE_KINDS, TICKET_VARIABLES, type TicketChangeKind } from '../../../tickets';

export const TRIGGER_TICKET_EVENT = 'trigger.ticketEvent';

/**
 * How each announced change reads in the event dropdown and on the card.
 *
 * A record over the ticket service's own vocabulary, so a change the service learns to
 * announce is a compile error here until it has a label — the schema below accepts every
 * kind the service names, and the dropdown is built from this, so the two cannot drift.
 */
const EVENT_LABELS: Readonly<Record<TicketChangeKind, string>> = {
    opened: 'Opened',
    claimed: 'Claimed',
    unclaimed: 'Unclaimed',
    closed: 'Closed',
    reopened: 'Reopened',
    deleted: 'Deleted',
};

/**
 * Which change starts the run, and optionally which type of ticket it must happen to.
 *
 * `event` is the ticket service's own vocabulary of announced changes, read from it
 * rather than copied. `ticketType` is a type **key**, free text for the reason Open Ticket's is:
 * types are rows in the guild's config, so a closed union would refuse every type an
 * operator declares. Absent means any type; a key the guild no longer declares simply
 * matches nothing.
 */
export const ticketEventConfigSchema = z.object({
    event: z.enum(TICKET_CHANGE_KINDS).default('opened'),
    ticketType: z.string().min(1).optional(),
});

export type TicketEventConfig = z.infer<typeof ticketEventConfigSchema>;

/**
 * Starts a run when a ticket changes: opened, claimed, unclaimed, closed, reopened or
 * deleted.
 *
 * Matched and seeded by `logic/ticketEventDispatch.ts`, which owns everything this
 * manifest cannot know: which ticket, who it is about, who acted, and how deep in a
 * chain of flows the change sits.
 *
 * **Establishes `subject` only.** The subject is whoever the ticket is about — possibly
 * someone who has already left, exactly as on Member Leaves. There is an actor only when a
 * person made the change, never when a flow did, and a channel on every change but a
 * delete; promising either would let a graph that needs one go live on a path that cannot
 * always supply it. Later blocks reach the channel through `{{var.ticketChannelId}}`.
 */
export const block: BlockManifest<TicketEventConfig> = {
    type: TRIGGER_TICKET_EVENT,
    kind: 'trigger',
    label: 'Ticket Event',
    description:
        'Start the run when a ticket opens, gets claimed or dropped, closes, reopens or gets binned. Auto-claimed tickets only fire Opened, and Deleted has no channel left to talk in.',
    group: 'triggers',
    icon: '🎟️',
    configSchema: ticketEventConfigSchema,
    configFields: [
        {
            key: 'event',
            label: 'When a ticket is',
            control: 'select',
            options: TICKET_CHANGE_KINDS.map((kind) => ({ value: kind, label: EVENT_LABELS[kind] })),
            defaultValue: 'opened',
        },
        {
            key: 'ticketType',
            label: 'Ticket type',
            description: 'Leave it empty and any type will do.',
            control: 'ticketTypePicker',
            optional: true,
        },
    ],
    cardSummary: [
        { key: 'event', prefix: 'Ticket ' },
        { key: 'ticketType', prefix: ' · ', emptyText: 'any type' },
    ],
    note:
        "The member is whoever the ticket is about — even if they've already flounced out of the server, in which " +
        'case anything that acts on them fails, and a run that waits fails when it wakes, because there is nobody ' +
        "left to resume. Opened fires once the ticket's embed is up; a ticket whose embed never made it fires " +
        'nothing. Whoever made the change is the actor when a person did it; when a flow did, nobody is. Flows ' +
        'that keep setting each other off stop after five in a row.',
    handles: [{ label: 'Then', tone: 'neutral' }],
    /*
     * Seeded by the dispatcher under the names Open Ticket and Has Open Ticket also use,
     * so "close the ticket that started this" is a Close Ticket reading `{{var.ticketId}}`
     * with nothing else to wire.
     */
    outputs: [
        {
            naming: 'fixed',
            key: TICKET_VARIABLES.ticketId,
            label: 'Ticket ID',
            description: 'The ticket that changed.',
        },
        {
            naming: 'fixed',
            key: TICKET_VARIABLES.ticketChannelId,
            label: 'Ticket channel',
            description:
                "The ticket's channel. Not there on Deleted, or when the channel is gone or the bot can't reach it.",
            valueKind: 'channel',
        },
    ],
    requires: ['subject'],
    capabilities: [],
    startedBy: 'ticketChanged',
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
