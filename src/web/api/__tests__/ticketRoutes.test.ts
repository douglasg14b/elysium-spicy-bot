import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/**
 * The tickets API contract.
 *
 * `ticketRoutes()` is a bare Hono app — auth and guild resolution are applied where it
 * is mounted in `api/index.ts` — so these tests inject a guild and a session user
 * directly and focus on what the route itself decides: guild scoping, validation, which
 * status a refusal gets, and the wire shape.
 *
 * The repos, the orchestration and the shared type authority are all mocked. Whether
 * `applyTicketTransition` sequences Discord correctly is settled in its own test, and
 * whether `deleteTicketType` refuses is settled in `setTicketTypes.test.ts`; re-proving
 * either through HTTP would test them twice and the routing layer not at all. What is
 * only testable here is whether the route *forwards* a refusal — a route that swallowed
 * one and reported success is a real failure shape this repo has produced before.
 */

const ticketsRepoMock = {
    getById: vi.fn(),
    listByGuild: vi.fn(),
    searchByGuild: vi.fn(),
    countsByGuild: vi.fn(),
};

const ticketingRepoMock = {
    get: vi.fn(),
    mutateConfig: vi.fn(),
};

const applyTicketTransition = vi.fn();
const upsertTicketType = vi.fn();
const deleteTicketType = vi.fn();

/*
 * `TICKET_LIST_CAP` is re-exported from the real module rather than re-declared here.
 *
 * A mock factory replaces the *whole* module, so a constant the route imports alongside the
 * repo silently becomes `undefined` — and an undefined cap makes the handler compare against
 * `undefined` and slice to `undefined`, which surfaces as an opaque 500 rather than a
 * readable assertion failure. Taking the real value also keeps the test pinned to the actual
 * bound instead of a copy of the number that could drift from it.
 */
vi.mock('../../../features/tickets/data/ticketsRepo', async () => {
    const actual = await vi.importActual<typeof import('../../../features/tickets/data/ticketsRepo')>(
        '../../../features/tickets/data/ticketsRepo'
    );
    return { ticketsRepo: ticketsRepoMock, TICKET_LIST_CAP: actual.TICKET_LIST_CAP };
});
vi.mock('../../../features/tickets/data/ticketingRepo', () => ({ ticketingRepo: ticketingRepoMock }));
vi.mock('../../../features/tickets/logic/applyTicketTransition', () => ({ applyTicketTransition }));
vi.mock('../../../features/tickets/logic/setTicketTypes', () => ({ upsertTicketType, deleteTicketType }));

const { ticketRoutes } = await import('../ticketRoutes');
// The real bound, read through the mock's re-export, so the cap tests below cannot drift
// from the value the route actually enforces.
const { TICKET_LIST_CAP } = await import('../../../features/tickets/data/ticketsRepo');

const GUILD_ID = 'guild-1';
const OTHER_GUILD_ID = 'guild-2';
const MOD_ROLE = '111111111111111111';
const SESSION_USER_ID = 'session-user';

const supportDefinition = {
    type: 'support',
    label: 'Support',
    nameTemplate: 'S{{####}}-{{subject}}',
    permissions: {
        subject: { view: true, send: true, readHistory: true, manageMessages: false },
        opener: { view: true, send: true, readHistory: true, manageMessages: false },
        staff: { view: true, send: true, readHistory: true, manageMessages: true },
    },
    autoClaimOnOpen: true,
};

function storedConfig(overrides: Record<string, unknown> = {}) {
    return {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: 'panel-channel',
        modTicketsDeployedMessageId: 'panel-message',
        supportTicketCategoryName: 'Tickets',
        claimedTicketCategoryName: 'Claimed',
        closedTicketCategoryName: 'Closed',
        moderationRoles: [MOD_ROLE],
        ticketTypes: { support: supportDefinition },
        ...overrides,
    };
}

function ticketRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 7,
        guildId: GUILD_ID,
        ticketNumber: 42,
        type: 'support',
        status: 'open',
        subjectId: 'subject-1',
        openerId: 'opener-1',
        claimerId: null,
        channelId: 'channel-1',
        subjectUsername: 'kittenuser',
        subjectNickname: 'Kitten',
        openerUsername: 'moduser',
        openerNickname: null,
        claimerUsername: null,
        claimerNickname: null,
        stateMessageId: 'state-1',
        title: 'A title',
        reason: 'The whole reason, at length.',
        openedAt: new Date('2026-09-01T00:00:00.000Z'),
        claimedAt: null,
        closedAt: null,
        deletedAt: null,
        updatedAt: new Date('2026-09-02T00:00:00.000Z'),
        ...overrides,
    };
}

function guildStub() {
    return {
        id: GUILD_ID,
        roles: { cache: new Map([[MOD_ROLE, { id: MOD_ROLE, name: 'Mods', managed: false }]]) },
        channels: { cache: new Map() },
    };
}

/**
 * The router behind a middleware that sets both context variables.
 *
 * `user` matters as much as `guild` here: the claim route reads the session for the
 * actor, so a stub without it would fail for a reason unrelated to what is under test.
 */
function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', guildStub() as never);
        c.set('user', { id: SESSION_USER_ID, username: 'operator', avatar: null, manageableGuildIds: [GUILD_ID] });
        await next();
    });
    outer.route('/', ticketRoutes());
    return outer;
}

function get(path: string) {
    return app().request(`/${GUILD_ID}${path}`);
}

function send(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown) {
    return app().request(`/${GUILD_ID}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

interface ErrorBody {
    error: string;
}

interface ListBody {
    tickets: { ticketNumber: number; typeLabel: string | null; type: string }[];
    counts: { open: number; unclaimed: number; closed: number };
    truncated: boolean;
}

const validTypeBody = {
    label: 'Appeals',
    nameTemplate: 'A{{####}}-{{subject}}',
    permissions: supportDefinition.permissions,
    autoClaimOnOpen: false,
};

beforeEach(() => {
    vi.clearAllMocks();
    ticketsRepoMock.listByGuild.mockResolvedValue([ticketRow()]);
    ticketsRepoMock.searchByGuild.mockResolvedValue([ticketRow()]);
    ticketsRepoMock.countsByGuild.mockResolvedValue({ open: 3, unclaimed: 1, closed: 9 });
    ticketsRepoMock.getById.mockResolvedValue(ticketRow());
    ticketingRepoMock.get.mockResolvedValue({
        id: 1,
        guildId: GUILD_ID,
        config: storedConfig(),
        ticketNumberInc: 42,
        entityVersion: 1,
    });
    ticketingRepoMock.mutateConfig.mockImplementation(
        async (_guildId: string, mutate: (current: unknown) => unknown) =>
            mutate({ id: 1, guildId: GUILD_ID, config: storedConfig(), ticketNumberInc: 42, entityVersion: 1 })
    );
    applyTicketTransition.mockResolvedValue({
        ok: true,
        outcome: { ticket: ticketRow({ claimerId: SESSION_USER_ID }), syncWarning: null },
    });
});

describe('GET /:guildId/tickets', () => {
    it('returns { tickets } and resolves each type label from config', async () => {
        const body = (await (await get('/tickets')).json()) as ListBody;

        expect(body.tickets).toHaveLength(1);
        expect(body.tickets[0].typeLabel).toBe('Support');
    });

    it('reports a ticket whose type is no longer declared with a null label rather than omitting it', async () => {
        // A row the guild can no longer describe is still a row somebody has to deal
        // with. Dropping it from the list would hide the exact tickets that need
        // attention, and the raw key is what the operator has to go and re-add.
        ticketsRepoMock.listByGuild.mockResolvedValue([ticketRow({ type: 'retired' })]);

        const body = (await (await get('/tickets')).json()) as ListBody;

        expect(body.tickets).toHaveLength(1);
        expect(body.tickets[0].type).toBe('retired');
        expect(body.tickets[0].typeLabel).toBeNull();
    });

    it('passes status and type filters through to the repo', async () => {
        await get('/tickets?status=open&type=support');

        expect(ticketsRepoMock.listByGuild).toHaveBeenCalledWith(GUILD_ID, {
            status: 'open',
            type: 'support',
            unclaimedOnly: false,
        });
    });

    it('passes the unclaimed filter through, because that is the queue', async () => {
        await get('/tickets?status=open&unclaimed=true');

        expect(ticketsRepoMock.listByGuild).toHaveBeenCalledWith(
            GUILD_ID,
            expect.objectContaining({ unclaimedOnly: true })
        );
    });

    it('rejects a status that is not one', async () => {
        const response = await get('/tickets?status=banana');

        expect(response.status).toBe(400);
        expect(ticketsRepoMock.listByGuild).not.toHaveBeenCalled();
    });

    it('sends a search to the repo rather than filtering in memory', async () => {
        // The list is unpaginated; shipping a guild's whole ticket history to the
        // browser so it can hide most of it is not a search.
        await get('/tickets?search=kitten');

        expect(ticketsRepoMock.searchByGuild).toHaveBeenCalledWith(GUILD_ID, 'kitten', expect.anything());
        expect(ticketsRepoMock.listByGuild).not.toHaveBeenCalled();
    });

    it('reports guild-wide counts that do not move when the list is filtered', async () => {
        const body = (await (await get('/tickets?status=closed')).json()) as ListBody;

        // Counted, not derived from the rows on the page: a strip that changed with the
        // filter would describe the page rather than the guild.
        expect(body.counts).toEqual({ open: 3, unclaimed: 1, closed: 9 });
        expect(ticketsRepoMock.countsByGuild).toHaveBeenCalledWith(GUILD_ID);
    });

    /*
     * The cap and its honesty flag. The repo asks for `CAP + 1` so the route can tell "the
     * cap exactly" from "more than the cap"; these pin both halves, because a table that
     * silently shows 200 of 4,000 rows invites an operator to conclude the other 3,800 do
     * not exist.
     */
    it('drops the sentinel row and reports truncated when the repo returns more than the cap', async () => {
        const overflowing = Array.from({ length: TICKET_LIST_CAP + 1 }, (_row, index) =>
            ticketRow({ id: index + 1, ticketNumber: index + 1 })
        );
        ticketsRepoMock.listByGuild.mockResolvedValue(overflowing);

        const body = (await (await get('/tickets')).json()) as ListBody;

        expect(body.truncated).toBe(true);
        expect(body.tickets).toHaveLength(TICKET_LIST_CAP);
    });

    it('reports truncated false when the repo returns exactly the cap', async () => {
        const exact = Array.from({ length: TICKET_LIST_CAP }, (_row, index) =>
            ticketRow({ id: index + 1, ticketNumber: index + 1 })
        );
        ticketsRepoMock.listByGuild.mockResolvedValue(exact);

        const body = (await (await get('/tickets')).json()) as ListBody;

        // The sentinel is what distinguishes these two cases, so the boundary is the whole
        // point: one row fewer and nothing is being hidden.
        expect(body.truncated).toBe(false);
        expect(body.tickets).toHaveLength(TICKET_LIST_CAP);
    });

    it('rejects an absurdly long type filter rather than passing it to a query predicate', async () => {
        const response = await get(`/tickets?type=${'x'.repeat(500)}`);

        expect(response.status).toBe(400);
        expect(ticketsRepoMock.listByGuild).not.toHaveBeenCalled();
    });
});

describe('GET /:guildId/tickets/:ticketId', () => {
    it('returns the ticket bare, with its reason in full', async () => {
        const response = await get('/tickets/7');
        const body = (await response.json()) as { ticketNumber: number; reason: string };

        expect(response.status).toBe(200);
        expect(body.ticketNumber).toBe(42);
        expect(body.reason).toBe('The whole reason, at length.');
    });

    it('404s a ticket belonging to another guild', async () => {
        // Never 403: answering "forbidden" would confirm that another guild's ticket
        // exists. `getById` matches on id alone, so this check is the route's job.
        ticketsRepoMock.getById.mockResolvedValue(ticketRow({ guildId: OTHER_GUILD_ID }));

        const response = await get('/tickets/7');

        expect(response.status).toBe(404);
    });

    it('404s a ticket that does not exist', async () => {
        ticketsRepoMock.getById.mockResolvedValue(null);

        expect((await get('/tickets/7')).status).toBe(404);
    });

    it('400s an id that is not a number', async () => {
        expect((await get('/tickets/nonsense')).status).toBe(400);
    });
});

describe('POST /:guildId/tickets/:ticketId/claim', () => {
    it('404s a ticket belonging to another guild', async () => {
        ticketsRepoMock.getById.mockResolvedValue(ticketRow({ guildId: OTHER_GUILD_ID }));

        const response = await send('/tickets/7/claim', 'POST');

        expect(response.status).toBe(404);
        expect(applyTicketTransition).not.toHaveBeenCalled();
    });

    it('uses the session user as the claimer and ignores a body-supplied one', async () => {
        await send('/tickets/7/claim', 'POST', { claimerId: 'somebody-else' });

        expect(applyTicketTransition).toHaveBeenCalledWith(
            expect.objectContaining({
                transition: 'claim',
                actor: expect.objectContaining({ id: SESSION_USER_ID }),
            })
        );
    });

    it('does not post a raw mention into the ticket channel', async () => {
        // A `<@id>` from a dashboard click would ping a moderator every time.
        await send('/tickets/7/claim', 'POST');

        const actor = applyTicketTransition.mock.calls[0][0].actor as { mention: string };
        expect(actor.mention).not.toMatch(/^<@/);
        expect(actor.mention).toContain('operator');
    });

    it('409s when the guild has no configured ticket system', async () => {
        ticketingRepoMock.get.mockResolvedValue(null);

        const response = await send('/tickets/7/claim', 'POST');

        expect(response.status).toBe(409);
        expect(applyTicketTransition).not.toHaveBeenCalled();
    });

    it('409s, naming the type, when the guild no longer declares this ticket’s type', async () => {
        ticketsRepoMock.getById.mockResolvedValue(ticketRow({ type: 'retired' }));

        const response = await send('/tickets/7/claim', 'POST');

        expect(response.status).toBe(409);
        expect(((await response.json()) as ErrorBody).error).toContain('retired');
        // No guessed permission model: re-permissioning a real channel from a default
        // is the thing the refusal exists to prevent.
        expect(applyTicketTransition).not.toHaveBeenCalled();
    });
});

describe('the four lifecycle routes', () => {
    /*
     * Registration is asserted for all four, because the routes are generated from a
     * `TRANSITIONS` table — this change's own deduplication — and the table's
     * completeness is what nothing else pins. Delete an entry and every other test here
     * stays green while a documented endpoint 404s.
     *
     * Previously only claim and close were exercised, which left half the surface
     * covered by the fact that it happened to be in a loop.
     */
    it.each(['claim', 'unclaim', 'close', 'reopen'] as const)(
        'registers POST /%s and forwards it as that transition',
        async (transition) => {
            const response = await send(`/tickets/7/${transition}`, 'POST');

            expect(response.status).toBe(200);
            expect(applyTicketTransition).toHaveBeenCalledWith(
                expect.objectContaining({ transition })
            );
        }
    );

    it.each(['claim', 'unclaim', 'close', 'reopen'] as const)(
        '404s a cross-guild ticket on /%s',
        async (transition) => {
            // The scoping check lives in one shared helper, so this asserts it is reached
            // from every one of the four rather than only from the two with bespoke tests.
            ticketsRepoMock.getById.mockResolvedValue(ticketRow({ guildId: OTHER_GUILD_ID }));

            expect((await send(`/tickets/7/${transition}`, 'POST')).status).toBe(404);
            expect(applyTicketTransition).not.toHaveBeenCalled();
        }
    );

    it.each(['unclaim', 'reopen'] as const)('forwards a refusal from /%s as a 409', async (transition) => {
        applyTicketTransition.mockResolvedValue({ ok: false, message: `Ticket #42 cannot be ${transition}ed.` });

        const response = await send(`/tickets/7/${transition}`, 'POST');

        expect(response.status).toBe(409);
        expect(((await response.json()) as ErrorBody).error).toContain('#42');
    });

    it.each(['unclaim', 'reopen'] as const)('surfaces syncWarning from /%s', async (transition) => {
        applyTicketTransition.mockResolvedValue({
            ok: true,
            outcome: { ticket: ticketRow(), syncWarning: '⚠️ the channel did not move.' },
        });

        const body = (await (await send(`/tickets/7/${transition}`, 'POST')).json()) as {
            syncWarning: string | null;
        };

        expect(body.syncWarning).toContain('did not move');
    });
});

describe('POST /:guildId/tickets/:ticketId/close', () => {
    it('returns 409 with the service’s own refusal when the ticket is already closed', async () => {
        applyTicketTransition.mockResolvedValue({ ok: false, message: 'Ticket #42 is already closed.' });

        const response = await send('/tickets/7/close', 'POST');

        expect(response.status).toBe(409);
        expect(((await response.json()) as ErrorBody).error).toBe('Ticket #42 is already closed.');
    });

    it('returns 200 and surfaces syncWarning when the row committed but the channel did not move', async () => {
        applyTicketTransition.mockResolvedValue({
            ok: true,
            outcome: {
                ticket: ticketRow({ status: 'closed' }),
                syncWarning: '⚠️ the subject may still be able to read this channel.',
            },
        });

        const response = await send('/tickets/7/close', 'POST');
        const body = (await response.json()) as { syncWarning: string | null; status: string };

        // A swallowed warning is indistinguishable from success, and the one it would
        // swallow on close says somebody can still read a channel everyone thinks shut.
        expect(response.status).toBe(200);
        expect(body.syncWarning).toContain('still be able to read');
        expect(body.status).toBe('closed');
    });

    it('reports syncWarning as null on a clean transition', async () => {
        const body = (await (await send('/tickets/7/close', 'POST')).json()) as { syncWarning: string | null };

        expect(body.syncWarning).toBeNull();
    });
});

describe('PUT /:guildId/config/tickets', () => {
    it('rejects an empty moderation-role list, in the product voice', async () => {
        const response = await send('/config/tickets', 'PUT', {
            supportTicketCategoryName: 'Tickets',
            claimedTicketCategoryName: 'Claimed',
            closedTicketCategoryName: 'Closed',
            moderationRoles: [],
        });

        expect(response.status).toBe(400);
        // Saving none quietly narrows who can work a ticket to whoever holds
        // server-level permissions.
        expect(((await response.json()) as ErrorBody).error).toContain('at least one moderation role');
        expect(ticketingRepoMock.mutateConfig).not.toHaveBeenCalled();
    });

    it('rejects a role id the guild does not have', async () => {
        const response = await send('/config/tickets', 'PUT', {
            supportTicketCategoryName: 'Tickets',
            claimedTicketCategoryName: 'Claimed',
            closedTicketCategoryName: 'Closed',
            moderationRoles: ['999999999999999999'],
        });

        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorBody).error).toContain('999999999999999999');
        expect(ticketingRepoMock.mutateConfig).not.toHaveBeenCalled();
    });

    it('rejects a blank category name', async () => {
        const response = await send('/config/tickets', 'PUT', {
            supportTicketCategoryName: '   ',
            claimedTicketCategoryName: 'Claimed',
            closedTicketCategoryName: 'Closed',
            moderationRoles: [MOD_ROLE],
        });

        expect(response.status).toBe(400);
    });

    it('preserves the declared types through a category save', async () => {
        const response = await send('/config/tickets', 'PUT', {
            supportTicketCategoryName: 'Renamed',
            claimedTicketCategoryName: 'Claimed',
            closedTicketCategoryName: 'Closed',
            moderationRoles: [MOD_ROLE],
        });
        const body = (await response.json()) as { types: { type: string }[]; supportTicketCategoryName: string };

        // The config modal was a literal with no spread and silently dropped every
        // member it did not name. This route spreads, and this is the test that says so.
        expect(response.status).toBe(200);
        expect(body.supportTicketCategoryName).toBe('Renamed');
        expect(body.types.map((type) => type.type)).toEqual(['support']);
    });

    it('409s a guild with no config row rather than inventing one', async () => {
        ticketingRepoMock.mutateConfig.mockResolvedValue(null);

        const response = await send('/config/tickets', 'PUT', {
            supportTicketCategoryName: 'Tickets',
            claimedTicketCategoryName: 'Claimed',
            closedTicketCategoryName: 'Closed',
            moderationRoles: [MOD_ROLE],
        });

        expect(response.status).toBe(409);
    });
});

describe('PUT /:guildId/config/tickets/types/:type', () => {
    it('rejects a nameTemplate with an unimplemented token, naming it', async () => {
        // Forwarded from the shared authority, so the sentence an operator reads is the
        // same one the Discord surface would give them.
        upsertTicketType.mockResolvedValue({
            ok: false,
            reason: 'invalid-input',
            message: '`{{user}}` is not a token this bot knows how to render.',
        });

        const response = await send('/config/tickets/types/appeals', 'PUT', {
            ...validTypeBody,
            nameTemplate: 'A{{####}}-{{user}}',
        });

        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorBody).error).toContain('{{user}}');
    });

    it('takes the type key from the path, not the body', async () => {
        upsertTicketType.mockResolvedValue({ ok: true, config: storedConfig() });

        await send('/config/tickets/types/appeals', 'PUT', { ...validTypeBody, type: 'smuggled' });

        expect(upsertTicketType).toHaveBeenCalledWith(
            GUILD_ID,
            expect.objectContaining({ type: 'appeals' })
        );
    });

    it('rejects a body missing the permission model', async () => {
        const response = await send('/config/tickets/types/appeals', 'PUT', {
            label: 'Appeals',
            nameTemplate: 'A{{####}}',
            autoClaimOnOpen: false,
        });

        expect(response.status).toBe(400);
        expect(upsertTicketType).not.toHaveBeenCalled();
    });

    it('returns the whole config view so the editor re-reads every type', async () => {
        upsertTicketType.mockResolvedValue({
            ok: true,
            config: storedConfig({
                ticketTypes: { support: supportDefinition, appeals: { ...supportDefinition, type: 'appeals', label: 'Appeals' } },
            }),
        });

        const body = (await (await send('/config/tickets/types/appeals', 'PUT', validTypeBody)).json()) as {
            types: { type: string }[];
        };

        expect(body.types.map((type) => type.type).sort()).toEqual(['appeals', 'support']);
    });
});

describe('DELETE /:guildId/config/tickets/types/:type', () => {
    it('returns 409 naming the blocking counts when tickets hold the type', async () => {
        deleteTicketType.mockResolvedValue({
            ok: false,
            reason: 'type-in-use',
            message: 'Deleting **Support** (`support`) would orphan tickets that are still on the books: 3 open. For instance #0042.',
        });

        const response = await send('/config/tickets/types/support', 'DELETE');

        // The route forwards the refusal rather than swallowing it. Step A proved the
        // logic refuses; this proves the HTTP surface says so, which is a different
        // claim — a route reporting 204 over a refusal is a shape this repo has shipped.
        expect(response.status).toBe(409);
        const error = ((await response.json()) as ErrorBody).error;
        expect(error).toContain('3 open');
        expect(error).toContain('#0042');
    });

    it('returns 204 for an unused type', async () => {
        deleteTicketType.mockResolvedValue({ ok: true, config: storedConfig({ ticketTypes: {} }) });

        const response = await send('/config/tickets/types/appeals', 'DELETE');

        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
    });

    it('404s a type this guild has not declared', async () => {
        deleteTicketType.mockResolvedValue({
            ok: false,
            reason: 'undeclared-type',
            message: 'This server does not declare a ticket type called `ghost`.',
        });

        expect((await send('/config/tickets/types/ghost', 'DELETE')).status).toBe(404);
    });
});

describe('GET /:guildId/config/tickets', () => {
    it('resolves moderation role names for display', async () => {
        const body = (await (await get('/config/tickets')).json()) as {
            moderationRoles: { id: string; name: string }[];
            moderationRoleIds: string[];
        };

        expect(body.moderationRoles).toEqual([{ id: MOD_ROLE, name: 'Mods' }]);
        expect(body.moderationRoleIds).toEqual([MOD_ROLE]);
    });

    it('still reports a saved role that has since been deleted', async () => {
        // The id stays in `moderationRoleIds` with no matching name. A read must not
        // silently rewrite what was saved — the operator has to be able to see it.
        ticketingRepoMock.get.mockResolvedValue({
            id: 1,
            guildId: GUILD_ID,
            config: storedConfig({ moderationRoles: [MOD_ROLE, '999999999999999999'] }),
            ticketNumberInc: 1,
            entityVersion: 1,
        });

        const body = (await (await get('/config/tickets')).json()) as {
            moderationRoles: { id: string }[];
            moderationRoleIds: string[];
        };

        expect(body.moderationRoleIds).toHaveLength(2);
        expect(body.moderationRoles).toHaveLength(1);
    });

    it('reports an unconfigured guild as empty rather than 404ing the operator who came to set it up', async () => {
        ticketingRepoMock.get.mockResolvedValue(null);

        const response = await get('/config/tickets');
        const body = (await response.json()) as { configured: boolean; types: unknown[] };

        expect(response.status).toBe(200);
        expect(body.configured).toBe(false);
        expect(body.types).toEqual([]);
    });
});
