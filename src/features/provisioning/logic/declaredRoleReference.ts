/**
 * How a permission intent names a role the journey **declares** rather than one that
 * already exists in the guild.
 *
 * `PermissionIntent.roleIds` holds snowflakes, and a declared role has none until the
 * install that creates it. A journey that wants *"this channel is visible only to the
 * role this journey creates"* therefore has to name the role by its resource key, and
 * the key has to live somewhere the compiler can resolve it.
 *
 * ## The representation, and why this one
 *
 * A reference is the resource key behind a `resource:` prefix, stored **in `roleIds`
 * itself** — `resource:in-approval` sitting beside `847263...`.
 *
 * The alternative considered was a parallel `roleKeys?: readonly string[]` member on
 * `PermissionIntent`. It was rejected on four counts, in increasing order of weight:
 *
 *  1. It is a second array to keep in step with the first, in a Zod schema, in the
 *     browser mirror, and in every map over intents.
 *  2. `compilePermissionIntents` would have to merge two lists into one id set, so
 *     the merge becomes a thing that can be wrong.
 *  3. Ordering. Intents already carry meaning in their order — a later one wins
 *     per-id — and two arrays inside one intent raise a question the model does not
 *     currently have to answer: which of `roleIds` and `roleKeys` applies first?
 *     There is no good answer, only a convention to document and forget.
 *  4. **The repository already made this exact decision once, the other way.**
 *     `web/src/flows/controls/PickerControls.tsx` stores a picked declared resource
 *     as a `resource:`-prefixed value, for the stated reason that a key and a
 *     snowflake are both strings and the two spaces must be disjoint *by
 *     construction* rather than by assuming ids stay numeric. Inventing a second,
 *     differently-shaped answer to the same question here would leave the codebase
 *     holding two idioms for "this string is a key, not an id".
 *
 * Resolution happens in the **applier**, against the bindings the same install just
 * created, rather than in a pre-pass that rewrites declarations. The binding is the
 * canonical key→snowflake resolution everywhere else in this feature, so a second
 * resolution path would be a second thing to be wrong.
 *
 * The prefix is mirrored in `web/src/flows/declaredRoleReference.ts` — importing
 * across that boundary would drag the bot tree into the web build, which is the trade
 * `web/src/api/types.ts` documents. `__tests__/declaredRoleReference.test.ts` holds
 * the two constants equal.
 */

/**
 * Namespace marking a `roleIds` entry as a resource key.
 *
 * Safe against collision with a real snowflake by construction: Discord ids are
 * decimal digits, and a key is `[a-z0-9-]+` — but the guarantee here does not rest on
 * either fact, only on the prefix being absent from any id.
 */
export const DECLARED_ROLE_PREFIX = 'resource:';

/** Wrap a resource key so an intent's `roleIds` can carry it. */
export function declaredRoleReference(resourceKey: string): string {
    return `${DECLARED_ROLE_PREFIX}${resourceKey}`;
}

/**
 * The resource key a `roleIds` entry names, or `undefined` if it is a plain id.
 *
 * The single place that decides whether a string is a reference. Everything that
 * needs the distinction — validation, ordering, compilation — asks here, so there is
 * one definition rather than three `startsWith` calls that can drift.
 */
export function parseDeclaredRoleReference(roleId: string): string | undefined {
    return roleId.startsWith(DECLARED_ROLE_PREFIX)
        ? roleId.slice(DECLARED_ROLE_PREFIX.length)
        : undefined;
}

/**
 * Every declared resource key a set of intents references, deduplicated.
 *
 * Used by `validateJourneyDeclaration` to reject an unknown key, and by
 * `orderResourcesForApply` to build the edge that makes a referenced role get created
 * first. Both need the same answer, so neither re-derives it.
 */
export function declaredRoleReferencesIn(
    intents: readonly { readonly roleIds?: readonly string[] }[] | undefined
): readonly string[] {
    if (!intents) return [];

    const keys = new Set<string>();
    for (const intent of intents) {
        for (const roleId of intent.roleIds ?? []) {
            const key = parseDeclaredRoleReference(roleId);
            if (key) keys.add(key);
        }
    }
    return [...keys];
}
