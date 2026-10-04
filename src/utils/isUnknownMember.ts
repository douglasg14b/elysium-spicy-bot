import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';

/**
 * Whether Discord answered that this user is not a member of the guild — they left, were
 * kicked or banned, or never joined.
 *
 * The one answer that proves someone is gone. Anything else from a member fetch — a
 * timeout, a rate limit, Missing Access — says nothing about whether they are still
 * there, and must not be read as "left".
 */
export function isUnknownMember(error: unknown): boolean {
    return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember;
}
