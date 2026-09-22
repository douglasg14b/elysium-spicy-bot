import type { Guild } from 'discord.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { ticketingRepo } from '../../features/tickets/data/ticketingRepo';
import { ticketsRepo } from '../../features/tickets/data/ticketsRepo';
import {
    isTicketingConfigConfigured,
    type TicketingConfig,
    type TicketTypeDefinition,
} from '../../features/tickets/data/ticketingSchema';
import { TICKET_STATUSES, type TicketEntity, type TicketStatus } from '../../features/tickets/data/ticketsSchema';
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
import type { AppEnv } from '../types';

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
 */

/** Only these narrow a list. `all` is the absence of a filter, not a fourth status. */
const statusFilter = z.enum(TICKET_STATUSES);

const ticketRolePermissions = z.object({
    view: z.boolean(),
    send: z.boolean(),
    readHistory: z.boolean(),
    manageMessages: z.boolean(),
});

/**
 * A ticket type as the editor submits it.
 *
 * The `type` key comes from the path, not the body, so the two cannot disagree about
 * which type is being written. Everything else Zod can see is checked here; the two
 * rules it cannot — that the guild has a config row, and that `nameTemplate` uses only
 * tokens the renderer implements — belong to `upsertTicketType`, which the Discord
 * surface shares.
 */
const ticketTypeBody = z.object({
    label: z.string().trim().min(1, 'Give the type a label — operators have to pick it out of a list.'),
    nameTemplate: z
        .string()
        .trim()
        .min(1, 'A channel-name template cannot be empty. Discord insists on calling channels something.'),
    permissions: z.object({
        subject: ticketRolePermissions,
        opener: ticketRolePermissions,
        staff: ticketRolePermissions,
    }),
    autoClaimOnOpen: z.boolean(),
});

/**
 * The guild-wide ticket settings this page owns.
 *
 * Three category names and the moderation roles. **Not** the types — those have their
 * own routes, because a type edit is a modal on one row and sending the whole record
 * back on every category rename is how one editor's save eats another's.
 *
 * An empty moderation-role list is refused: `resolveTicketAction` gates every ticket
 * button on holding one of these roles *or* native moderation permissions, so saving
 * none quietly narrows who can work tickets to whoever has server-level perms.
 */
const ticketConfigBody = z.object({
    supportTicketCategoryName: z
        .string()
        .trim()
        .min(1, 'Open tickets need a category to live in. Name it something you can find.'),
    claimedTicketCategoryName: z
        .string()
        .trim()
        .min(1, 'Claimed tickets need somewhere to go, or nobody can tell what is being handled.'),
    closedTicketCategoryName: z
        .string()
        .trim()
        .min(1, 'Closed tickets need a category too — they do not simply evaporate, much as we all wish.'),
    moderationRoles: z
        .array(z.string().min(1))
        .min(1, 'Pick at least one moderation role, or nobody but admins can touch a ticket.'),
});

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

export function ticketRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    /**
     * The guild's tickets, newest first.
     *
     * Filters are all optional and an absent one means "all" rather than "none".
     * `search` goes to a parameterized repo query rather than being filtered in
     * memory: the list is unpaginated and a guild's whole ticket history is not a
     * thing to ship to a browser so it can hide most of it.
     */
    app.get('/:guildId/tickets', async (c) => {
        const guild = c.get('guild');

        const status = c.req.query('status');
        if (status && !statusFilter.safeParse(status).success) {
            return c.json({ error: `\`${status}\` is not a ticket status. Try open, closed or deleted.` }, 400);
        }

        const filter = {
            status: status ? (status as TicketStatus) : undefined,
            type: c.req.query('type') || undefined,
            unclaimedOnly: c.req.query('unclaimed') === 'true',
        };

        const search = c.req.query('search')?.trim();
        const tickets = search
            ? await ticketsRepo.searchByGuild(guild.id, search, filter)
            : await ticketsRepo.listByGuild(guild.id, filter);

        // One config read for the whole page. `typeLabel` is resolved from it per row
        // rather than joined in SQL, because a type is a member of a JSON blob and the
        // list is already in memory by the time it is needed.
        const config = await readConfig(guild.id);
        const counts: TicketCounts = await ticketsRepo.countsByGuild(guild.id);

        return c.json({
            tickets: tickets.map((ticket) => ticketSummary(ticket, config)),
            counts,
        });
    });

    /** One ticket, in full. The record is all there is — the conversation lives in Discord. */
    app.get('/:guildId/tickets/:ticketId', async (c) => {
        const guild = c.get('guild');
        const resolved = await resolveTicket(guild, c.req.param('ticketId'));
        if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);

        const config = await readConfig(guild.id);
        return c.json(ticketDetail(resolved.ticket, config));
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
    const TRANSITIONS: readonly TicketTransition[] = ['claim', 'unclaim', 'close', 'reopen'];

    for (const transition of TRANSITIONS) {
        app.post(`/:guildId/tickets/:ticketId/${transition}`, async (c) => {
            const guild = c.get('guild');

            // Checked per route rather than in a shared helper: this is the rule that
            // stops one guild's operator acting on another guild's ticket, and it is
            // worth being able to point at it in each handler.
            const resolved = await resolveTicket(guild, c.req.param('ticketId'));
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
            // Annotated, so the drift-gated interface is what actually goes on the wire
            // rather than a structurally-similar object literal the gate never sees.
            const body: TicketActionResult = {
                ...ticketDetail(result.outcome.ticket, config),
                syncWarning: result.outcome.syncWarning,
            };
            return c.json(body);
        });
    }

    /** The ticket config, including every declared type. */
    app.get('/:guildId/config/tickets', async (c) => {
        const guild = c.get('guild');
        const entity = await ticketingRepo.get(guild.id);
        return c.json(ticketingConfigView(guild, entity?.config ?? null));
    });

    /**
     * Replace the categories and moderation roles.
     *
     * Spreads the stored config rather than rebuilding it, so the types — and anything
     * added to `TicketingConfig` later — survive a save here. The config modal was a
     * complete literal with no spread and became a silent destructor the moment
     * `ticketTypes` joined the shape; this route is not repeating that.
     */
    app.put('/:guildId/config/tickets', async (c) => {
        const guild = c.get('guild');
        const parsed = ticketConfigBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        const rejected = parsed.data.moderationRoles.filter((roleId) => !guild.roles.cache.has(roleId));
        if (rejected.length > 0) {
            return c.json(
                {
                    error: `These are not roles in this server: ${rejected.join(', ')}. Pick ones that exist — the bot cannot gate a ticket on a role Discord has never heard of.`,
                },
                400
            );
        }

        /*
         * Wrapped, unlike most reads here, because this write is the one that can lose a
         * race with another editor: on sqlite the losing transaction raises `SQLITE_BUSY`
         * rather than clobbering, and letting that reach the error handler would answer
         * 500 — "the server is broken" — to a save that simply needs pressing again. The
         * two shared type routes already return retryable copy for the same reason; this
         * route was the one calling `mutateConfig` bare.
         */
        let saved: TicketingConfig | null;
        try {
            saved = await ticketingRepo.mutateConfig(guild.id, (current) =>
                current.config
                    ? {
                          ...current.config,
                          supportTicketCategoryName: parsed.data.supportTicketCategoryName,
                          claimedTicketCategoryName: parsed.data.claimedTicketCategoryName,
                          closedTicketCategoryName: parsed.data.closedTicketCategoryName,
                          moderationRoles: [...new Set(parsed.data.moderationRoles)],
                      }
                    : null
            );
        } catch (error) {
            console.error('[tickets] Error saving ticket config:', error);
            return c.json(
                {
                    error: 'Could not save that — something else was editing this server’s ticket config at the same moment. Try again in a second.',
                },
                503
            );
        }

        if (!saved) {
            return c.json(
                {
                    error: 'This server has no ticket config yet. Run /deploy-ticket-system in Discord first, then come back and tune it here.',
                },
                409
            );
        }

        return c.json(ticketingConfigView(guild, saved));
    });

    /**
     * Add or replace one ticket type.
     *
     * Through the shared `upsertTicketType`, which owns the template-token rules — so
     * an unimplemented token is refused with the same sentence a Discord surface would
     * give. 400 rather than 409: the body is what is wrong.
     */
    app.put('/:guildId/config/tickets/types/:type', async (c) => {
        const guild = c.get('guild');
        const parsed = ticketTypeBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        const definition: TicketTypeDefinition = {
            type: c.req.param('type'),
            label: parsed.data.label,
            nameTemplate: parsed.data.nameTemplate,
            permissions: parsed.data.permissions,
            autoClaimOnOpen: parsed.data.autoClaimOnOpen,
        };

        // Same table as the delete, so a "no config yet" on a save and on a delete get the
        // same answer rather than one being a 400 because that is what a body error is.
        const result = await upsertTicketType(guild.id, definition);
        if (!result.ok) return c.json({ error: result.message }, REFUSAL_STATUS[result.reason]);

        return c.json(ticketingConfigView(guild, result.config));
    });

    /**
     * Remove a ticket type, unless tickets still hold it.
     *
     * The refusal is `deleteTicketType`'s and reaches the operator verbatim: it names
     * the counts by status and a handful of ticket numbers, which is what they have to
     * go and act on. A route that swallowed it and reported success would be the
     * failure this whole shared-authority arrangement exists to prevent.
     */
    app.delete('/:guildId/config/tickets/types/:type', async (c) => {
        const guild = c.get('guild');
        const type = c.req.param('type');

        const result = await deleteTicketType(guild.id, type);
        if (!result.ok) {
            return c.json({ error: result.message }, REFUSAL_STATUS[result.reason]);
        }

        return c.body(null, 204);
    });

    return app;
}

/* ---- Wire shapes ---- */

/**
 * A person on a ticket, rendered from the row's own snapshot.
 *
 * Null names on a row written before the snapshot columns existed; the dashboard shows
 * the id then. Not backfilled, because backfilling means fetching every historical
 * member — the Discord call this shape exists to avoid.
 */
interface TicketParticipant {
    id: string;
    username: string | null;
    nickname: string | null;
}

interface TicketSummary {
    id: number;
    ticketNumber: number;
    type: string;
    /** Null when the guild no longer declares the type. The raw key is shown instead. */
    typeLabel: string | null;
    status: TicketStatus;
    title: string;
    subject: TicketParticipant;
    opener: TicketParticipant | null;
    claimer: TicketParticipant | null;
    channelId: string | null;
    openedAt: string;
    updatedAt: string;
}

/**
 * One ticket in full: the summary plus the reason and the rest of its timeline.
 *
 * There is no `messages` member and there will not be one. A ticket stores no
 * conversation — that lives in the Discord channel and is not in this database — so the
 * detail page links to the channel rather than pretending to have its history.
 */
interface TicketDetail extends TicketSummary {
    reason: string;
    claimedAt: string | null;
    closedAt: string | null;
    deletedAt: string | null;
}

/**
 * A lifecycle response: the updated ticket, plus whether Discord kept up.
 *
 * Gated by the drift test like the rest, and this one earns it most: `syncWarning` is the
 * highest-consequence string the feature sends. Rename it here without renaming it in the
 * browser and both pages' `if (result.syncWarning)` silently stops firing — so the
 * sentence that says *the subject can still read this channel* would go unshown, with a
 * green suite and nothing in either workspace's typecheck to object.
 */
interface TicketActionResult extends TicketDetail {
    syncWarning: string | null;
}

/** The three numbers the list's counts strip shows, for the whole guild. */
interface TicketCounts {
    open: number;
    unclaimed: number;
    closed: number;
}

/** One declared type, as the config editor reads and writes it. */
interface TicketTypeView {
    type: string;
    label: string;
    nameTemplate: string;
    permissions: TicketTypeDefinition['permissions'];
    autoClaimOnOpen: boolean;
}

/**
 * The ticket config for the config page.
 *
 * `deployed` rather than the three `modTicketsDeployed*` members: the page needs to
 * know whether there is a panel, not which message id it is. `moderationRoles` carries
 * resolved names beside the ids for the same reason `resolveGuildSettings` does — so a
 * role renders without a second round trip — and a role deleted since it was saved
 * keeps its id and loses its name rather than being quietly dropped from what was
 * saved.
 */
interface TicketingConfigView {
    configured: boolean;
    deployed: boolean;
    supportTicketCategoryName: string;
    claimedTicketCategoryName: string;
    closedTicketCategoryName: string;
    moderationRoleIds: string[];
    moderationRoles: { id: string; name: string }[];
    types: TicketTypeView[];
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

/** An id paired with whatever names the row recorded for it. */
function participant(
    id: string,
    username: string | null,
    nickname: string | null
): TicketParticipant {
    return { id, username, nickname };
}

function ticketSummary(ticket: TicketEntity, config: TicketingConfig | null): TicketSummary {
    return {
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        type: ticket.type,
        typeLabel: config ? getTicketTypeDefinition(config, ticket.type)?.label ?? null : null,
        status: ticket.status,
        title: ticket.title,
        subject: participant(ticket.subjectId, ticket.subjectUsername, ticket.subjectNickname),
        opener: ticket.openerId
            ? participant(ticket.openerId, ticket.openerUsername, ticket.openerNickname)
            : null,
        claimer: ticket.claimerId
            ? participant(ticket.claimerId, ticket.claimerUsername, ticket.claimerNickname)
            : null,
        channelId: ticket.channelId,
        openedAt: new Date(ticket.openedAt).toISOString(),
        updatedAt: new Date(ticket.updatedAt).toISOString(),
    };
}

function ticketDetail(ticket: TicketEntity, config: TicketingConfig | null): TicketDetail {
    return {
        ...ticketSummary(ticket, config),
        reason: ticket.reason,
        claimedAt: ticket.claimedAt ? new Date(ticket.claimedAt).toISOString() : null,
        closedAt: ticket.closedAt ? new Date(ticket.closedAt).toISOString() : null,
        deletedAt: ticket.deletedAt ? new Date(ticket.deletedAt).toISOString() : null,
    };
}

function ticketingConfigView(guild: Guild, config: TicketingConfig | null): TicketingConfigView {
    const moderationRoleIds = config?.moderationRoles ?? [];

    return {
        // A guild with no row is not configured and is not an error: it is a guild that
        // has not run `/deploy-ticket-system` yet, and the page says so rather than
        // 404ing at an operator who came to set it up.
        configured: isTicketingConfigConfigured(
            config ? { id: 0, guildId: guild.id, config, ticketNumberInc: 0, entityVersion: 1 } : null
        ),
        deployed: config?.modTicketsDeployed ?? false,
        supportTicketCategoryName: config?.supportTicketCategoryName ?? '',
        claimedTicketCategoryName: config?.claimedTicketCategoryName ?? '',
        closedTicketCategoryName: config?.closedTicketCategoryName ?? '',
        moderationRoleIds: [...moderationRoleIds],
        moderationRoles: moderationRoleIds
            .map((roleId) => guild.roles.cache.get(roleId))
            .filter((role): role is NonNullable<typeof role> => !!role)
            .map((role) => ({ id: role.id, name: role.name })),
        // Sorted by label so the editor's row order does not depend on JSON key order,
        // which is insertion-ordered and would shuffle when a type is replaced.
        types: Object.values(config?.ticketTypes ?? {})
            .map((definition) => ({
                type: definition.type,
                label: definition.label,
                nameTemplate: definition.nameTemplate,
                permissions: definition.permissions,
                autoClaimOnOpen: definition.autoClaimOnOpen,
            }))
            .sort((left, right) => left.label.localeCompare(right.label)),
    };
}

/**
 * The wire-shape member lists the drift test compares against the browser's copy.
 *
 * Exported as data for the same reason `NODE_DESCRIPTOR_KEYS` is: these interfaces
 * exist twice — here and hand-mirrored in `web/src/api/types.ts` — because a single
 * `import type` from `src/` into `web/src/` pulls the bot tree into the browser
 * project's compilation and breaks `pnpm build:web`. `satisfies` holds each list to its
 * interface here, the browser file does the same on its side, and
 * `ticketWireShapeDrift.test.ts` compares the two.
 */
export const TICKET_PARTICIPANT_KEYS = ['id', 'username', 'nickname'] as const satisfies readonly (keyof TicketParticipant)[];

export const TICKET_SUMMARY_KEYS = [
    'id',
    'ticketNumber',
    'type',
    'typeLabel',
    'status',
    'title',
    'subject',
    'opener',
    'claimer',
    'channelId',
    'openedAt',
    'updatedAt',
] as const satisfies readonly (keyof TicketSummary)[];

export const TICKET_DETAIL_KEYS = [
    ...TICKET_SUMMARY_KEYS,
    'reason',
    'claimedAt',
    'closedAt',
    'deletedAt',
] as const satisfies readonly (keyof TicketDetail)[];

export const TICKET_ACTION_RESULT_KEYS = [
    ...TICKET_DETAIL_KEYS,
    'syncWarning',
] as const satisfies readonly (keyof TicketActionResult)[];

export const TICKET_COUNTS_KEYS = ['open', 'unclaimed', 'closed'] as const satisfies readonly (keyof TicketCounts)[];

export const TICKET_TYPE_VIEW_KEYS = [
    'type',
    'label',
    'nameTemplate',
    'permissions',
    'autoClaimOnOpen',
] as const satisfies readonly (keyof TicketTypeView)[];

export const TICKETING_CONFIG_VIEW_KEYS = [
    'configured',
    'deployed',
    'supportTicketCategoryName',
    'claimedTicketCategoryName',
    'closedTicketCategoryName',
    'moderationRoleIds',
    'moderationRoles',
    'types',
] as const satisfies readonly (keyof TicketingConfigView)[];

/*
 * Each list is held to its interface in **both** directions. `satisfies` above rejects
 * a name that is not a member; the checks below reject a member missing from the list,
 * which is the direction that actually rots — a member added to a wire shape and never
 * mirrored is one the browser is served and cannot read.
 */
type KeyListsComplete =
    | Exclude<keyof TicketSummary, (typeof TICKET_SUMMARY_KEYS)[number]>
    | Exclude<keyof TicketDetail, (typeof TICKET_DETAIL_KEYS)[number]>
    | Exclude<keyof TicketParticipant, (typeof TICKET_PARTICIPANT_KEYS)[number]>
    | Exclude<keyof TicketActionResult, (typeof TICKET_ACTION_RESULT_KEYS)[number]>
    | Exclude<keyof TicketCounts, (typeof TICKET_COUNTS_KEYS)[number]>
    | Exclude<keyof TicketTypeView, (typeof TICKET_TYPE_VIEW_KEYS)[number]>
    | Exclude<keyof TicketingConfigView, (typeof TICKETING_CONFIG_VIEW_KEYS)[number]>;

/**
 * Do not delete as unused: removing this erases the guards above.
 *
 * The tuple wrapper is load-bearing. A bare `KeyListsComplete extends never` distributes
 * over the union and is vacuously true for an empty one, so it would pass whatever the
 * lists said — `[X] extends [never]` compares the whole union at once.
 */
const keyListsAreComplete: [KeyListsComplete] extends [never]
    ? true
    : ['A ticket wire-shape key list is missing a member', KeyListsComplete] = true;

void keyListsAreComplete;
