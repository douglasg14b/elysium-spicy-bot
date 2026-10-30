import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { fetchMemberSnapshotsById, toMemberSnapshot } from '../../features/leveling/logic/fetchMemberSnapshots';
import { WARNING_SLUG_INPUT_MAX_LENGTH } from '../../features/warnings/constants';
import { WARNING_LIST_CAP, warningsRepo } from '../../features/warnings/data/warningsRepo';
import type { WarningActor } from '../../features/warnings/data/warningsSchema';
import { clearGuildWarning } from '../../features/warnings/logic/clearGuildWarning';
import { editGuildWarning, type EditGuildWarningRefusal } from '../../features/warnings/logic/editGuildWarning';
import { issueGuildWarning } from '../../features/warnings/logic/issueGuildWarning';
import { notifyWarningEdited, notifyWarningReleased } from '../../features/warnings/logic/warningChangeNotices';
import { getActiveAsOfUtcMidnight } from '../../features/warnings/logic/warningDates';
import { notifyWarningIssued } from '../../features/warnings/logic/warningIssuedNotice';
import {
    alreadyReleasedSentence,
    editInputRefusalSentence,
    editNotFoundSentence,
    EMPTY_RELEASE_REASON_SENTENCE,
    RELEASED_WARNING_EDIT_SENTENCE,
    releaseNotFoundSentence,
    STALE_WARNING_EDIT_SENTENCE,
    WARNING_UNCHANGED_SENTENCE,
    warningInputRefusalSentence,
} from '../../features/warnings/logic/warningRefusals';
import { normalizeWarningSlug } from '../../features/warnings/logic/warningSlug';
import { isWarningStatus, type WarningStatus } from '../../features/warnings/logic/warningStatus';
import type { AppEnv } from '../types';
import {
    apiRouter,
    errorBodyResponse,
    GUILD_SCOPED_BODY_ERRORS,
    GUILD_SCOPED_ERRORS,
    GuildPathSchema,
    jsonBody,
    jsonResponse,
} from './openApi';
import { resolveUserId } from './userIdParam';
import {
    GuildMemberMatchListSchema,
    memberMatch,
    WarningIssueSchema,
    WarningListSchema,
    WarningReleaseRequestSchema,
    WarningResultSchema,
    WarningUpdateSchema,
    warningResult,
    warningView,
} from './warningBody';

/**
 * The warnings dashboard API: the list, issue, edit and release, and the member search the
 * issue dialog picks from (`docs/plans/warnings-in-the-dashboard.md`, §2).
 *
 * Mounted at `/api/guilds` beside the ticket routes, so `requireGuildAccess` already covers
 * everything here and **no middleware is added**. Owner-or-Administrator outranks the
 * Moderate Members gate the slash commands use, so there is no second permission check —
 * written down because it stops being true the moment moderators can sign in.
 *
 * **The actor is the session, never the body.** The dashboard knows the signed-in person's
 * username and nothing about their nickname here, so that is the name recorded.
 *
 * Issue, edit and release write through the same logic `/warn` and `/warn-clear` do, and
 * post the same mod-log notices; every write answers with the notice's status so the page
 * can say plainly when it did not go out.
 */

/** Long enough for any status, short enough that the refusal echoing it stays short. */
const WARNING_STATUS_MAX_LENGTH = 16;
/** Past the longest rule anything could match a prefix of; the slack is for pasted whitespace. */
const WARNING_SEARCH_MAX_LENGTH = 100;
/** Discord caps a username and a nickname at 32 characters, so a longer search matches nobody. */
const MEMBER_SEARCH_MAX_LENGTH = 32;
/** How many members one name search returns, before bots are left out. */
const MEMBER_SEARCH_LIMIT = 10;

/**
 * The list's filters, all optional; an absent one means "all".
 *
 * `status` and `userId` are plain strings checked in the handler, because each refusal
 * names the value it was given — a sentence no schema can carry into the spec.
 */
const WarningListQuerySchema = z.object({
    status: z
        .string()
        .max(WARNING_STATUS_MAX_LENGTH, 'That is not a warning status. Try active, expired or released.')
        .optional()
        .openapi({ description: '`active`, `expired` or `released`. Absent or blank means every status.' }),
    userId: z.string().optional().openapi({ description: "One member's warnings only, by their user id." }),
    search: z
        .string()
        .max(WARNING_SEARCH_MAX_LENGTH, 'That search is longer than anything on a warning. Shorten it.')
        .optional()
        .openapi({
            description:
                "The start of the slug, the rule, the member's name or the issuer's name, any case. Trimmed; blank " +
                'means no search.',
        }),
});

const MemberSearchQuerySchema = z.object({
    q: z
        .string()
        .trim()
        .min(1, 'Type the start of their name.')
        .max(MEMBER_SEARCH_MAX_LENGTH, 'Discord names stop at 32 characters, so that search matches nobody.')
        .openapi({ description: 'The start of a username or server nickname.' }),
});

/** The path of every route about one warning. Lower-cased and trimmed by the logic, as `/warn-clear` does. */
const WarningPathSchema = GuildPathSchema.extend({
    slug: z.string().max(WARNING_SLUG_INPUT_MAX_LENGTH, 'That is not a warning slug.'),
});

/**
 * What each edit refusal means over HTTP. A `Record`, so a new refusal is a compile error
 * here rather than a silent default.
 */
const EDIT_REFUSAL_STATUS: Readonly<Record<EditGuildWarningRefusal, 400 | 404 | 409>> = {
    'empty-rule': 400,
    'empty-description': 400,
    'invalid-issued': 400,
    'invalid-expires': 400,
    'issued-in-future': 400,
    'expires-not-after-issued': 400,
    'expires-already-passed': 400,
    unchanged: 400,
    'not-found': 404,
    released: 409,
    stale: 409,
};

function editRefusalSentence(kind: EditGuildWarningRefusal, slug: string): string {
    switch (kind) {
        case 'not-found':
            return editNotFoundSentence(slug);
        case 'released':
            return RELEASED_WARNING_EDIT_SENTENCE;
        case 'unchanged':
            return WARNING_UNCHANGED_SENTENCE;
        case 'stale':
            return STALE_WARNING_EDIT_SENTENCE;
        default:
            return editInputRefusalSentence(kind);
    }
}

/** A route about one warning: a slug this server has no warning by is a 404, whoever else has one. */
const WARNING_ERRORS = {
    ...GUILD_SCOPED_BODY_ERRORS,
    404: errorBodyResponse('The bot is not in this server, or the server has no warning by that slug.'),
};

const listWarningsRoute = createRoute({
    method: 'get',
    path: '/{guildId}/warnings',
    operationId: 'listWarnings',
    tags: ['warnings'],
    summary: "The server's warnings, newest issued first",
    request: { params: GuildPathSchema, query: WarningListQuerySchema },
    responses: {
        200: jsonResponse('The matching warnings, and the server-wide counts.', WarningListSchema),
        ...GUILD_SCOPED_ERRORS,
        400: errorBodyResponse(
            'A filter was refused — a status that is not one, a user id that is not one, or a search too long to ' +
                'match anything — or the server id is missing.'
        ),
    },
});

const issueWarningRoute = createRoute({
    method: 'post',
    path: '/{guildId}/warnings',
    operationId: 'issueWarning',
    tags: ['warnings'],
    summary: 'Warn a member as the signed-in operator, and post the mod-log notice',
    request: { params: GuildPathSchema, body: jsonBody(WarningIssueSchema) },
    responses: {
        201: jsonResponse('The warning as saved, and whether its notice went out.', WarningResultSchema),
        ...GUILD_SCOPED_BODY_ERRORS,
        400: errorBodyResponse(
            'The body was refused, a date rule refused the dates (the sentence says which), the member is not in ' +
                'this server, or the server id is missing.'
        ),
    },
});

const updateWarningRoute = createRoute({
    method: 'put',
    path: '/{guildId}/warnings/{slug}',
    operationId: 'updateWarning',
    tags: ['warnings'],
    summary: "Change a warning's rule, description and drop-off date, and post the mod-log notice",
    request: { params: WarningPathSchema, body: jsonBody(WarningUpdateSchema) },
    responses: {
        200: jsonResponse('The warning as saved, and whether its notice went out.', WarningResultSchema),
        ...WARNING_ERRORS,
        400: errorBodyResponse(
            'The body was refused, a date rule refused the drop-off (the sentence says which), nothing would ' +
                'change, or the server id is missing.'
        ),
        409: errorBodyResponse(
            'The warning is released, and released warnings are not edited; or somebody else edited it since ' +
                '`baseEditedAt` (or while this save ran), so nothing changed — reload it. The sentence says which.'
        ),
    },
});

const releaseWarningRoute = createRoute({
    method: 'post',
    path: '/{guildId}/warnings/{slug}/release',
    operationId: 'releaseWarning',
    tags: ['warnings'],
    summary: 'Release a warning — active or expired — with a reason, and post the mod-log notice',
    request: { params: WarningPathSchema, body: jsonBody(WarningReleaseRequestSchema) },
    responses: {
        200: jsonResponse('The warning as released, and whether its notice went out.', WarningResultSchema),
        ...WARNING_ERRORS,
        409: errorBodyResponse('The warning was already released. Nothing changed.'),
    },
});

const searchGuildMembersRoute = createRoute({
    method: 'get',
    path: '/{guildId}/members/search',
    operationId: 'searchGuildMembers',
    tags: ['members'],
    summary: 'Members whose name starts with a search, bots left out',
    request: { params: GuildPathSchema, query: MemberSearchQuerySchema },
    responses: {
        200: jsonResponse(
            `Up to ${MEMBER_SEARCH_LIMIT} members whose username or server nickname starts with the search, bots left out.`,
            GuildMemberMatchListSchema
        ),
        ...GUILD_SCOPED_ERRORS,
        400: errorBodyResponse('The search was blank or too long, or the server id is missing.'),
    },
});

export function warningRoutes(): OpenAPIHono<AppEnv> {
    return apiRouter((router) => {
        /**
         * The guild's warnings, newest issued first, capped at {@link WARNING_LIST_CAP}.
         * The counts are the whole guild's, so a filtered or capped list does not mislead.
         */
        router.openapi(listWarningsRoute, async (c) => {
            const guild = c.get('guild');
            const query = c.req.valid('query');

            let status: WarningStatus | undefined;
            if (query.status) {
                if (!isWarningStatus(query.status)) {
                    return c.json(
                        { error: `\`${query.status}\` is not a warning status. Try active, expired or released.` },
                        400
                    );
                }
                status = query.status;
            }

            let userId: string | undefined;
            if (query.userId) {
                const resolved = resolveUserId(query.userId);
                if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
                userId = resolved.userId;
            }

            const now = new Date();
            const asOf = getActiveAsOfUtcMidnight(now);
            const found = await warningsRepo.listByGuild(guild.id, asOf, {
                status,
                userId,
                search: query.search?.trim() || undefined,
            });

            // The repo reads one row past the cap, so this can tell "exactly the cap" from "more".
            const truncated = found.length > WARNING_LIST_CAP;
            const warnings = truncated ? found.slice(0, WARNING_LIST_CAP) : found;
            const counts = await warningsRepo.countsByGuild(guild.id, asOf);

            return c.json({ warnings: warnings.map((warning) => warningView(warning, now)), counts, truncated }, 200);
        });

        /**
         * Warn a member. The member is fetched, not trusted from the picker: the search result
         * is only a hint, and somebody who has left cannot be warned here. Their display name
         * now is what the warning records.
         */
        router.openapi(issueWarningRoute, async (c) => {
            const guild = c.get('guild');
            const body = c.req.valid('json');

            const resolved = resolveUserId(body.userId);
            if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);

            const member = (await fetchMemberSnapshotsById(guild, [resolved.userId])).get(resolved.userId);
            if (!member) {
                return c.json({ error: "They're not in this server. Warnings are for members, not ghosts." }, 400);
            }

            const user = c.get('user');
            const result = await issueGuildWarning({
                guildId: guild.id,
                userId: member.userId,
                userName: member.displayName,
                issuerId: user.id,
                issuerName: user.username,
                rule: body.rule,
                description: body.description,
                issuedInput: body.issuedOn ?? '',
                expiresInput: body.dropsOffOn ?? '',
            });
            if (!result.ok) return c.json({ error: warningInputRefusalSentence(result.kind) }, 400);

            const now = new Date();
            const notice = await notifyWarningIssued(guild, result.warning, now);
            return c.json(warningResult(result.warning, notice, now), 201);
        });

        /** Edit a warning. A released one is refused; a drop-off left as it was is not judged again. */
        router.openapi(updateWarningRoute, async (c) => {
            const guild = c.get('guild');
            const { slug } = c.req.valid('param');
            const body = c.req.valid('json');
            const user = c.get('user');
            const editedBy: WarningActor = { id: user.id, name: user.username };

            const result = await editGuildWarning({
                guildId: guild.id,
                slug,
                rule: body.rule,
                description: body.description,
                dropsOffInput: body.dropsOffOn,
                baseEditedAt: body.baseEditedAt,
                editedBy,
            });
            if (!result.ok) {
                return c.json(
                    { error: editRefusalSentence(result.kind, normalizeWarningSlug(slug)) },
                    EDIT_REFUSAL_STATUS[result.kind]
                );
            }

            const notice = await notifyWarningEdited(guild, {
                warning: result.warning,
                editedBy,
                changes: result.changes,
            });
            return c.json(warningResult(result.warning, notice, new Date()), 200);
        });

        /** Release a warning, active or expired, with the reason on record. */
        router.openapi(releaseWarningRoute, async (c) => {
            const guild = c.get('guild');
            const { slug } = c.req.valid('param');
            const { reason } = c.req.valid('json');
            const user = c.get('user');
            const releasedBy: WarningActor = { id: user.id, name: user.username };

            const result = await clearGuildWarning(guild.id, slug, releasedBy, reason);
            switch (result.status) {
                case 'not-found':
                    return c.json({ error: releaseNotFoundSentence(normalizeWarningSlug(slug), 'dashboard') }, 404);
                case 'empty-reason':
                    return c.json({ error: EMPTY_RELEASE_REASON_SENTENCE }, 400);
                case 'already-cleared':
                    return c.json({ error: alreadyReleasedSentence(result.warning.slug) }, 409);
                case 'cleared': {
                    const notice = await notifyWarningReleased(guild, result.warning);
                    return c.json(warningResult(result.warning, notice, new Date()), 200);
                }
            }
        });

        /**
         * Members whose username or nickname starts with `q` — Discord's own name-prefix
         * search, one request, never a full member fetch. Generic on purpose: the ban and
         * timeout pickers will reuse it.
         */
        router.openapi(searchGuildMembersRoute, async (c) => {
            const guild = c.get('guild');
            const { q } = c.req.valid('query');

            const found = await guild.members.search({ query: q, limit: MEMBER_SEARCH_LIMIT });
            const members = found
                .map(toMemberSnapshot)
                .filter((snapshot) => !snapshot.isBot)
                .map(memberMatch);

            return c.json(members, 200);
        });
    });
}
