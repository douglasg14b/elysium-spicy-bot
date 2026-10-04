import type { TicketPermissionModel, TicketTypeUpdate, TicketTypeView } from '@brattybot/web-sdk';

/**
 * The ticket-type editor's draft, and the request it becomes.
 *
 * There are no rules here. The editor checks a draft against the SDK's generated zod for
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
