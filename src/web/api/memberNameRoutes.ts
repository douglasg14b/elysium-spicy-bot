import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { MEMBER_NAME_LOOKUP_CAP, resolveMemberNames } from '../../features-system/member-names';
import type { AppEnv } from '../types';
import { MemberNameListSchema, MemberNameQuerySchema, memberName } from './memberNameBody';
import { apiRouter, errorBodyResponse, GUILD_SCOPED_ERRORS, GuildPathSchema, jsonResponse } from './openApi';
import { resolveUserId } from './userIdParam';

/**
 * Names for the ids the dashboard shows (`docs/plans/member-names.md`, §3).
 *
 * Mounted at `/api/guilds` beside the other guild routes, so `requireGuildAccess` already
 * covers it and **no middleware is added**. Counted against the Discord budget
 * (`rateLimit.ts`): an id nobody has seen is looked up from Discord.
 *
 * Reads through `resolveMemberNames`, which needs nothing the bot's listeners set up, so it
 * answers wherever the API runs.
 */

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
            return c.json({ members: rows.map(memberName) }, 200);
        });
    });
}
