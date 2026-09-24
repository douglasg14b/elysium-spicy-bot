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
 * A mirror of `buildTicketChannelName` in
 * `src/features/tickets/logic/ticketTypes.ts`, which the browser cannot import
 * because that module reaches `discord.js`.
 *
 * **The templates below are the seed, not the truth.** This file originally
 * claimed they were "static code constant that change roughly never" and that the
 * data "is not per-guild". Both stopped being true when a ticket type became a row
 * in `ticketing_config`: an operator can edit any template on the tickets config
 * page and declare types this bundle has never heard of. So the preview is honest
 * about its own reach — {@link isPreviewableTicketType} recognises only the seeded
 * keys, and an edited template renders the seeded preview, which is a name the
 * guild may no longer use.
 *
 * Closing that gap is the flow-builder ticket-type picker's job (plan step C):
 * once the picker reads the guild's own types it can carry their templates, and
 * {@link buildMirroredChannelName} already takes the template as an argument so
 * that the substitution logic will not need touching when it does.
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
 * The channel-name templates of the two types every guild is **seeded** with.
 *
 * Mirrors `DEFAULT_TICKET_TYPES` in
 * `src/features/tickets/data/defaultTicketTypes.ts`, which is the migration's seed
 * value — not a runtime lookup table. A guild's live templates are in its
 * `ticketing_config.ticketTypes`, and the drift gate can only hold this file to the
 * seed, because the seed is the only part that exists in source on both sides.
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
    return buildMirroredChannelName(TICKET_TYPE_NAME_TEMPLATES[type], SAMPLE_SUBJECT);
}

/**
 * The mirror of `buildTicketChannelName`, over an arbitrary template and subject.
 *
 * Takes the **template**, not a type key, for the same reason the server's builder
 * came to take a definition rather than a key: templates are operator-authored
 * per-guild data now, so a function that could only name the two keys compiled into
 * this bundle could not preview a guild's own type at all. The seeded keys reach it
 * through {@link previewTicketChannelName}.
 *
 * Exported for the drift gate too, and that is what makes the gate real: with only
 * {@link previewTicketChannelName} reachable, every comparison runs on the stand-in
 * `someone` — already lowercase and pure ASCII — so a mirror that had dropped the
 * lowercasing or the character strip would still agree with the server on the one
 * input anybody tested. It shipped that way for a commit, and a sabotage check is
 * what found it.
 *
 * **`replaceAll`, not `replace`**, matching the server. A string needle replaces
 * only the first occurrence, so a template repeating a token — which an operator
 * may now write, since templates are free text — rendered the second one literally:
 * `S{{####}}-{{subject}}-{{subject}}` previewed as `s0042-someone-subject` once
 * Discord stripped the braces. The server fixed this when templates became
 * editable; the mirror had to follow or it would preview a different name than the
 * one created.
 */
export function buildMirroredChannelName(template: string, subjectName: string): string {
    const sanitize = (name: string): string => name.replace(/[^a-z0-9-]/gi, '').toLowerCase();

    return template
        .replaceAll('{{####}}', SAMPLE_TICKET_NUMBER)
        .replaceAll('{{subject}}', sanitize(subjectName))
        .replaceAll('{{opener}}', '')
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
