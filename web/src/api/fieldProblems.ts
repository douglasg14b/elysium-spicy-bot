/**
 * What a form shows under each field, from a check against the SDK's generated zod.
 *
 * The generated zod carries the server's own refusal sentences (`requestMessages.ts` on
 * the server), so an issue's `message` is what the server would answer with — shown as it
 * is, never reworded here. Typed by shape rather than by zod's own types, because the
 * dashboard reaches zod only through the SDK.
 */

/** One refusal, as a zod `safeParse` reports it. */
interface FieldIssue {
    readonly path: readonly PropertyKey[];
    readonly message: string;
}

/** A zod `safeParse` result, reduced to what {@link fieldProblems} reads. */
export type FieldCheck =
    | { readonly success: true }
    | { readonly success: false; readonly error: { readonly issues: readonly FieldIssue[] } };

/**
 * The first refusal per top-level field, keyed by field name. Empty means nothing the
 * server's declared rules would refuse.
 *
 * The first, because zod runs a field's rules in order and the server answers with the
 * first issue it meets — so this is the sentence a save would get back. A refusal of the
 * object as a whole, with no field to sit under, is keyed `''`: the map is still not
 * empty, so a form that disables its save on a non-empty map still does.
 */
export function fieldProblems(check: FieldCheck): Readonly<Partial<Record<string, string>>> {
    if (check.success) return {};

    const problems: Partial<Record<string, string>> = {};
    for (const issue of check.error.issues) {
        const field = issue.path.length ? String(issue.path[0]) : '';
        problems[field] ??= issue.message;
    }
    return problems;
}
