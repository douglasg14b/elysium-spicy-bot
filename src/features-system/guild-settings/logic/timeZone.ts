/**
 * The zones a server may pick: every IANA zone this runtime's `Intl` lists, plus `UTC`,
 * which V8 leaves out of `supportedValuesOf` while accepting it everywhere else.
 */
const SUPPORTED_TIME_ZONES: ReadonlySet<string> = new Set([
    ...Intl.supportedValuesOf('timeZone'),
    'UTC',
]);

/**
 * The spelling of `input` to store if it is a time zone a server may run on, or `null`
 * when it is not.
 *
 * **Validation canonicalises; storage does not.** `Intl` folds case and aliases onto
 * the name its own list uses, and that canonical name must be on the list (or be
 * `UTC`). The canonicalising matters because the browser's list and the server's
 * disagree on spelling: Firefox offers `Asia/Kolkata` where Node lists only
 * `Asia/Calcutta`, so a raw membership check would refuse a zone the picker itself
 * offered. Membership still has a job after it: `Intl` also accepts things that are not
 * zones a person picks, such as the raw offset `+05:00`, and those are refused.
 *
 * What is stored is the **operator's own spelling**, trimmed — Node canonicalises modern
 * names to legacy ones (`Europe/Kyiv` to `Europe/Kiev`), and a server that picked Kyiv
 * should not be shown Kiev. The one exception is a spelling that differs from the
 * canonical name only in letter case: that is a hand-typed `utc` or `america/new_york`,
 * and is tidied to the canonical name. Every runtime's `Intl` accepts either spelling,
 * so anything that schedules by the stored zone is unaffected.
 */
export function storableTimeZone(input: string): string | null {
    const spelled = input.trim();
    let canonical: string;
    try {
        canonical = new Intl.DateTimeFormat('en-US', { timeZone: spelled }).resolvedOptions().timeZone;
    } catch (error) {
        // `RangeError` is how `Intl` says "not a time zone"; anything else is a real fault.
        if (error instanceof RangeError) return null;
        throw error;
    }

    if (!SUPPORTED_TIME_ZONES.has(canonical)) return null;
    return canonical.toLowerCase() === spelled.toLowerCase() ? canonical : spelled;
}
