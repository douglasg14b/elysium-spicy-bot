import type { TicketPermissionModel, TicketTypeView } from '../api/types';

/**
 * Client-side validation for the ticket-type editor.
 *
 * **The server stays the authority.** `upsertTicketType` re-checks every rule here and
 * its refusal is what an operator ultimately reads. This exists so the common mistakes
 * are named *before* a round trip, which is the same reasoning the journeys page gives
 * for disabling its delete button: telling somebody what to fix first beats letting them
 * press a button whose only outcome is a banner.
 *
 * It is a mirror, so it will drift if nobody keeps it honest — which is why the token
 * list below is spelled the same way and the test asserts the same token name the server
 * uses. Divergence here is a worse UX than having no client check at all: refusing
 * something the server would accept leaves an operator unable to save a legal type.
 */

/**
 * The only tokens `buildTicketChannelName` implements.
 *
 * Mirrored from `SUPPORTED_TOKENS` in `src/features/tickets/logic/setTicketTypes.ts`.
 * `{{user}}` and `{{creator}}` are the two the deleted phantom template named, and they
 * are rejected here for the same reason they are rejected there: nothing renders them,
 * so accepting one means a channel named after literal braces.
 */
export const SUPPORTED_TEMPLATE_TOKENS = ['####', 'subject', 'opener'] as const;

/** Discord's hard cap on a channel name. */
const CHANNEL_NAME_MAX_LENGTH = 100;

/** A type as the modal holds it while being edited. The key is separate — it is identity. */
export interface TicketTypeDraft {
    readonly type: string;
    readonly label: string;
    readonly nameTemplate: string;
    readonly permissions: TicketPermissionModel;
    readonly autoClaimOnOpen: boolean;
}

/**
 * Per-field problems, so each message lands under the input that caused it.
 *
 * A record rather than a single message: an operator fixing a template should not have
 * to re-submit to discover the label was also blank.
 */
export interface TicketTypeDraftProblems {
    readonly type?: string;
    readonly label?: string;
    readonly nameTemplate?: string;
}

/**
 * What a draft gets wrong, field by field. Empty means nothing local objects to.
 *
 * Deliberately **not** a full re-implementation of the server's renderer. The two rules
 * that need it — the maximum expansion and the empty render — are approximated here and
 * decided there; what this catches is the unrenderable *token*, which is the mistake an
 * operator actually makes and the one that used to be accepted silently.
 */
export function validateTicketTypeDraft(draft: TicketTypeDraft): TicketTypeDraftProblems {
    const problems: {
        type?: string;
        label?: string;
        nameTemplate?: string;
    } = {};

    const type = draft.type.trim();
    if (!type) {
        problems.type = 'A ticket type needs a key. Blank is not a category of anything.';
    } else if (!/^[a-z0-9_-]+$/.test(type)) {
        // The key reaches a channel name and a flow `select` value, so it is restricted
        // rather than merely non-blank. Same expression the server uses.
        problems.type = 'Lowercase letters, digits, `-` and `_` only. The label is where you get to be expressive.';
    }

    if (!draft.label.trim()) {
        problems.label = 'Give it a label — operators have to pick it out of a list.';
    }

    const template = draft.nameTemplate.trim();
    if (!template) {
        problems.nameTemplate = 'Channels need names. Discord is firm on this.';
        return problems;
    }

    const tokens = [...template.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]);
    const unsupported = tokens.find(
        (token) => !(SUPPORTED_TEMPLATE_TOKENS as readonly string[]).includes(token)
    );
    if (unsupported) {
        problems.nameTemplate = `\`{{${unsupported}}}\` is not a token this bot knows how to render. Use ${SUPPORTED_TEMPLATE_TOKENS.map(
            (token) => `\`{{${token}}}\``
        ).join(', ')} — nothing else.`;
        return problems;
    }

    // Anything brace-shaped left over is a token the renderer will not substitute:
    // `{{subject}` has no closing pair, so the scan above never sees it, and Discord
    // would strip the brace and leave a channel named after the word "subject".
    const withoutTokens = template.replace(/\{\{([^}]+)\}\}/g, '');
    if (/[{}]/.test(withoutTokens)) {
        problems.nameTemplate = 'A token needs exactly two braces each side. Check the spelling.';
        return problems;
    }

    // An approximation of the server's worst case: six digits, because `{{####}}` pads
    // to four without capping and the ticket counter is unbounded, plus two 32-character
    // usernames. Approximate because the server renders through the real sanitizer; this
    // only catches the template that is obviously too long to save.
    const expanded = template
        .replace(/\{\{####\}\}/g, '999999')
        .replace(/\{\{subject\}\}/g, 'a'.repeat(32))
        .replace(/\{\{opener\}\}/g, 'b'.repeat(32));
    if (expanded.length > CHANNEL_NAME_MAX_LENGTH) {
        problems.nameTemplate = `At its longest that renders about ${expanded.length} characters, and Discord caps a channel name at ${CHANNEL_NAME_MAX_LENGTH}. Trim it.`;
    }

    return problems;
}

/** Whether a draft is worth sending. Nothing local objects, so the server decides. */
export function isTicketTypeDraftValid(draft: TicketTypeDraft): boolean {
    return Object.keys(validateTicketTypeDraft(draft)).length === 0;
}

const ALL_ALLOWED = { view: true, send: true, readHistory: true, manageMessages: true };
const PARTICIPANT = { view: true, send: true, readHistory: true, manageMessages: false };

/**
 * A blank draft for a new type.
 *
 * Seeded with the participant/staff arrangement the shipped types use rather than all
 * false: a type created with nobody able to view its channel is a type that produces a
 * ticket nobody can read, and an operator opening a fresh form has not asked for that.
 */
export function emptyTicketTypeDraft(): TicketTypeDraft {
    return {
        type: '',
        label: '',
        nameTemplate: 'T{{####}}-{{subject}}',
        permissions: { subject: PARTICIPANT, opener: PARTICIPANT, staff: ALL_ALLOWED },
        autoClaimOnOpen: false,
    };
}

/** An existing type, as a draft the modal can edit. */
export function draftFromType(type: TicketTypeView): TicketTypeDraft {
    return {
        type: type.type,
        label: type.label,
        nameTemplate: type.nameTemplate,
        permissions: type.permissions,
        autoClaimOnOpen: type.autoClaimOnOpen,
    };
}
