import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { MEMBER_NAME_LOOKUP_CAP, memberAvatarsRepo, resolveMemberNames } from '../../features-system/member-names';
import type { AppEnv } from '../types';
import { MemberNameListSchema, MemberNameQuerySchema, memberName } from './memberNameBody';
import { apiRouter, errorBodyResponse, GUILD_SCOPED_ERRORS, GuildPathSchema, jsonResponse } from './openApi';
import { pictureHeaders, pictureResponse } from './pictureResponse';
import { resolveUserId } from './userIdParam';

/**
 * Names for the ids the dashboard shows, and the avatars kept for them
 * (`docs/plans/member-names.md`, §3 and step 2).
 *
 * Mounted at `/api/guilds` beside the other guild routes, so `requireGuildAccess` already
 * covers it and **no middleware is added**. The names are counted against the Discord budget
 * (`rateLimit.ts`): an id nobody has seen is looked up from Discord. The avatar reads only
 * the database, so it is in the general budget alone.
 *
 * Reads through `resolveMemberNames`, which needs nothing the bot's listeners set up, so it
 * answers wherever the API runs.
 */

/** What an avatar the server holds none of — or holds for no one here — is told. */
export const MEMBER_AVATAR_NOT_FOUND_SENTENCE = "I've no picture of them in this server.";

const MemberAvatarPathSchema = GuildPathSchema.extend({
    userId: z.string(),
});

/** `v` is the picture's hash: it makes the address change with the picture. Not read when serving. */
const MemberAvatarQuerySchema = z.object({
    v: z.string().optional(),
});

const getMemberNamesRoute = createRoute({
    method: 'get',
    path: '/{guildId}/member-names',
    operationId: 'getMemberNames',
    tags: ['members'],
    summary: 'Who each of up to 100 user ids is in this server, members and leavers alike',
    request: { params: GuildPathSchema, query: MemberNameQuerySchema },
    responses: {
        200: jsonResponse(
            `One entry per id the bot knows. Ids it has not seen are looked up from Discord, up to ` +
                `${MEMBER_NAME_LOOKUP_CAP} a request; the rest are left out until a later one.`,
            MemberNameListSchema
        ),
        ...GUILD_SCOPED_ERRORS,
        400: errorBodyResponse('The ids were refused — none, too many, or one that is not a user id — or the server id is missing.'),
    },
});

const getMemberAvatarRoute = createRoute({
    method: 'get',
    path: '/{guildId}/member-names/{userId}/avatar',
    operationId: 'getMemberAvatar',
    tags: ['members'],
    summary: "The account avatar the bot keeps for someone this server has seen",
    description:
        'The picture itself, as the content type its bytes were read as, for an `<img src>` on a signed-in page — ' +
        "a `MemberName`'s `avatarUrl`. Not JSON, so not meant for the SDK.",
    request: { params: MemberAvatarPathSchema, query: MemberAvatarQuerySchema },
    responses: {
        200: pictureResponse("the address's `v` changes with the picture, so the browser may keep it."),
        ...GUILD_SCOPED_ERRORS,
        400: errorBodyResponse('The user id was refused, or the server id is missing.'),
        404: errorBodyResponse(
            'The bot is not in this server, this server has never seen the user, they have no avatar set, or the ' +
                'bot holds no picture of them.'
        ),
    },
});

export function memberNameRoutes(): OpenAPIHono<AppEnv> {
    return apiRouter((router) => {
        router.openapi(getMemberNamesRoute, async (c) => {
            const guild = c.get('guild');
            const { ids } = c.req.valid('query');

            const userIds = new Set<string>();
            for (const rawId of ids.split(',')) {
                const resolved = resolveUserId(rawId);
                if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
                userIds.add(resolved.userId);
            }

            const rows = await resolveMemberNames(guild, [...userIds]);
            const held = await memberAvatarsRepo.storedHashes(rows.map((row) => row.userId));
            return c.json({ members: rows.map((row) => memberName(row, held.get(row.userId))) }, 200);
        });

        /*
         * One member's kept avatar, served with `pictureHeaders` as `getGuildUpload` serves an
         * upload. Found through this guild's `member_names` row, so a server reads no picture
         * of an id it has never recorded. A refusal sets nothing and stays `no-store`.
         */
        router.openapi(getMemberAvatarRoute, async (c) => {
            const resolved = resolveUserId(c.req.valid('param').userId);
            if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);

            const file = await memberAvatarsRepo.fileFor(c.get('guild').id, resolved.userId);
            if (!file) {
                return c.json({ error: MEMBER_AVATAR_NOT_FOUND_SENTENCE }, 404);
            }
            // A copy, as `getGuildUpload` makes: `c.body` takes a `Uint8Array<ArrayBuffer>`.
            return c.body(new Uint8Array(file.bytes), 200, pictureHeaders(file.contentType));
        });
    });
}
