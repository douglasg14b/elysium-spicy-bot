/**
 * What a failed Discord call means, by numeric code rather than by message text.
 *
 * Matched numerically so a reworded message cannot turn "it is gone" into a failure, and
 * so a permission error is never mistaken for a tidy-up. Shared because two features now
 * need the same answer: teardown treats "already gone" as success, and ticket category
 * lookup treats it as the one signal that a category may be recreated. Mirrors
 * `isUnknownMessage` in `undeployFlowButtons.ts`, which does the same job for 10008.
 */

/** 10003 `Unknown Channel`. */
export const DISCORD_UNKNOWN_CHANNEL = 10003;
/** 10004 `Unknown Guild`. */
export const DISCORD_UNKNOWN_GUILD = 10004;
/** 10011 `Unknown Role`. */
export const DISCORD_UNKNOWN_ROLE = 10011;

/** Discord's numeric API error code, when the thrown value carries one. */
export function discordErrorCode(error: unknown): number | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code: unknown }).code;
        return typeof code === 'number' ? code : undefined;
    }
    return undefined;
}

/** "It is not there": an unknown channel, guild or role. */
export function isAlreadyGone(error: unknown): boolean {
    const code = discordErrorCode(error);
    return code === DISCORD_UNKNOWN_CHANNEL || code === DISCORD_UNKNOWN_GUILD || code === DISCORD_UNKNOWN_ROLE;
}

/** 50013 `Missing Permissions`, 50001 `Missing Access`. Named so the advice is useful. */
export function isPermissionProblem(error: unknown): boolean {
    const code = discordErrorCode(error);
    return code === 50013 || code === 50001;
}

export function describeDiscordError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
