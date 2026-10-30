/** A user id a route was given, held to what a Discord user id can be. Shared by the leveling and warnings routes. */

export type ResolveUserIdResult =
    | { ok: true; userId: string }
    | { ok: false; error: string; status: 400 };

/** A snowflake is an unsigned 64-bit integer. */
const MAX_SNOWFLAKE = 2n ** 64n - 1n;

/** How much of a refused id is echoed back. */
const ECHOED_ID_MAX_LENGTH = 32;

/**
 * Parse a user id before it can reach a query or Discord.
 *
 * A snowflake, so a length and digit check rather than `Number()` — the value exceeds
 * `Number.MAX_SAFE_INTEGER` and parsing it would corrupt the id it is meant to validate.
 *
 * Twenty digits can still exceed a snowflake's 64 bits, which Discord refuses as a malformed
 * request rather than an unknown member — so that bound is checked here too, as a `BigInt`.
 * The refusal echoes the id, cut short: a path segment or query value can be as long as the
 * caller likes.
 */
export function resolveUserId(rawId: string): ResolveUserIdResult {
    if (!/^\d{17,20}$/.test(rawId) || BigInt(rawId) > MAX_SNOWFLAKE) {
        const shown = rawId.length > ECHOED_ID_MAX_LENGTH ? `${rawId.slice(0, ECHOED_ID_MAX_LENGTH)}…` : rawId;
        return { ok: false, error: `\`${shown}\` is not a user id.`, status: 400 };
    }

    return { ok: true, userId: rawId };
}
