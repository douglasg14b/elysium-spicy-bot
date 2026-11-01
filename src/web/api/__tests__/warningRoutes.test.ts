import { Collection } from 'discord.js';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleWarning } from '../../../features/warnings/__tests__/support/sampleWarning';
import type { AppEnv } from '../../types';

/**
 * The warnings API contract.
 *
 * `warningRoutes()` carries no middleware — auth and guild resolution are applied where it
 * is mounted in `api/index.ts` — so these tests inject a guild and a session user directly
 * and test what the route itself decides: validation, which status a refusal gets, who the
 * actor is, and the wire shape.
 *
 * The repo, the write logic and the notices are mocked: what they record and refuse is
 * settled against real SQLite in `warningsRepo.test.ts` and `warningWrites.test.ts`. What is
 * only testable here is whether the route forwards a refusal, and what it forwards it as.
 */

const warningsRepoMock = {
    listByGuild: vi.fn(),
    countsByGuild: vi.fn(),
};
const issueGuildWarning = vi.fn();
const editGuildWarning = vi.fn();
const clearGuildWarning = vi.fn();
const notifyWarningIssued = vi.fn();
const notifyWarningEdited = vi.fn();
const notifyWarningReleased = vi.fn();
const fetchMemberSnapshotsById = vi.fn();
const membersSearch = vi.fn();

// The real cap, re-exported through the mock: a whole-module mock would make it `undefined`.
vi.mock('../../../features/warnings/data/warningsRepo', async () => {
    const actual = await vi.importActual<typeof import('../../../features/warnings/data/warningsRepo')>(
        '../../../features/warnings/data/warningsRepo'
    );
    return { warningsRepo: warningsRepoMock, WARNING_LIST_CAP: actual.WARNING_LIST_CAP };
});
vi.mock('../../../features/warnings/logic/issueGuildWarning', () => ({ issueGuildWarning }));
vi.mock('../../../features/warnings/logic/editGuildWarning', () => ({ editGuildWarning }));
vi.mock('../../../features/warnings/logic/clearGuildWarning', () => ({ clearGuildWarning }));
vi.mock('../../../features/warnings/logic/warningIssuedNotice', () => ({ notifyWarningIssued }));
vi.mock('../../../features/warnings/logic/warningChangeNotices', () => ({ notifyWarningEdited, notifyWarningReleased }));
vi.mock('../../../features/leveling/logic/fetchMemberSnapshots', async () => {
    const actual = await vi.importActual<typeof import('../../../features/leveling/logic/fetchMemberSnapshots')>(
        '../../../features/leveling/logic/fetchMemberSnapshots'
    );
    return { ...actual, fetchMemberSnapshotsById };
});

const { warningRoutes } = await import('../warningRoutes');
const { WARNING_LIST_CAP } = await import('../../../features/warnings/data/warningsRepo');

const GUILD_ID = 'guild-1';
const SESSION_USER_ID = '300000000000000001';
const MEMBER_ID = '400000000000000001';

function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: GUILD_ID, members: { search: membersSearch } } as never);
        c.set('user', { id: SESSION_USER_ID, username: 'operator', avatar: null, manageableGuildIds: [GUILD_ID] });
        await next();
    });
    outer.route('/', warningRoutes());
    return outer;
}

function get(path: string) {
    return app().request(`/${GUILD_ID}${path}`);
}

function send(path: string, method: 'POST' | 'PUT', body: unknown) {
    return app().request(`/${GUILD_ID}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function errorOf(response: Response): Promise<string> {
    return ((await response.json()) as { error: string }).error;
}

interface ListBody {
    warnings: { slug: string; status: string; member: { id: string; name: string | null } }[];
    counts: { active: number; expired: number; released: number };
    truncated: boolean;
}

const validIssue = {
    userId: MEMBER_ID,
    rule: 'Consent',
    description: 'Pushed past a no.',
};

const LOADED_EDIT_AT = '2026-09-01T22:00:00.000Z';
const validUpdate = {
    rule: 'Privacy',
    description: 'Shared a screenshot.',
    dropsOffOn: '2027-06-01',
    baseEditedAt: LOADED_EDIT_AT,
};

beforeEach(() => {
    vi.clearAllMocks();
    warningsRepoMock.listByGuild.mockResolvedValue([sampleWarning()]);
    warningsRepoMock.countsByGuild.mockResolvedValue({ active: 3, expired: 1, released: 9 });
    fetchMemberSnapshotsById.mockResolvedValue(
        new Map([
            [
                MEMBER_ID,
                { userId: MEMBER_ID, displayName: 'Kitten', username: 'kittenuser', isBot: false, avatarUrl: null },
            ],
        ])
    );
    issueGuildWarning.mockResolvedValue({ ok: true, warning: sampleWarning({ userId: MEMBER_ID }) });
    editGuildWarning.mockResolvedValue({
        ok: true,
        warning: sampleWarning({ rule: 'Privacy' }),
        changes: [{ field: 'rule', before: 'Consent', after: 'Privacy' }],
    });
    clearGuildWarning.mockResolvedValue({
        status: 'cleared',
        warning: sampleWarning({
            clearedAt: new Date('2026-09-02T12:00:00.000Z'),
            clearedById: SESSION_USER_ID,
            clearedByName: 'operator',
            clearReason: 'Apologised nicely.',
        }),
    });
    notifyWarningIssued.mockResolvedValue('sent');
    notifyWarningEdited.mockResolvedValue('sent');
    notifyWarningReleased.mockResolvedValue('sent');
});

describe('GET /:guildId/warnings', () => {
    it('returns the warnings as calendar dates with a derived status, and the guild counts', async () => {
        const response = await get('/warnings');
        const body = (await response.json()) as ListBody & { warnings: Record<string, unknown>[] };

        expect(response.status).toBe(200);
        expect(body.counts).toEqual({ active: 3, expired: 1, released: 9 });
        expect(body.truncated).toBe(false);
        expect(body.warnings[0]).toEqual({
            slug: 'consent-k7m2',
            rule: 'Consent',
            description: 'Pushed past a no.',
            member: { id: 'user-1', name: 'Kitten' },
            issuedBy: { id: 'mod-1', name: 'Mistress' },
            issuedOn: '2026-09-01',
            dropsOffOn: '2027-03-01',
            status: expect.stringMatching(/^(active|expired)$/),
            edited: null,
            released: null,
        });
    });

    it('passes the filters through, trimming the search', async () => {
        await get(`/warnings?status=released&userId=${MEMBER_ID}&search=%20kit%20`);

        expect(warningsRepoMock.listByGuild).toHaveBeenCalledWith(GUILD_ID, expect.any(Date), {
            status: 'released',
            userId: MEMBER_ID,
            search: 'kit',
        });
    });

    it('treats blank filters as absent', async () => {
        await get('/warnings?status=&userId=&search=%20');

        expect(warningsRepoMock.listByGuild).toHaveBeenCalledWith(GUILD_ID, expect.any(Date), {
            status: undefined,
            userId: undefined,
            search: undefined,
        });
    });

    it('refuses a status or a user id that is not one, naming it', async () => {
        const badStatus = await get('/warnings?status=banana');
        const badUser = await get('/warnings?userId=nope');

        expect(badStatus.status).toBe(400);
        expect(await errorOf(badStatus)).toBe('`banana` is not a warning status. Try active, expired or released.');
        expect(badUser.status).toBe(400);
        expect(await errorOf(badUser)).toBe('`nope` is not a user id.');
        expect(warningsRepoMock.listByGuild).not.toHaveBeenCalled();
    });

    it('drops the sentinel row and reports truncated', async () => {
        warningsRepoMock.listByGuild.mockResolvedValue(
            Array.from({ length: WARNING_LIST_CAP + 1 }, (_row, index) => sampleWarning({ slug: `w-${index}` }))
        );

        const body = (await (await get('/warnings')).json()) as ListBody;

        expect(body.truncated).toBe(true);
        expect(body.warnings).toHaveLength(WARNING_LIST_CAP);
    });

    it('sends the release and the last edit as who, when and why', async () => {
        warningsRepoMock.listByGuild.mockResolvedValue([
            sampleWarning({
                clearedAt: new Date('2026-09-02T12:00:00.000Z'),
                clearedById: 'mod-2',
                clearedByName: null,
                clearReason: null,
                editedAt: new Date('2026-09-01T22:00:00.000Z'),
                editedById: 'mod-3',
                editedByName: 'Sir',
            }),
        ]);

        const body = (await (await get('/warnings')).json()) as { warnings: Record<string, unknown>[] };

        expect(body.warnings[0]).toEqual(
            expect.objectContaining({
                status: 'released',
                edited: { by: { id: 'mod-3', name: 'Sir' }, at: '2026-09-01T22:00:00.000Z' },
                released: { by: { id: 'mod-2', name: null }, at: '2026-09-02T12:00:00.000Z', reason: null },
            })
        );
    });
});

describe('POST /:guildId/warnings', () => {
    it('warns the fetched member as the session user, and passes the notice status through', async () => {
        notifyWarningIssued.mockResolvedValue('skipped');

        const response = await send('/warnings', 'POST', {
            ...validIssue,
            dropsOffOn: '2027-01-01',
            // Not the actor: the body cannot name who issued it.
            issuerId: '999999999999999999',
        });

        expect(response.status).toBe(201);
        expect(((await response.json()) as { notice: string }).notice).toBe('skipped');
        expect(fetchMemberSnapshotsById).toHaveBeenCalledWith(expect.objectContaining({ id: GUILD_ID }), [MEMBER_ID]);
        expect(issueGuildWarning).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            userId: MEMBER_ID,
            userName: 'Kitten',
            issuerId: SESSION_USER_ID,
            issuerName: 'operator',
            rule: 'Consent',
            description: 'Pushed past a no.',
            issuedInput: '',
            expiresInput: '2027-01-01',
        });
    });

    it('refuses a member who is not in the server, warning nobody', async () => {
        fetchMemberSnapshotsById.mockResolvedValue(new Map());

        const response = await send('/warnings', 'POST', validIssue);

        expect(response.status).toBe(400);
        expect(await errorOf(response)).toBe("They're not in this server. Warnings are for members, not ghosts.");
        expect(issueGuildWarning).not.toHaveBeenCalled();
    });

    it('answers a date refusal with the sentence /warn uses', async () => {
        issueGuildWarning.mockResolvedValue({ ok: false, kind: 'issued-in-future' });

        const response = await send('/warnings', 'POST', { ...validIssue, issuedOn: '2099-01-01' });

        expect(response.status).toBe(400);
        expect(await errorOf(response)).toBe(
            "Issued date can't be in the future. Backdate all you want — just not tomorrow."
        );
        expect(notifyWarningIssued).not.toHaveBeenCalled();
    });

    it('refuses a blank rule and a misshapen date before fetching anybody', async () => {
        const blankRule = await send('/warnings', 'POST', { ...validIssue, rule: '   ' });
        const badDate = await send('/warnings', 'POST', { ...validIssue, dropsOffOn: '1/2/2027' });

        expect(await errorOf(blankRule)).toBe('Rule cannot be empty. Name the line they crossed.');
        expect(await errorOf(badDate)).toBe('Drop-off date has to be YYYY-MM-DD.');
        expect(fetchMemberSnapshotsById).not.toHaveBeenCalled();
    });
});

describe('PUT /:guildId/warnings/:slug', () => {
    it('edits as the session user and posts the edited notice with what changed', async () => {
        notifyWarningEdited.mockResolvedValue('unconfigured');

        const response = await send('/warnings/Consent-K7M2', 'PUT', validUpdate);

        expect(response.status).toBe(200);
        expect(((await response.json()) as { notice: string; rule: string })).toEqual(
            expect.objectContaining({ notice: 'unconfigured', rule: 'Privacy' })
        );
        expect(editGuildWarning).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            slug: 'Consent-K7M2',
            rule: 'Privacy',
            description: 'Shared a screenshot.',
            dropsOffInput: '2027-06-01',
            baseEditedAt: LOADED_EDIT_AT,
            editedBy: { id: SESSION_USER_ID, name: 'operator' },
        });
        expect(notifyWarningEdited).toHaveBeenCalledWith(expect.objectContaining({ id: GUILD_ID }), {
            warning: expect.objectContaining({ rule: 'Privacy' }),
            editedBy: { id: SESSION_USER_ID, name: 'operator' },
            changes: [{ field: 'rule', before: 'Consent', after: 'Privacy' }],
        });
    });

    it.each([
        ['released', 409, "Released warnings are part of the record — they don't get edited."],
        ['stale', 409, 'Somebody else edited this warning while you had it open. Reload it and make your change again.'],
        ['not-found', 404, "No warning with slug `consent-k7m2` in this server. Can't edit a ghost."],
        ['unchanged', 400, 'Nothing changed. Edit something or leave it be.'],
        ['expires-already-passed', 400, 'That drop-off date is already in the past. Pick a future one, or leave it where it was.'],
        ['expires-not-after-issued', 400, 'Drop-off has to be after the issued date, or this warning is already a ghost.'],
    ])('answers a %s refusal with %i, posting nothing', async (kind, status, sentence) => {
        editGuildWarning.mockResolvedValue({ ok: false, kind });

        const response = await send('/warnings/consent-k7m2', 'PUT', validUpdate);

        expect(response.status).toBe(status);
        expect(await errorOf(response)).toBe(sentence);
        expect(notifyWarningEdited).not.toHaveBeenCalled();
    });

    it('wants all three fields', async () => {
        const response = await send('/warnings/consent-k7m2', 'PUT', { rule: 'Privacy', description: 'x' });

        expect(response.status).toBe(400);
        expect(editGuildWarning).not.toHaveBeenCalled();
    });

    it('wants baseEditedAt, as an ISO instant or null', async () => {
        const { baseEditedAt: _omitted, ...withoutBase } = validUpdate;
        const missing = await send('/warnings/consent-k7m2', 'PUT', withoutBase);
        const garbled = await send('/warnings/consent-k7m2', 'PUT', { ...validUpdate, baseEditedAt: 'yesterday' });
        const never = await send('/warnings/consent-k7m2', 'PUT', { ...validUpdate, baseEditedAt: null });

        expect(missing.status).toBe(400);
        expect(garbled.status).toBe(400);
        expect(never.status).toBe(200);
        expect(editGuildWarning).toHaveBeenCalledOnce();
        expect(editGuildWarning).toHaveBeenCalledWith(expect.objectContaining({ baseEditedAt: null }));
    });
});

describe('POST /:guildId/warnings/:slug/release', () => {
    it('releases as the session user with the trimmed reason, and posts the released notice', async () => {
        notifyWarningReleased.mockResolvedValue('failed');

        const response = await send('/warnings/consent-k7m2/release', 'POST', { reason: '  Apologised nicely.  ' });
        const body = (await response.json()) as { notice: string; status: string };

        expect(response.status).toBe(200);
        expect(body).toEqual(expect.objectContaining({ notice: 'failed', status: 'released' }));
        expect(clearGuildWarning).toHaveBeenCalledWith(
            GUILD_ID,
            'consent-k7m2',
            { id: SESSION_USER_ID, name: 'operator' },
            'Apologised nicely.'
        );
        expect(notifyWarningReleased).toHaveBeenCalledWith(
            expect.objectContaining({ id: GUILD_ID }),
            expect.objectContaining({ slug: 'consent-k7m2', clearedById: SESSION_USER_ID, clearReason: 'Apologised nicely.' })
        );
    });

    it("answers a slug this server has no warning by — another server's included — with 404", async () => {
        clearGuildWarning.mockResolvedValue({ status: 'not-found' });

        const response = await send('/warnings/Elsewhere-1234/release', 'POST', { reason: 'Because.' });

        expect(response.status).toBe(404);
        expect(await errorOf(response)).toBe(
            "No warning with slug `elsewhere-1234` in this server. You can't forgive a ghost."
        );
        expect(clearGuildWarning).toHaveBeenCalledWith(GUILD_ID, 'Elsewhere-1234', expect.anything(), 'Because.');
    });

    it('answers an already-released warning with 409, posting nothing', async () => {
        clearGuildWarning.mockResolvedValue({ status: 'already-cleared', warning: sampleWarning() });

        const response = await send('/warnings/consent-k7m2/release', 'POST', { reason: 'Again.' });

        expect(response.status).toBe(409);
        expect(await errorOf(response)).toBe('`consent-k7m2` is already cleared. You already did the soft thing.');
        expect(notifyWarningReleased).not.toHaveBeenCalled();
    });

    it('refuses a blank or overlong reason before releasing anything', async () => {
        const blank = await send('/warnings/consent-k7m2/release', 'POST', { reason: '   ' });
        const long = await send('/warnings/consent-k7m2/release', 'POST', { reason: 'x'.repeat(501) });

        expect(blank.status).toBe(400);
        expect(await errorOf(blank)).toBe("A release needs a reason. Say why they're off the hook.");
        expect(long.status).toBe(400);
        expect(clearGuildWarning).not.toHaveBeenCalled();
    });
});

describe('GET /:guildId/members/search', () => {
    function memberStub(id: string, displayName: string, bot: boolean) {
        return {
            id,
            displayName,
            user: { username: displayName.toLowerCase(), bot, displayAvatarURL: () => `https://cdn/${id}.png` },
        };
    }

    it("asks Discord's name search for ten, and leaves bots out", async () => {
        membersSearch.mockResolvedValue(
            new Collection([
                [MEMBER_ID, memberStub(MEMBER_ID, 'Kitten', false)],
                ['500000000000000001', memberStub('500000000000000001', 'KittenBot', true)],
            ])
        );

        const response = await get('/members/search?q=%20kit%20');

        expect(response.status).toBe(200);
        expect(membersSearch).toHaveBeenCalledWith({ query: 'kit', limit: 10 });
        expect(await response.json()).toEqual([
            { id: MEMBER_ID, displayName: 'Kitten', username: 'kitten', avatarUrl: `https://cdn/${MEMBER_ID}.png` },
        ]);
    });

    it('refuses a blank or overlong search without asking Discord', async () => {
        const blank = await get('/members/search?q=%20');
        const long = await get(`/members/search?q=${'x'.repeat(33)}`);

        expect(blank.status).toBe(400);
        expect(long.status).toBe(400);
        expect(membersSearch).not.toHaveBeenCalled();
    });
});
