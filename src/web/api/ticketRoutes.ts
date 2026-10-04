import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Guild } from 'discord.js';
import { ticketingRepo } from '../../features/tickets/data/ticketingRepo';
import { TICKET_LIST_CAP, ticketsRepo } from '../../features/tickets/data/ticketsRepo';
import {
    isTicketingConfigConfigured,
    type TicketingConfig,
    type TicketTypeDefinition,
} from '../../features/tickets/data/ticketingSchema';
import { isTicketStatus, type TicketEntity, type TicketStatus } from '../../features/tickets/data/ticketsSchema';
import {
    applyTicketTransition,
    type TicketTransition,
} from '../../features/tickets/logic/applyTicketTransition';
import { getTicketTypeDefinition } from '../../features/tickets/logic/ticketTypes';
import {
    deleteTicketType,
    upsertTicketType,
    type SetTicketTypeRefusal,
} from '../../features/tickets/logic/setTicketTypes';
import { setTicketSettings, type SetTicketSettingsRefusal } from '../../features/tickets/logic/setTicketSettings';
import {
    TICKET_TYPE_KEY_MAX_LENGTH,
    TicketNameTemplateSchema,
    TicketTypeKeySchema,
    TicketTypeLabelSchema,
} from '../../features/tickets/logic/ticketTypeRules';
import { updateDeployedTicketMessage } from '../../features/tickets/utils/updateDeployedMessage';
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
import {
    categorySlotsShape,
    TicketActionResultSchema,
    TicketDetailSchema,
    ticketDetail,
    TicketingConfigViewSchema,
    ticketingConfigView,
    TicketListSchema,
    TicketPermissionModelSchema,
    ticketSummary,
} from './ticketBody';

/**
 * The tickets dashboard API: the list, one ticket, the four lifecycle actions, and the
 * ticket config including its type editor.
 *
 * Mounted at `/api/guilds` beside the guild, flow and journey routers, so
 * `requireGuildAccess` already covers everything here and **no middleware is added**.
 * The existing single tier — Administrator or Manage Guild — is the tier; a ticket is
 * moderator-facing data in a guild the caller already administers, and inventing a
 * second authorization concept for it would leave two answers to one question.
 *
 * **Delete is absent on purpose.** A ticket delete destroys the channel and is
 * deliberately Discord-only; the dashboard can claim, unclaim, close and reopen.
 *
 * Described by the OpenAPI spec: each route's `createRoute` definition is its contract,
 * and the dashboard's SDK is generated from it. Requests are validated before a handler
 * runs, and a refusal answers with the first issue's message (see `apiRouter`). A rule's
 * fixed message crosses into the SDK's zod with it (`requestMessages.ts`), so the ticket
 * type editor refuses a bad key or template with the server's own sentence.
 */

/**
 * A ceiling on the moderation-role list, and on how much of a rejection is echoed back.
 *
 * A Discord snowflake is at most 20 characters and no server has 50 moderation roles, so
 * both are generous. They exist because the rejection path interpolates every unmatched id
 * into its error message: without a cap, a request carrying 100k ids passes validation,
 * runs 100k cache lookups, and builds a 100k-id error string — caller-controlled
 * amplification out of what looks like a helpful message.
 */
const MODERATION_ROLES_MAX = 50;
const ROLE_ID_MAX_LENGTH = 32;
const REJECTED_ROLES_ECHOED = 10;

/** Discord's limit on a channel name, categories included. */
const CATEGORY_NAME_MAX_LENGTH = 100;

/**
 * The list's filters, all optional; an absent one means "all" rather than "none".
 *
 * `status` is a plain string here and checked in the handler, because its refusal names
 * the value it was given — a sentence no schema can carry into the spec. `unclaimed` is
 * a string for the same reason it always was: only `true` narrows.
 *
 * `type` is bounded by the key rule's own maximum. Types are guild-defined, so there is no
 * closed vocabulary to check it against, but an unbounded string would still reach a query
 * predicate on every request. It is a bound parameter, so this is not about injection.
 */
const TicketListQuerySchema = z.object({
    status: z.string().optional().openapi({
        description: '`open`, `closed` or `deleted`. Absent or blank means every status.',
    }),
    type: z.string().max(TICKET_TYPE_KEY_MAX_LENGTH, 'That is not a ticket type.').optional().openapi({
        description: 'A ticket type key. Absent or blank means every type.',
    }),
    unclaimed: z.string().optional().openapi({
        description: '`true` for unclaimed tickets only. Anything else means claimed or not.',
    }),
    search: z.string().optional().openapi({
        description:
            'A ticket number, matched exactly, or the start of a name on the ticket. Trimmed; blank means no search.',
    }),
});

/**
 * One category slot as the page sends it: an existing category by id, a new one by
 * name, or `null` to leave the slot as it is.
 *
 * An id and a name are separate shapes, never one string that might be either — a
 * display name that doubles as a binding is how two same-named categories get confused.
 *
 * Not named for the spec: zod-to-openapi flattens a nullable union into one `anyOf` with
 * `null` and drops the name, so the browser reads it off `TicketsConfigUpdate` instead.
 */
const categoryChoice = z
    .union([
        z.strictObject({ discordId: z.string().regex(/^\d{17,20}$/, 'That is not a Discord category id.') }),
        z.strictObject({
            name: z
                .string()
                .trim()
                .min(1, 'A new category needs a name. Discord insists on calling things something.')
                .max(CATEGORY_NAME_MAX_LENGTH, 'Discord caps a category name at 100 characters.'),
        }),
    ])
    .nullable();

/**
 * The guild-wide ticket settings this page owns.
 *
 * The three category slots and the moderation roles. **Not** the types — those have their
 * own routes, because a type edit is a modal on one row and sending the whole record
 * back on every category change is how one editor's save eats another's.
 *
 * An empty moderation-role list is refused: `resolveTicketAction` gates every ticket
 * button on holding one of these roles *or* native moderation permissions, so saving
 * none quietly narrows who can work tickets to whoever has server-level perms.
 */
const TicketsConfigUpdateSchema = z
    .object({
        categories: z.strictObject(categorySlotsShape(categoryChoice)),
        moderationRoles: z
            .array(z.string().min(1).max(ROLE_ID_MAX_LENGTH))
            .min(1, 'Pick at least one moderation role, or nobody but admins can touch a ticket.')
            .max(MODERATION_ROLES_MAX, 'That is more moderation roles than any server has. Trim the list.'),
    })
    .openapi('TicketsConfigUpdate', {
        description:
            'The category slots and moderation roles. A slot given a `name` is created in Discord on save; ' +
            '`null` leaves a slot as it is.',
    });

/**
 * A ticket type as the editor submits it.
 *
 * The `type` key comes from the path, not the body, so the two cannot disagree about
 * which type is being written; a `type` in the body is stripped, not refused. The key,
 * label and template rules are `ticketTypeRules.ts`'s. The rules that need the renderer,
 * and whether the guild has a config row, are `upsertTicketType`'s.
 */
const TicketTypeUpdateSchema = z
    .object({
        label: TicketTypeLabelSchema,
        nameTemplate: TicketNameTemplateSchema,
        permissions: TicketPermissionModelSchema,
        autoClaimOnOpen: z.boolean(),
    })
    .openapi('TicketTypeUpdate', {
        description: 'A ticket type, without its key: that is the path.',
    });

/** The path of every route about one ticket. Its id is checked in the handler, whose refusal names it. */
const TicketPathSchema = GuildPathSchema.extend({
    ticketId: z.string(),
});

/** The path of a type save, whose key is held to the key rule before the handler runs. */
const TicketTypeSavePathSchema = GuildPathSchema.extend({
    type: TicketTypeKeySchema,
});

/** The path of a type delete. Any key: one this guild does not declare is a 404. */
const TicketTypeDeletePathSchema = GuildPathSchema.extend({
    type: z.string(),
});

/*
 * What the routes refuse with, beyond the middleware's own answers. One entry per status
 * in the spec, so a status two causes share names both. Not `as const`: see `openApi.ts`.
 */

/** A route about one ticket: the id it was given, or the ticket itself. */
const TICKET_ERRORS = {
    ...GUILD_SCOPED_ERRORS,
    400: errorBodyResponse('The ticket id is not a positive whole number, or the server id is missing.'),
    404: errorBodyResponse('The bot is not in this server, or the ticket is not in it.'),
};

/**
 * What each refusal from the shared type authority means over HTTP.
 *
 * A table keyed on the discriminated `reason` rather than a match on the message text.
 * The first version read `message.includes('does not declare')` to pick 404 over 409, and
 * this feature already carries **two** phrasings for that concept — "does not declare" in
 * `setTicketTypes` and "no longer declares" in `resolveTicketAction` — so unifying the
 * copy would have flipped a status code silently, with the route tests green because they
 * mock the message.
 *
 * `Record` rather than a lookup with a fallback, so a sixth refusal is a compile error
 * here instead of quietly defaulting to 409.
 *
 * `write-failed` is a 503, not a 409: the database being briefly unavailable is not the
 * operator's state being wrong, and telling them to go fix a conflict would send them
 * after something that is already correct.
 */
const REFUSAL_STATUS: Readonly<Record<SetTicketTypeRefusal, 400 | 404 | 409 | 503>> = {
    'no-config': 409,
    'undeclared-type': 404,
    'type-in-use': 409,
    'invalid-input': 400,
    'write-failed': 503,
};

/**
 * The same table for the settings save.
 *
 * `busy` is a 423, as a busy journey install is: the page must not reload settings the
 * other save is still changing. `create-failed` is a 502 because Discord refused, not the
 * operator — and the body says what *was* saved, since the rest of the save went through.
 */
const SETTINGS_REFUSAL_STATUS: Readonly<Record<SetTicketSettingsRefusal, 400 | 409 | 423 | 502 | 503>> = {
    'no-config': 409,
    'invalid-input': 400,
    busy: 423,
    'create-failed': 502,
    'write-failed': 503,
};

const listTicketsRoute = createRoute({
    method: 'get',
    path: '/{guildId}/tickets',
    operationId: 'listTickets',
    tags: ['tickets'],
    summary: "The guild's tickets, newest first",
    request: { params: GuildPathSchema, query: TicketListQuerySchema },
    responses: {
        200: jsonResponse('The matching tickets, and the guild-wide counts.', TicketListSchema),
        ...GUILD_SCOPED_ERRORS,
        400: errorBodyResponse(
            'A filter was refused — a status that is not one, or a type too long to be one — or the server id is missing.'
        ),
    },
});

const getTicketRoute = createRoute({
    method: 'get',
    path: '/{guildId}/tickets/{ticketId}',
    operationId: 'getTicket',
    tags: ['tickets'],
    summary: 'One ticket, in full',
    request: { params: TicketPathSchema },
    responses: {
        200: jsonResponse('The ticket.', TicketDetailSchema),
        ...TICKET_ERRORS,
    },
});

/**
 * The four lifecycle actions, each with its own operation so the SDK names them as the
 * dashboard always has. A `Record`, so a fifth transition is a compile error here rather
 * than an action the dashboard cannot reach.
 */
const TRANSITION_OPERATIONS: Readonly<Record<TicketTransition, { operationId: string; summary: string }>> = {
    claim: { operationId: 'claimTicket', summary: 'Claim a ticket as the signed-in operator' },
    unclaim: { operationId: 'unclaimTicket', summary: "Release a ticket's claim" },
    close: { operationId: 'closeTicket', summary: 'Close a ticket' },
    reopen: { operationId: 'reopenTicket', summary: 'Reopen a closed ticket' },
};

function transitionRoute(transition: TicketTransition) {
    return createRoute({
        method: 'post',
        path: `/{guildId}/tickets/{ticketId}/${transition}`,
        operationId: TRANSITION_OPERATIONS[transition].operationId,
        tags: ['tickets'],
        summary: TRANSITION_OPERATIONS[transition].summary,
        request: { params: TicketPathSchema },
        responses: {
            200: jsonResponse(
                'The ticket as it now stands. `syncWarning` is set when its channel did not follow.',
                TicketActionResultSchema
            ),
            ...TICKET_ERRORS,
            409: errorBodyResponse(
                "Nothing changed: the server has not finished setting up tickets, no longer declares the ticket's " +
                    'type, or the ticket is not in a state this action applies to. The sentence says which.'
            ),
        },
    });
}

const getTicketsConfigRoute = createRoute({
    method: 'get',
    path: '/{guildId}/config/tickets',
    operationId: 'getTicketsConfig',
    tags: ['tickets'],
    summary: 'The ticket settings and declared types',
    request: { params: GuildPathSchema },
    responses: {
        200: jsonResponse('The ticket config. A server that has not deployed tickets reads as not configured.', TicketingConfigViewSchema),
        ...GUILD_SCOPED_ERRORS,
    },
});

const updateTicketsConfigRoute = createRoute({
    method: 'put',
    path: '/{guildId}/config/tickets',
    operationId: 'updateTicketsConfig',
    tags: ['tickets'],
    summary: 'Set the category slots and moderation roles, creating any category given a name',
    request: { params: GuildPathSchema, body: jsonBody(TicketsConfigUpdateSchema) },
    responses: {
        200: jsonResponse('The ticket config as saved.', TicketingConfigViewSchema),
        ...GUILD_SCOPED_BODY_ERRORS,
        400: errorBodyResponse(
            'The body was refused, a moderation role is not in this server, a picked category is gone or the bot ' +
                'cannot work in it, or the server id is missing.'
        ),
        409: errorBodyResponse('The server has no ticket config yet: tickets have to be deployed in Discord first.'),
        423: errorBodyResponse('Another save of these settings is still running, so nothing was changed.'),
        502: errorBodyResponse('Discord refused to create a category. Everything else was saved, so re-read the settings.'),
        503: errorBodyResponse(
            'The settings could not be saved. A category already made in Discord stays made, and the sentence names it.'
        ),
    },
});

const saveTicketTypeRoute = createRoute({
    method: 'put',
    path: '/{guildId}/config/tickets/types/{type}',
    operationId: 'saveTicketType',
    tags: ['tickets'],
    summary: 'Add or replace one ticket type',
    request: { params: TicketTypeSavePathSchema, body: jsonBody(TicketTypeUpdateSchema) },
    responses: {
        200: jsonResponse('The ticket config as saved, every type included.', TicketingConfigViewSchema),
        ...GUILD_SCOPED_BODY_ERRORS,
        400: errorBodyResponse(
            'The key or the body was refused, the template renders to nothing or to more than Discord allows a ' +
                'channel name, or the server id is missing.'
        ),
        409: errorBodyResponse('The server has no ticket config yet: tickets have to be deployed in Discord first.'),
        503: errorBodyResponse('The type could not be saved. Nothing changed.'),
    },
});

const deleteTicketTypeRoute = createRoute({
    method: 'delete',
    path: '/{guildId}/config/tickets/types/{type}',
    operationId: 'deleteTicketType',
    tags: ['tickets'],
    summary: 'Remove a ticket type no ticket holds',
    request: { params: TicketTypeDeletePathSchema },
    responses: {
        204: { description: 'Deleted.' },
        ...GUILD_SCOPED_ERRORS,
        404: errorBodyResponse('The bot is not in this server, or the server declares no ticket type by that key.'),
        409: errorBodyResponse(
            'The server has no ticket config yet, or tickets still hold the type — deleted ones included. The ' +
                'sentence names how many, and some of their numbers.'
        ),
        503: errorBodyResponse('The type could not be deleted. Nothing changed.'),
    },
});

export function ticketRoutes(): OpenAPIHono<AppEnv> {
    return apiRouter((router) => {
        /**
         * The guild's tickets, newest first.
         *
         * Filters are all optional and an absent one means "all" rather than "none".
         * `search` goes to a parameterized repo query rather than being filtered in
         * memory: the list is unpaginated and a guild's whole ticket history is not a
         * thing to ship to a browser so it can hide most of it.
         */
        router.openapi(listTicketsRoute, async (c) => {
            const guild = c.get('guild');
            const query = c.req.valid('query');

            let status: TicketStatus | undefined;
            if (query.status) {
                if (!isTicketStatus(query.status)) {
                    return c.json({ error: `\`${query.status}\` is not a ticket status. Try open, closed or deleted.` }, 400);
                }
                status = query.status;
            }

            const filter = {
                status,
                type: query.type || undefined,
                unclaimedOnly: query.unclaimed === 'true',
            };

            const search = query.search?.trim();
            const found = search
                ? await ticketsRepo.searchByGuild(guild.id, search, filter)
                : await ticketsRepo.listByGuild(guild.id, filter);

            // Both reads ask for one row past the cap, so this can tell "exactly the cap" from
            // "more than it" without a second count. Drop the sentinel and report it, rather
            // than returning a short list that looks complete.
            const truncated = found.length > TICKET_LIST_CAP;
            const tickets = truncated ? found.slice(0, TICKET_LIST_CAP) : found;

            // One config read for the whole page. `typeLabel` is resolved from it per row
            // rather than joined in SQL, because a type is a member of a JSON blob and the
            // list is already in memory by the time it is needed.
            const config = await readConfig(guild.id);
            const counts = await ticketsRepo.countsByGuild(guild.id);

            return c.json(
                {
                    tickets: tickets.map((ticket) => ticketSummary(ticket, config)),
                    counts,
                    // The counts strip still reports the guild's true totals, so a capped list does
                    // not mislead — but the table needs to say it is showing a slice.
                    truncated,
                },
                200
            );
        });

        /** One ticket, in full. The record is all there is — the conversation lives in Discord. */
        router.openapi(getTicketRoute, async (c) => {
            const guild = c.get('guild');
            const resolved = await resolveTicket(guild, c.req.valid('param').ticketId);
            if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);

            const config = await readConfig(guild.id);
            return c.json(ticketDetail(resolved.ticket, config), 200);
        });

        /*
         * The four lifecycle actions, each one line apart from the others.
         *
         * Registered from a table rather than written out four times, because the only
         * thing that differs is the transition name — the gate, the cross-guild check, the
         * config resolution, the actor and the response shape are identical, and four
         * copies of that is four places for one of them to lose a check. This is the same
         * argument `applyTicketTransition` makes one layer down.
         */
        for (const transition of Object.keys(TRANSITION_OPERATIONS) as TicketTransition[]) {
            router.openapi(transitionRoute(transition), async (c) => {
                const guild = c.get('guild');

                // Checked per route rather than in a shared helper: this is the rule that
                // stops one guild's operator acting on another guild's ticket, and it is
                // worth being able to point at it in each handler.
                const resolved = await resolveTicket(guild, c.req.valid('param').ticketId);
                if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
                const ticket = resolved.ticket;

                const configEntity = await ticketingRepo.get(guild.id);
                if (!isTicketingConfigConfigured(configEntity)) {
                    return c.json(
                        {
                            error: 'This server has not finished setting up tickets, so there is nothing to move a ticket between. Deploy the ticket system first.',
                        },
                        409
                    );
                }

                const definition = getTicketTypeDefinition(configEntity.config, ticket.type);
                if (!definition) {
                    return c.json(
                        {
                            error: `Ticket #${ticket.ticketNumber} is typed \`${ticket.type}\`, which this server no longer declares. Re-add that ticket type before touching this one.`,
                        },
                        409
                    );
                }

                // The actor is the session, never the body. A body-supplied claimer id
                // would let an authorized operator claim on somebody else's behalf, which
                // is a different feature and not one that was asked for.
                const user = c.get('user');

                const result = await applyTicketTransition({
                    guild,
                    config: configEntity.config,
                    ticket,
                    definition,
                    transition,
                    actor: {
                        id: user.id,
                        // Named as a person acting through the dashboard rather than a raw
                        // `<@id>`: the announcement is posted into the ticket channel, and
                        // a mention would ping a moderator every time somebody clicked.
                        mention: `**${user.username}** (via the dashboard)`,
                        // The dashboard knows the session's username and nothing about
                        // their guild nickname — resolving one would mean a member fetch on
                        // a path built to avoid them. Null is honest: "not recorded".
                        identity: transition === 'claim' ? { username: user.username, nickname: null } : null,
                    },
                });

                // The service's own refusal, forwarded with its own words. 409 because the
                // request was well-formed and the ticket's state is what declined it.
                if (!result.ok) return c.json({ error: result.message }, 409);

                const config = await readConfig(guild.id);
                return c.json(
                    { ...ticketDetail(result.outcome.ticket, config), syncWarning: result.outcome.syncWarning },
                    200
                );
            });
        }

        /** The ticket config, including every declared type. */
        router.openapi(getTicketsConfigRoute, async (c) => {
            const guild = c.get('guild');
            const entity = await ticketingRepo.get(guild.id);
            return c.json(ticketingConfigView(guild, entity?.config ?? null), 200);
        });

        /**
         * Set the category slots and moderation roles.
         *
         * Through `setTicketSettings`, which may **create** categories — a slot given a name
         * is made on save — so this route changes the guild, not just the config. It spreads
         * the stored config rather than rebuilding it, so the types and anything added to
         * `TicketingConfig` later survive a save here.
         *
         * The deployed panel is refreshed afterwards, because the dashboard is now the only
         * place categories are chosen: without it the panel's Create button would stay
         * disabled after setup until something else happened to redraw it.
         */
        router.openapi(updateTicketsConfigRoute, async (c) => {
            const guild = c.get('guild');
            const body = c.req.valid('json');

            const rejected = body.moderationRoles.filter((roleId) => !guild.roles.cache.has(roleId));
            if (rejected.length > 0) {
                // Named, not counted — the operator has to go find these — but only the first
                // few, so the message stays a message. The array is capped at
                // `MODERATION_ROLES_MAX`, and echoing every rejected id of a full one would put
                // fifty snowflakes in a sentence nobody can read.
                const named = rejected.slice(0, REJECTED_ROLES_ECHOED).join(', ');
                const remainder = rejected.length - REJECTED_ROLES_ECHOED;
                const suffix = remainder > 0 ? ` (and ${remainder} more)` : '';
                return c.json(
                    {
                        error: `These are not roles in this server: ${named}${suffix}. Pick ones that exist — the bot cannot gate a ticket on a role Discord has never heard of.`,
                    },
                    400
                );
            }

            const result = await setTicketSettings({
                guild,
                categories: body.categories,
                moderationRoles: body.moderationRoles,
            });

            // A failed create still saved what it made, so the panel is redrawn for that too.
            if (result.ok || result.reason === 'create-failed') {
                await updateDeployedTicketMessage(guild).catch((error: unknown) => {
                    console.error('[tickets] Settings saved, but the deployed panel could not be refreshed:', error);
                });
            }

            if (!result.ok) return c.json({ error: result.message }, SETTINGS_REFUSAL_STATUS[result.reason]);
            return c.json(ticketingConfigView(guild, result.config), 200);
        });

        /**
         * Add or replace one ticket type.
         *
         * The key, label and template were held to `ticketTypeRules.ts` before this runs;
         * the shared `upsertTicketType` renders the template to check it fits a channel
         * name, and refuses a guild with no config.
         */
        router.openapi(saveTicketTypeRoute, async (c) => {
            const guild = c.get('guild');
            const body = c.req.valid('json');

            const definition: TicketTypeDefinition = {
                type: c.req.valid('param').type,
                label: body.label,
                nameTemplate: body.nameTemplate,
                permissions: body.permissions,
                autoClaimOnOpen: body.autoClaimOnOpen,
            };

            // Same table as the delete, so a "no config yet" on a save and on a delete get the
            // same answer rather than one being a 400 because that is what a body error is.
            const result = await upsertTicketType(guild.id, definition);
            if (!result.ok) return c.json({ error: result.message }, REFUSAL_STATUS[result.reason]);

            return c.json(ticketingConfigView(guild, result.config), 200);
        });

        /**
         * Remove a ticket type, unless tickets still hold it.
         *
         * The refusal is `deleteTicketType`'s and reaches the operator verbatim: it names
         * the counts by status and a handful of ticket numbers, which is what they have to
         * go and act on. A route that swallowed it and reported success would be the
         * failure this whole shared-authority arrangement exists to prevent.
         */
        router.openapi(deleteTicketTypeRoute, async (c) => {
            const guild = c.get('guild');

            const result = await deleteTicketType(guild.id, c.req.valid('param').type);
            if (!result.ok) {
                return c.json({ error: result.message }, REFUSAL_STATUS[result.reason]);
            }

            return c.body(null, 204);
        });
    });
}

/* ---- Helpers ---- */

/** The guild's config, or null. Read once per request and mapped over the rows. */
async function readConfig(guildId: string): Promise<TicketingConfig | null> {
    const entity = await ticketingRepo.get(guildId);
    return entity?.config ?? null;
}

type ResolveTicketResult =
    | { ok: true; ticket: TicketEntity }
    | { ok: false; error: string; status: 400 | 404 };

/**
 * The ticket named by a path parameter, in this guild.
 *
 * **A cross-guild ticket is a 404, never a 403.** `ticketsRepo.getById` matches on id
 * alone, so this check is the route's job — and answering 403 would confirm that
 * another guild's ticket exists, which is a disclosure dressed as a permission error.
 *
 * A non-numeric id is a 400: the operator's request is malformed rather than pointing
 * at something they may not see.
 */
async function resolveTicket(guild: Guild, rawId: string): Promise<ResolveTicketResult> {
    const ticketId = Number(rawId);
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
        return { ok: false, error: `\`${rawId}\` is not a ticket id.`, status: 400 };
    }

    const ticket = await ticketsRepo.getById(ticketId);
    if (!ticket || ticket.guildId !== guild.id) {
        return { ok: false, error: 'Ticket not found.', status: 404 };
    }

    return { ok: true, ticket };
}
