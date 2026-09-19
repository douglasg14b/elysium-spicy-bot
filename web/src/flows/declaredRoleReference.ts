/**
 * How a permission intent names a role this flow *declares* rather than one that
 * exists.
 *
 * `PermissionIntent.roleIds` holds snowflakes, and a declared role has none until
 * install creates it. The reference is therefore the resource key wearing a prefix,
 * stored in the same `roleIds` array — `resource:in-approval` beside `847...`.
 *
 * **Why a prefix in `roleIds` rather than a parallel `roleKeys` field.** This is the
 * same decision `PickerControls.tsx` already took for `rolePicker`, and it is taken
 * the same way for the same reason: a resource key and a snowflake are both strings,
 * so the two id spaces have to be made disjoint by *construction* rather than by
 * assuming ids stay numeric. A parallel field would instead have meant a second array
 * to keep index-correlated with the first, a second arm in the server's Zod schema, a
 * second thing for the compiler to merge, and — the deciding cost — an ordering
 * question about which array applies first when both are populated. One array whose
 * entries are self-describing has no such question.
 *
 * The prefix is duplicated on the server (`declaredRoleReference.ts` under
 * `features/provisioning/logic/`) rather than imported, for the reason the whole
 * `api/types.ts` mirror exists: importing from `src/` into this workspace drags the
 * bot tree into `tsc -b`. A test holds the two constants equal.
 */

/**
 * Namespace for a declared role inside `roleIds`.
 *
 * Deliberately the same literal the pickers use for declared resources, because it
 * means the same thing in both places: what follows is a resource key, not an id.
 */
const DECLARED_ROLE_PREFIX = 'resource:';

/** Wrap a resource key as a role reference an intent can hold. */
export function declaredRoleOptionValue(resourceKey: string): string {
    return `${DECLARED_ROLE_PREFIX}${resourceKey}`;
}

/** The resource key a role reference names, or `undefined` for a plain snowflake. */
export function parseDeclaredRoleReference(roleId: string): string | undefined {
    return roleId.startsWith(DECLARED_ROLE_PREFIX)
        ? roleId.slice(DECLARED_ROLE_PREFIX.length)
        : undefined;
}

/** Exported for the drift test that holds this equal to the server's copy. */
export const DECLARED_ROLE_PREFIX_VALUE = DECLARED_ROLE_PREFIX;
