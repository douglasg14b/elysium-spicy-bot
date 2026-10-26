import { HTTPError, RESTJSONErrorCodes } from 'discord.js';

/**
 * What a failed Discord call means, by numeric code rather than by message text.
 *
 * Matched numerically so a reworded message cannot turn "it is gone" into a failure, and
 * so a permission error is never mistaken for a tidy-up. Shared because two features now
 * need the same answer: teardown treats "already gone" as success, and ticket category
 * lookup treats it as the one signal that a category may be recreated.
 */

/** 10003 `Unknown Channel`. */
export const DISCORD_UNKNOWN_CHANNEL = 10003;
/** 10004 `Unknown Guild`. */
export const DISCORD_UNKNOWN_GUILD = 10004;
/** 10008 `Unknown Message`. */
export const DISCORD_UNKNOWN_MESSAGE = 10008;
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

/**
 * "It is not there": an unknown channel, guild, message or role.
 *
 * A message counts because uninstall deletes a journey's messages before their channels,
 * and one deleted by hand between the plan and the confirm answers 10008 — the desired
 * state, not a failure.
 */
export function isAlreadyGone(error: unknown): boolean {
    const code = discordErrorCode(error);
    return (
        code === DISCORD_UNKNOWN_CHANNEL ||
        code === DISCORD_UNKNOWN_GUILD ||
        code === DISCORD_UNKNOWN_MESSAGE ||
        code === DISCORD_UNKNOWN_ROLE
    );
}

/** 50013 `Missing Permissions`, 50001 `Missing Access`. Named so the advice is useful. */
export function isPermissionProblem(error: unknown): boolean {
    const code = discordErrorCode(error);
    return code === 50013 || code === 50001;
}

/**
 * What each Discord refusal an operator can act on means, in a fixed sentence.
 *
 * Keyed by code, like everything above, and each sentence keeps Discord's own name for the
 * error in brackets so it can still be searched for.
 */
const DISCORD_ERROR_SENTENCES: ReadonlyMap<number, string> = new Map([
    [
        RESTJSONErrorCodes.MissingAccess,
        "the bot can't even see it (Missing Access) — check it can view that channel or category",
    ],
    [
        RESTJSONErrorCodes.MissingPermissions,
        "the bot's role isn't allowed to do that (Missing Permissions) — check its role and the channel's overwrites",
    ],
    [RESTJSONErrorCodes.UnknownChannel, 'that channel no longer exists (Unknown Channel)'],
    [RESTJSONErrorCodes.UnknownRole, 'that role no longer exists (Unknown Role)'],
    [RESTJSONErrorCodes.UnknownGuild, "the bot isn't in that server any more (Unknown Guild)"],
    [RESTJSONErrorCodes.UnknownMessage, 'that message no longer exists (Unknown Message)'],
    [
        RESTJSONErrorCodes.MaximumNumberOfGuildChannelsReached,
        "the server is at Discord's channel limit — delete some before asking for more",
    ],
    [
        RESTJSONErrorCodes.MaximumNumberOfGuildRolesReached,
        "the server is at Discord's role limit — delete some before asking for more",
    ],
    [
        RESTJSONErrorCodes.InvalidFormBodyOrContentType,
        'Discord rejected what the bot sent (Invalid Form Body) — usually a name it will not take, or a category that is already full',
    ],
]);

/**
 * A failed Discord call as words safe to show an operator: a clause, unpunctuated, written
 * to follow a caller's own `…: ` (every caller splices it so).
 *
 * Never the thrown value's own text. A Discord error's message carries request detail, a
 * network error's carries addresses, and a database error's carries whatever the driver
 * felt like saying — and these sentences reach HTTP response bodies and dashboard reports.
 * Known codes get their sentence; anything else gets a fixed one, and the raw error is
 * logged here, where it is described, so the detail is not lost — only kept server-side.
 *
 * Matched on the numeric `code` rather than `instanceof DiscordAPIError`, as
 * {@link discordErrorCode} is, so a refusal is described the same however it was thrown.
 */
export function describeDiscordError(error: unknown): string {
    console.error('[discord] A Discord call failed:', error);

    const code = discordErrorCode(error);
    const known = code === undefined ? undefined : DISCORD_ERROR_SENTENCES.get(code);
    if (known) {
        return known;
    }
    if (error instanceof HTTPError && error.status >= 500) {
        return 'Discord is having a moment of its own — try again shortly';
    }
    if (code !== undefined) {
        // The number is Discord's, not caller text, and it is what anybody debugging this
        // would search for.
        return `Discord refused it (error ${code})`;
    }
    return "something went wrong on the bot's side — the details are in its logs";
}
