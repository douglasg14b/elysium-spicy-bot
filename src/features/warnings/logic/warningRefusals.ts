import { WARNING_DATE_PLACEHOLDER } from '../constants';
import type { WarningDateErrorKind } from './warningDates';

/**
 * The sentences a warning write refuses with, shared by Discord (`/warn`, `/warn-clear`)
 * and the dashboard's routes, so both surfaces say the same thing about the same mistake.
 */

/** What a warning's typed-in fields can be refused for: its dates, or a blank rule or description. */
export type WarningInputRefusal = WarningDateErrorKind | 'empty-rule' | 'empty-description';

/** The sentence for a refused field, the same on `/warn` and the dashboard. */
export function warningInputRefusalSentence(kind: WarningInputRefusal): string {
    switch (kind) {
        case 'empty-rule':
            return 'Rule cannot be empty. Name the line they crossed.';
        case 'empty-description':
            return 'Description cannot be empty. Tell the story.';
        case 'invalid-issued':
            return `Issued date has to be ${WARNING_DATE_PLACEHOLDER}. Time travel spelling doesn't count.`;
        case 'invalid-expires':
            return `Drop-off date has to be ${WARNING_DATE_PLACEHOLDER}.`;
        case 'issued-in-future':
            return "Issued date can't be in the future. Backdate all you want — just not tomorrow.";
        case 'expires-not-after-issued':
            return 'Drop-off has to be after the issued date, or this warning is already a ghost.';
        case 'expires-already-passed':
            return 'That drop-off date is already in the past. Pick a future one or leave it blank for six months.';
    }
}

/**
 * The sentence for a refused field on an edit. The same as {@link warningInputRefusalSentence}
 * but for a drop-off already past: an edit's drop-off cannot be left blank, but it can be left
 * where it was.
 */
export function editInputRefusalSentence(kind: WarningInputRefusal): string {
    if (kind === 'expires-already-passed') {
        return 'That drop-off date is already in the past. Pick a future one, or leave it where it was.';
    }
    return warningInputRefusalSentence(kind);
}

/** Where a sentence is read: in reply to a slash command, or on the dashboard, which has no `/warnings` to point at. */
export type WarningRefusalSurface = 'discord' | 'dashboard';

/** An edit that would change nothing. */
export const WARNING_UNCHANGED_SENTENCE = 'Nothing changed. Edit something or leave it be.';

/** An edit to a released warning. */
export const RELEASED_WARNING_EDIT_SENTENCE = "Released warnings are part of the record — they don't get edited.";

/** An edit that lost a race with somebody else's edit of the same warning. */
export const STALE_WARNING_EDIT_SENTENCE =
    'Somebody else edited this warning while you had it open. Reload it and make your change again.';

/** A release with no reason. Every release has one on record. */
export const EMPTY_RELEASE_REASON_SENTENCE = "A release needs a reason. Say why they're off the hook.";

/** A release of a slug this server has no warning by. */
export function releaseNotFoundSentence(slug: string, surface: WarningRefusalSurface): string {
    switch (surface) {
        case 'discord':
            return `No warning with slug \`${slug}\` in this server. Check /warnings before you start forgiving ghosts.`;
        case 'dashboard':
            return `No warning with slug \`${slug}\` in this server. You can't forgive a ghost.`;
    }
}

/** An edit of a slug this server has no warning by. */
export function editNotFoundSentence(slug: string): string {
    return `No warning with slug \`${slug}\` in this server. Can't edit a ghost.`;
}

/** A release of a warning somebody already released. */
export function alreadyReleasedSentence(slug: string): string {
    return `\`${slug}\` is already cleared. You already did the soft thing.`;
}
