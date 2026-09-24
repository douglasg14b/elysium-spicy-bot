/**
 * Joining names into the sentence shape this feature's copy is written in.
 *
 * One home for a rule that had grown three identical private copies — `installSummary`
 * and `publishedSummary` each held their own, and the grouping dialogs wanted a fourth.
 * Per `.cursor/rules/implementation-philosophy.mdc` the duplicates are merged rather
 * than a third variant added beside them.
 *
 * It is tested rather than inlined for the reason the rest of `flows/` splits this way:
 * `web/` has no jsdom, so a rule reachable only by rendering cannot be driven. This one
 * is small but is wrong *quietly* — an off-by-one in the separator produces "Welcome,
 * and Rules gate" or drops the last name entirely, neither of which crashes anything,
 * in copy whose whole job is naming the things an operator is about to affect.
 */

/** `a`, `a and b`, `a, b and c`. Empty for no names at all. */
export function joinWithAnd(parts: readonly string[]): string {
    if (parts.length <= 1) return parts[0] ?? '';
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
