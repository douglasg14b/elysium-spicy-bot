import { DiscordAPIError, HTTPError, RESTJSONErrorCodes } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { describeDiscordError, isAlreadyGone } from '../discordErrors';

/**
 * `describeDiscordError` feeds HTTP response bodies and dashboard reports, so what it must
 * never do is hand back the thrown value's own text. Every case below throws an error whose
 * message is a marker, and asserts the marker does not come out the other side.
 */

const RAW = 'RAW-DETAIL connect ETIMEDOUT 162.159.135.232:443';

function apiError(code: number, status = 403): DiscordAPIError {
    return new DiscordAPIError({ code, message: RAW }, code, status, 'POST', '/guilds/1/channels', {});
}

let logged: MockInstance<typeof console.error>;

beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    logged.mockRestore();
});

describe('describeDiscordError', () => {
    it('names a known refusal in a fixed sentence, keeping Discord’s name for it', () => {
        const described = describeDiscordError(apiError(RESTJSONErrorCodes.MissingPermissions));

        expect(described).toContain('(Missing Permissions)');
        expect(described).not.toContain('RAW-DETAIL');
    });

    it('reads the code off a plain error too, as `discordErrorCode` does', () => {
        const described = describeDiscordError(Object.assign(new Error(RAW), { code: RESTJSONErrorCodes.MaximumNumberOfGuildChannelsReached }));

        expect(described).toContain('channel limit');
        expect(described).not.toContain('RAW-DETAIL');
    });

    it('gives an unmapped Discord code by number only', () => {
        expect(describeDiscordError(apiError(40001, 401))).toBe('Discord refused it (error 40001)');
    });

    it('describes a Discord outage without its text', () => {
        const outage = new HTTPError(502, RAW, 'POST', RAW, { body: undefined, files: undefined });

        const described = describeDiscordError(outage);

        expect(described).toContain('having a moment');
        expect(described).not.toContain('RAW-DETAIL');
    });

    it('falls back to a fixed sentence for anything else, and logs the raw error server-side', () => {
        const raw = new Error(RAW);

        const described = describeDiscordError(raw);

        expect(described).not.toContain('RAW-DETAIL');
        expect(described).toContain('logs');
        expect(logged).toHaveBeenCalledWith(expect.any(String), raw);
    });
});

describe('isAlreadyGone', () => {
    it('counts an unknown message as gone, beside an unknown channel, guild and role', () => {
        expect(isAlreadyGone(apiError(RESTJSONErrorCodes.UnknownMessage, 404))).toBe(true);
        expect(isAlreadyGone(apiError(RESTJSONErrorCodes.UnknownChannel, 404))).toBe(true);
        expect(isAlreadyGone(apiError(RESTJSONErrorCodes.UnknownGuild, 404))).toBe(true);
        expect(isAlreadyGone(apiError(RESTJSONErrorCodes.UnknownRole, 404))).toBe(true);
    });

    it('does not count a refusal as gone', () => {
        expect(isAlreadyGone(apiError(RESTJSONErrorCodes.MissingAccess))).toBe(false);
        expect(isAlreadyGone(new Error(RAW))).toBe(false);
    });
});
