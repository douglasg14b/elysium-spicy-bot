import type { Warning, WarningCounts, WarningNoticeStatus, WarningPerson, WarningStatus } from '@brattybot/web-sdk';
import { memberNameLabel, type MemberNames } from '../members/memberNames';
import type { WarningFilterState } from './warningFilters';
import { filtersHideWarnings } from './warningFilters';

/**
 * How a warning is written on screen, in one place the list, the drawer and the dialogs read.
 */

/** The badge per status. A `Record`, so a fourth status is a compile error here. */
export const WARNING_STATUS_PRESENTATION: Readonly<
    Record<WarningStatus, { readonly label: string; readonly tone: 'orange' | 'gray' | 'brand' }>
> = {
    active: { label: 'Active', tone: 'orange' },
    expired: { label: 'Expired', tone: 'gray' },
    released: { label: 'Released', tone: 'brand' },
};

/**
 * Somebody on a warning: the name they go by now, from the bot's memory of members
 * (`names`); else the name the row recorded; else the raw id, for a warning written before
 * names were and somebody the bot cannot name — null means "not recorded", and inventing
 * "Unknown" would read as somebody's actual name (the tickets `participantLabel` rule).
 */
export function warningPersonLabel(person: WarningPerson, names: MemberNames): string {
    const known = names.get(person.id);
    return known ? memberNameLabel(known) : person.name || person.id;
}

/** Everybody a warning names — member, issuer, last editor, releaser — for one names request per view. */
export function warningPeopleIds(warning: Warning): string[] {
    return [warning.member.id, warning.issuedBy.id, warning.edited?.by.id, warning.released?.by.id].filter(
        (id): id is string => !!id
    );
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A warning's calendar date — `2026-10-29` — as `29 Oct 2026` in the reader's locale.
 *
 * Formatted **in UTC** from UTC midnight, so the day printed is the day sent: in any zone
 * west of Greenwich a plain `new Date('2026-10-29')` reads as the 28th. An em dash for
 * anything that is not a date, as the timestamp helpers do.
 */
export function formatWarningDay(date: string): string {
    const match = CALENDAR_DATE.exec(date);
    if (!match) return '—';
    const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return instant.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Whether a warning can still be edited or released. A released one is the record of a closed matter. */
export function warningIsOpen(warning: Pick<Warning, 'status'>): boolean {
    return warning.status !== 'released';
}

/** The three writes the page makes. */
export type WarningWrite = 'issue' | 'edit' | 'release';

/** What the page says when a write lands, naming the slug. */
export function warningWriteDone(write: WarningWrite, slug: string): string {
    switch (write) {
        case 'issue':
            return `${slug} is on the record. Somebody's been naughty.`;
        case 'edit':
            return `${slug} updated. Receipts amended.`;
        case 'release':
            return `${slug} released. They're off the hook — for now.`;
    }
}

/** What went wrong with a mod-log notice that did not go out. The warning is saved either way. */
export interface NoticeProblem {
    readonly title: string;
    readonly message: string;
}

const NOTICE_PROBLEMS: Readonly<Record<Exclude<WarningNoticeStatus, 'sent'>, NoticeProblem>> = {
    unconfigured: {
        title: 'Saved, but nobody was told',
        message:
            'This server has no mod-log channel, so no notice went out. Pick one under Warnings › Warning settings and the next one lands there.',
    },
    skipped: {
        title: "Saved, but the mod log didn't hear about it",
        message:
            "I can't reach the mod-log channel. Make sure I can see it, post in it and embed links — the warning itself is saved.",
    },
    failed: {
        title: 'Saved, but the notice blew up',
        message:
            'Posting to the mod-log channel failed. The warning is on the record; the receipts just never landed. Try a test post in that channel.',
    },
};

/** The persistent warning to show after a write, or null when its notice went out. */
export function noticeProblem(notice: WarningNoticeStatus): NoticeProblem | null {
    return notice === 'sent' ? null : NOTICE_PROBLEMS[notice];
}

/** The two date fields a server refusal can belong under. */
export type WarningDateField = 'issuedOn' | 'dropsOffOn';

/**
 * Which date field a refused write's sentence is about, or null when it is about neither.
 *
 * The date rules that need "today" or both dates (`resolveWarningDates`) are the server's and
 * arrive as a 400 carrying only a sentence, so the sentence is all there is to place it by.
 * Matched on how the server's date sentences open (`warningRefusals.ts`) — every one names
 * its field first. `src/features/warnings/logic/__tests__/warningBrowserMirrorDrift.test.ts`
 * runs every server date sentence through this, so a reworded one fails there. A sentence
 * this does not place goes to a notification: shown, just not under its field.
 */
export function dateRefusalField(sentence: string): WarningDateField | null {
    if (sentence.startsWith('Issued date')) return 'issuedOn';
    if (sentence.startsWith('Drop-off') || sentence.startsWith('That drop-off')) return 'dropsOffOn';
    return null;
}

/** What the empty table says, and the button it offers. */
export interface EmptyListCopy {
    readonly title: string;
    readonly body: string;
    /** `clear` resets the filters; `issue` opens the issue dialog. */
    readonly action: 'clear' | 'issue';
}

/** What an empty single-status list says when the server does have warnings — just none of these. */
const EMPTY_STATUS: Readonly<Record<WarningStatus, Pick<EmptyListCopy, 'title' | 'body'>>> = {
    active: {
        title: "Nobody's on thin ice",
        body: 'No warnings are counting against anyone right now. The expired and released ones are still on the record — filter for them above.',
    },
    expired: {
        title: 'Nothing has aged out yet',
        body: "No warning has run its course. They're all still counting — or someone's already been let off.",
    },
    released: {
        title: "Nobody's been let off the hook",
        body: 'No warning has been released. Mercy is in short supply around here.',
    },
};

/**
 * The empty table, told apart three ways: a member or a search hiding warnings that may
 * exist, a server with warnings but none of the status picked, and a server with none at all.
 */
export function emptyListCopy(filter: WarningFilterState, counts: WarningCounts | null): EmptyListCopy {
    if (filtersHideWarnings(filter)) {
        return {
            title: 'Nothing matches that',
            body: 'Your filters have narrowed this to nothing. The warnings may well exist — just not under these terms.',
            action: 'clear',
        };
    }
    const recorded = counts ? counts.active + counts.expired + counts.released : 0;
    if (recorded > 0 && filter.status !== 'all') {
        return { ...EMPTY_STATUS[filter.status], action: 'issue' };
    }
    return {
        title: 'No warnings yet',
        body: 'Either your members are angels or your mods are asleep. Issue one here or with /warn in Discord.',
        action: 'issue',
    };
}
