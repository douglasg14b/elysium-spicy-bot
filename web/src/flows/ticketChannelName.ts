/**
 * The channel name an Open Ticket block will actually produce.
 *
 * The confusion this exists to end: the block has a **Title** field, and the
 * Discord channel is not named after it. The channel comes from the ticket
 * *type's* template — a separate vocabulary (`{{####}}`, `{{subject}}`,
 * `{{opener}}`) that happens to share `{{…}}` syntax with flow tokens and shares
 * nothing else. An author looking at the block could not tell what the channel
 * would be called, and the natural guess is wrong.
 *
 * A mirror of `TICKET_TYPE_DEFINITIONS` and `buildTicketChannelNameForType` in
 * `src/features/tickets/logic/ticketTypes.ts`. Mirrored rather than served: this
 * is four strings of static code constant that change roughly never, and the
 * alternatives both cost more than they buy — a ticket endpoint is a router, a
 * fetch, a loading state and an error state for data that is not per-guild, and
 * putting the preview on the validation response would make a hint that updates as
 * you type depend on a round trip and on having saved.
 *
 * `ticketChannelNamePreviewDrift.test.ts` holds the mirror to the real builder by
 * running both and comparing the output — so the *sanitizer* is gated too, not
 * just the template strings.
 */

import type { NodeDescriptor } from '../api/types';

/**
 * The config key holding the ticket type, once a block has declared it makes one.
 *
 * Read only after `createsChannel` says this block creates a channel — the
 * field name alone is not enough to go on, and an earlier draft that treated it as
 * enough is why this comment exists. `condition.hasOpenTicket` declares a
 * `ticketType` field too, and keying on the field told an author that a read-only
 * condition would create `#S0042-someone`. A field name is not a capability.
 */
const TICKET_TYPE_FIELD = 'ticketType';

/**
 * Each ticket type's channel-name template, mirroring the server's definitions.
 *
 * Note these are the *type definitions'* templates. `TicketingConfig` also carries
 * a `ticketChannelNameTemplate` column, which the ticket config modal displays —
 * but `buildTicketChannelNameForType` does not read it, so it names nothing. The
 * templates below are the ones Discord actually sees.
 */
export const TICKET_TYPE_NAME_TEMPLATES = {
    support: 'S{{####}}-{{subject}}-{{opener}}',
    verification: 'V{{####}}-{{subject}}',
} as const;

export type PreviewableTicketType = keyof typeof TICKET_TYPE_NAME_TEMPLATES;

/**
 * Whether a stored config value is a ticket type this build can preview.
 *
 * A saved graph may name a type added after this bundle shipped, and the inspector
 * has no error boundary above it. Degrading to no preview matches how the unknown
 * control and unknown node already behave.
 */
export function isPreviewableTicketType(value: unknown): value is PreviewableTicketType {
    return typeof value === 'string' && Object.hasOwn(TICKET_TYPE_NAME_TEMPLATES, value);
}

/**
 * The number a real ticket would carry, shown as a stand-in.
 *
 * Four digits because the real template pads to four. Not `0001`, which an author
 * would reasonably read as a prediction of their next ticket — the counter is a
 * per-guild database sequence allocated at open time, and nothing in the browser
 * knows where it has got to.
 */
const SAMPLE_TICKET_NUMBER = '0042';

/** The subject stand-in, matching the one {@link previewCopy} uses for a username. */
const SAMPLE_SUBJECT = 'someone';

/**
 * The channel name a ticket of this type would get, with stand-ins.
 *
 * Mirrors `buildTicketChannelNameForType` step for step, sanitizer included. A
 * preview that sanitized differently would be a preview of a name Discord never
 * sees — which is why the drift test compares the two by running both rather than
 * by comparing the template strings alone.
 *
 * `{{opener}}` always resolves to empty here: a flow-opened ticket has no opener
 * (`action.openTicket` passes `openerId: null`), so the separator collapse is not
 * an edge case in this preview but the normal path.
 */
export function previewTicketChannelName(type: PreviewableTicketType): string {
    return buildMirroredChannelName(type, SAMPLE_SUBJECT);
}

/**
 * The mirror of `buildTicketChannelNameForType`, over an arbitrary subject.
 *
 * Exported for the drift gate alone, and it is what makes that gate real: with
 * only {@link previewTicketChannelName} reachable, every comparison runs on the
 * stand-in `someone` — already lowercase and pure ASCII — so a mirror that had
 * dropped the lowercasing or the character strip would still agree with the
 * server on the one input anybody tested. It shipped that way for a commit, and a
 * sabotage check is what found it.
 *
 * The production path has exactly one caller and one input; this is the same code
 * with the subject lifted out, not a second implementation.
 */
export function buildMirroredChannelName(
    type: PreviewableTicketType,
    subjectName: string
): string {
    const sanitize = (name: string): string => name.replace(/[^a-z0-9-]/gi, '').toLowerCase();

    return TICKET_TYPE_NAME_TEMPLATES[type]
        .replace('{{####}}', SAMPLE_TICKET_NUMBER)
        .replace('{{subject}}', sanitize(subjectName))
        .replace('{{opener}}', '')
        .replace(/-+/g, '-')
        .replace(/-$/, '');
}

/**
 * The channel one node will create, or `undefined` if it creates none.
 *
 * The inspector's whole question, answered here rather than there. Gated on the
 * block's own `createsChannel` declaration, so this stays descriptor-driven:
 * the inspector never learns to recognise a block, and a second block that opened
 * tickets would declare the same member and get the preview for free.
 *
 * `undefined` covers three cases that all want silence — a block that creates no
 * channel, an author who has not picked a type yet, and a type this bundle does
 * not know. A saved graph naming a newer type must not break an inspector that
 * has no error boundary above it.
 */
export function ticketChannelNameFor(
    descriptor: Pick<NodeDescriptor, 'createsChannel'>,
    config: Record<string, unknown>
): string | undefined {
    if (!descriptor.createsChannel) {
        return undefined;
    }

    const type = config[TICKET_TYPE_FIELD];
    return isPreviewableTicketType(type) ? previewTicketChannelName(type) : undefined;
}
