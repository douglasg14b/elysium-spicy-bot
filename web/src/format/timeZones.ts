/**
 * Time zones as an operator picks them: an IANA name beside its current offset, for
 * example `America/New_York (UTC−04:00)`.
 */

/** One picker option: the IANA name stored, and the label shown. */
export interface TimeZoneOption {
    readonly value: string;
    readonly label: string;
}

/** The `timeZoneName` styles this module reads from `Intl`. */
type TimeZoneNameStyle = 'longOffset' | 'longGeneric';

/** `Intl`'s name for `timeZone` at `at`, in the given style. */
function timeZoneNamePart(timeZone: string, style: TimeZoneNameStyle, at: Date): string {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: style })
        .formatToParts(at)
        .find((part) => part.type === 'timeZoneName')?.value;
    if (!name) {
        throw new Error(`Intl gave no ${style} name for time zone ${timeZone}`);
    }
    return name;
}

/**
 * `timeZone`'s offset from UTC at `at`, as `UTC+05:30` or `UTC−04:00` (a true minus
 * sign, not a hyphen). Daylight saving moves it, which is why it takes the moment.
 *
 * Built from `Intl`'s `longOffset` name, which reads `GMT-04:00` — and plain `GMT` at
 * zero, so that case is spelled out rather than left as a bare `UTC`.
 */
export function timeZoneOffsetLabel(timeZone: string, at: Date): string {
    const offset = timeZoneNamePart(timeZone, 'longOffset', at).replace(/^GMT/, '');
    return offset ? `UTC${offset.replace('-', '−')}` : 'UTC+00:00';
}

/**
 * `timeZone`'s everyday name, such as `Pacific Time` for `America/Los_Angeles`, for
 * prose where the IANA name would read as jargon.
 */
export function timeZoneGenericName(timeZone: string, at: Date): string {
    return timeZoneNamePart(timeZone, 'longGeneric', at);
}

/** Every zone this browser lists, plus `UTC`, which V8 leaves out of its own list. */
function browserTimeZones(): Set<string> {
    return new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
}

/**
 * The spelling this browser's list uses for `timeZone`, or `timeZone` itself when the
 * list holds no equivalent.
 *
 * The server stores the operator's spelling, and browsers disagree on spelling: Chrome
 * lists `Asia/Calcutta` where Firefox lists `Asia/Kolkata`. Showing a saved zone in this
 * browser's own spelling keeps it to one entry in the picker, and keeps a save whose
 * answer is spelled differently from what was sent from reading as an unsaved change.
 */
export function browserTimeZoneSpelling(timeZone: string): string {
    const listed = browserTimeZones();
    if (listed.has(timeZone)) return timeZone;

    let canonical: string;
    try {
        canonical = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
    } catch (error) {
        // A zone newer than this browser's tz data: shown as saved, see `timeZoneOptions`.
        if (error instanceof RangeError) return timeZone;
        throw error;
    }
    return listed.has(canonical) ? canonical : timeZone;
}

/**
 * One option's label: the zone and its current offset, or — for a zone this browser's
 * tz data does not know — the zone and a plain statement that the offset is unknown.
 *
 * The second case is a saved zone newer than the browser, and it is labelled rather
 * than thrown: the zone is valid (the server accepted it) and rendering the settings
 * page must not crash because one browser is behind.
 */
function timeZoneOptionLabel(zone: string, at: Date): string {
    try {
        return `${zone} (${timeZoneOffsetLabel(zone, at)})`;
    } catch (error) {
        if (error instanceof RangeError) return `${zone} (offset unknown in this browser)`;
        throw error;
    }
}

/**
 * Every zone this browser knows, plus `UTC`, plus the saved zone when the browser's list
 * lacks it.
 *
 * That last one is the deleted-role pattern from the staff picker: a saved value missing
 * from the options would render the picker blank for a perfectly good setting. Pass the
 * saved zone through {@link browserTimeZoneSpelling} first, so an equivalent the list
 * already holds is not added a second time under another name.
 */
export function timeZoneOptions(savedTimeZone: string | null, at: Date): TimeZoneOption[] {
    const zones = browserTimeZones();
    if (savedTimeZone) zones.add(savedTimeZone);

    return [...zones]
        .sort((left, right) => left.localeCompare(right))
        .map((zone) => ({ value: zone, label: timeZoneOptionLabel(zone, at) }));
}

/**
 * Whether a picker option's label answers what the operator typed.
 *
 * Both sides are folded the same way, because nobody types a label the way it is
 * spelled: `new york` must find `America/New_York`, and `-04` must find the true minus
 * sign in `UTC−04:00`.
 */
export function timeZoneLabelMatches(label: string, search: string): boolean {
    return foldForSearch(label).includes(foldForSearch(search));
}

function foldForSearch(text: string): string {
    return text.trim().toLowerCase().replace(/_/g, ' ').replace(/−/g, '-');
}
