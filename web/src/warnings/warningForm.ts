import {
    zIssueWarningBody,
    zUpdateWarningBody,
    type Warning,
    type WarningIssue,
    type WarningUpdate,
} from '@brattybot/web-sdk';
import { fieldProblems } from '../api/fieldProblems';
import { defaultDropsOff, pacificToday } from './warningDates';

/**
 * The issue/edit dialog's draft, the request it becomes, and what the server's rules say
 * about it.
 *
 * No rules are written here: a draft is checked against the SDK's generated zod for its
 * route, so the browser refuses with the server's own sentences. The date rules that need
 * "today" or both dates are not in the spec and arrive as the server's refusal on save.
 */

/** The form as the dialog holds it. Both modes share it; edit leaves `memberId` and `issuedOn` alone. */
export interface WarningDraft {
    /** The member's user id — bound by id, never by the name the picker shows. Null until one is picked. */
    readonly memberId: string | null;
    readonly rule: string;
    readonly description: string;
    readonly issuedOn: string;
    readonly dropsOffOn: string;
    /**
     * Whether the drop-off still moves with the issued date. True on a new warning until
     * somebody types a drop-off of their own, so backdating the issued day keeps the default
     * six months rather than quietly stretching it.
     */
    readonly dropsOffFollowsIssued: boolean;
}

/** A field a problem can sit under, as the routes name them. */
export type WarningFormField = 'userId' | 'rule' | 'description' | 'issuedOn' | 'dropsOffOn';

/** What the declared rules refuse, per field, in the server's words. */
export type WarningFormProblems = Readonly<Partial<Record<WarningFormField, string>>>;

/** A blank warning issued today, dropping off six months on — the server's own defaults. */
export function newWarningDraft(now: Date = new Date()): WarningDraft {
    const issuedOn = pacificToday(now);
    return {
        memberId: null,
        rule: '',
        description: '',
        issuedOn,
        dropsOffOn: defaultDropsOff(issuedOn) ?? '',
        dropsOffFollowsIssued: true,
    };
}

/** An existing warning, as the edit dialog loads it. */
export function draftFromWarning(warning: Warning): WarningDraft {
    return {
        memberId: warning.member.id,
        rule: warning.rule,
        description: warning.description,
        issuedOn: warning.issuedOn,
        dropsOffOn: warning.dropsOffOn,
        dropsOffFollowsIssued: false,
    };
}

/** The draft with a new issued date, carrying the drop-off along while it still follows. */
export function withIssuedOn(draft: WarningDraft, issuedOn: string): WarningDraft {
    if (!draft.dropsOffFollowsIssued) return { ...draft, issuedOn };
    // A half-typed date has no six-months-on; the drop-off keeps its last value until it does.
    return { ...draft, issuedOn, dropsOffOn: defaultDropsOff(issuedOn) ?? draft.dropsOffOn };
}

/** The draft with a drop-off somebody typed, which stops it following the issued date. */
export function withDropsOffOn(draft: WarningDraft, dropsOffOn: string): WarningDraft {
    return { ...draft, dropsOffOn, dropsOffFollowsIssued: false };
}

/**
 * The draft as the issue route receives it, trimmed — and so as it is checked. The server
 * trims the rule and description before its rules see them, and a trim does not survive into
 * the spec, so checking what was typed would pass `"   "` (the `ticketTypeForm` reasoning).
 *
 * A date left blank is sent as absent, which the route reads as its default — today, or six
 * months on — as its own refusals suggest ("…or leave it blank for six months").
 */
export function issueRequest(draft: WarningDraft): WarningIssue {
    return {
        userId: draft.memberId ?? '',
        rule: draft.rule.trim(),
        description: draft.description.trim(),
        issuedOn: draft.issuedOn.trim() || undefined,
        dropsOffOn: draft.dropsOffOn.trim() || undefined,
    };
}

/** The draft as the edit route receives it, with the `edited.at` the dialog loaded as its base. */
export function updateRequest(draft: WarningDraft, loaded: Pick<Warning, 'edited'>): WarningUpdate {
    return {
        rule: draft.rule.trim(),
        description: draft.description.trim(),
        dropsOffOn: draft.dropsOffOn.trim(),
        baseEditedAt: loaded.edited?.at ?? null,
    };
}

/** What the issue route's declared rules would refuse, per field. */
export function issueProblems(draft: WarningDraft): WarningFormProblems {
    return fieldProblems(zIssueWarningBody.safeParse(issueRequest(draft)));
}

/** What the edit route's declared rules would refuse, per field. */
export function updateProblems(draft: WarningDraft, loaded: Pick<Warning, 'edited'>): WarningFormProblems {
    return fieldProblems(zUpdateWarningBody.safeParse(updateRequest(draft, loaded)));
}

/**
 * Whether an edit would change nothing — compared as sent, so trailing spaces are not a
 * change. The server refuses an unchanged edit; Save stays disabled instead.
 */
export function editIsPristine(draft: WarningDraft, loaded: Pick<Warning, 'rule' | 'description' | 'dropsOffOn'>): boolean {
    return (
        draft.rule.trim() === loaded.rule &&
        draft.description.trim() === loaded.description &&
        draft.dropsOffOn.trim() === loaded.dropsOffOn
    );
}
