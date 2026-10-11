import {
    zSaveTicketTypeBody,
    zSaveTicketTypePath,
    type TicketPermissionModel,
    type TicketTypeUpdate,
    type TicketTypeView,
} from '@brattybot/web-sdk';
import { fieldProblems } from '../api/fieldProblems';

/**
 * The ticket-type editor's draft, the request it becomes, and what its rules say about it.
 *
 * There are no rules written here. A draft is checked against the SDK's generated zod for
 * the save route — the server's own rules, refusing with the server's own sentences — so
 * nothing in the browser restates them. The two template rules that need the server's
 * renderer (that it renders to something, and that its longest render fits) are not in
 * the spec; the browser learns them from the refusal on save.
 */

/** A type as the modal holds it while being edited. The key is separate — it is identity. */
export interface TicketTypeDraft {
    readonly type: string;
    readonly label: string;
    readonly nameTemplate: string;
    readonly permissions: TicketPermissionModel;
    readonly autoClaimOnOpen: boolean;
}

/** A draft as the save route receives it: the key for the path, the rest for the body. */
export interface TicketTypeRequest {
    readonly type: string;
    readonly body: TicketTypeUpdate;
}

/**
 * The draft as it is sent, trimmed — and so as it is checked.
 *
 * The server trims the key, label and template before its rules see them, and a trim does
 * not survive into the spec, so the browser's zod would pass `"   "` as a label. Checking
 * what is sent rather than what was typed is what makes the two agree.
 */
export function ticketTypeRequest(draft: TicketTypeDraft): TicketTypeRequest {
    return {
        type: draft.type.trim(),
        body: {
            label: draft.label.trim(),
            nameTemplate: draft.nameTemplate.trim(),
            permissions: draft.permissions,
            autoClaimOnOpen: draft.autoClaimOnOpen,
        },
    };
}

/** What the server's declared rules refuse about a draft, per field, in its own words. */
export type TicketTypeDraftProblems = Readonly<Partial<Record<keyof TicketTypeDraft, string>>>;

/**
 * What the save route's declared rules would refuse about a draft, per field — the key
 * against its path rule, the rest against the body — checked as sent ({@link ticketTypeRequest}).
 *
 * Both the tickets page's editor and a journey's declared ticket type (the
 * `invalidTicketType` chip) ask this, so the two refuse with the same sentences, and both
 * are the server's. Every field at once, so fixing a template does not reveal on the next
 * try that the label was blank too. Empty means nothing the spec carries objects; the
 * template's rendered length needs the server's renderer and arrives as its refusal.
 */
export function validateTicketTypeDraft(draft: TicketTypeDraft): TicketTypeDraftProblems {
    const request = ticketTypeRequest(draft);
    const keyProblem = fieldProblems(zSaveTicketTypePath.shape.type.safeParse(request.type))[''];
    return {
        ...(keyProblem ? { type: keyProblem } : {}),
        ...fieldProblems(zSaveTicketTypeBody.safeParse(request.body)),
    };
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
