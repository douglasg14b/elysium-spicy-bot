import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberNameRow } from '../../../features-system/member-names';
import type { AppEnv } from '../../types';

/**
 * The member-names API contract: which ids reach the lookup, which are refused and how, and
 * the wire shape. `memberNameRoutes()` carries no middleware — auth and guild resolution are
 * applied where it is mounted — so the guild is injected directly.
 *
 * The lookup is mocked: what it stores, looks up and caps is settled against TestDiscord and
 * real SQLite in `resolveMemberNames.integration.test.ts`.
 */

const resolveMemberNames = vi.fn();
const storedHashes = vi.fn();

vi.mock('../../../features-system/member-names', () => ({
    resolveMemberNames,
    MEMBER_NAME_LOOKUP_CAP: 25,
    memberAvatarsRepo: { storedHashes },
}));

const { memberNameRoutes } = await import('../memberNameRoutes');

const GUILD_ID = 'guild-1';
const KITTEN_ID = '400000000000000001';
const GHOST_ID = '400000000000000002';
const guild = { id: GUILD_ID };

function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', guild as never);
        c.set('user', { id: '300000000000000001', username: 'operator', avatar: null, manageableGuildIds: [GUILD_ID] });
        await next();
    });
    outer.route('/', memberNameRoutes());
    return outer;
}

function get(ids: string) {
    return app().request(`/${GUILD_ID}/member-names?ids=${encodeURIComponent(ids)}`);
}

function row(overrides: Partial<MemberNameRow> = {}): MemberNameRow {
    return {
        id: 1,
        guildId: GUILD_ID,
        userId: KITTEN_ID,
        username: 'kittenuser',
        globalName: 'Kitten',
        nickname: 'Brat',
        nicknames: ['Brat', 'Pet'],
        avatarHash: null,
        avatarCheckedAt: new Date('2026-10-02T00:00:00.000Z'),
        isBot: false,
        inServer: true,
        leftAt: null,
        firstSeenAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-02T00:00:00.000Z'),
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    storedHashes.mockResolvedValue(new Map());
});

describe('GET /:guildId/member-names', () => {
    it('answers each row the lookup found, without its bookkeeping, a leave as ISO', async () => {
        resolveMemberNames.mockResolvedValue([
            row(),
            row({ userId: GHOST_ID, inServer: false, leftAt: new Date('2026-10-30T12:00:00.000Z') }),
        ]);

        const response = await get(`${KITTEN_ID},${GHOST_ID}`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            members: [
                {
                    userId: KITTEN_ID,
                    username: 'kittenuser',
                    globalName: 'Kitten',
                    nickname: 'Brat',
                    nicknames: ['Brat', 'Pet'],
                    isBot: false,
                    inServer: true,
                    leftAt: null,
                    avatarUrl: null,
                },
                expect.objectContaining({ userId: GHOST_ID, inServer: false, leftAt: '2026-10-30T12:00:00.000Z' }),
            ],
        });
    });

    it('gives a kept avatar\'s address, versioned by the picture held, only while the row has an avatar set', async () => {
        resolveMemberNames.mockResolvedValue([
            row({ avatarHash: 'newface' }),
            row({ userId: GHOST_ID, avatarHash: null }),
        ]);
        // The picture held is the older one: the newer is still downloading.
        storedHashes.mockResolvedValue(
            new Map([
                [KITTEN_ID, 'oldface'],
                [GHOST_ID, 'removedface'],
            ])
        );

        const body = (await (await get(`${KITTEN_ID},${GHOST_ID}`)).json()) as { members: { avatarUrl: string | null }[] };

        expect(storedHashes).toHaveBeenCalledWith([KITTEN_ID, GHOST_ID]);
        expect(body.members.map((member) => member.avatarUrl)).toEqual([
            `/api/guilds/${GUILD_ID}/member-names/${KITTEN_ID}/avatar?v=oldface`,
            null,
        ]);
    });

    it('asks about each id once, in this guild', async () => {
        resolveMemberNames.mockResolvedValue([]);

        await get(`${KITTEN_ID},${GHOST_ID},${KITTEN_ID}`);

        expect(resolveMemberNames).toHaveBeenCalledWith(guild, [KITTEN_ID, GHOST_ID]);
    });

    it('refuses no ids, a malformed list, and more than 100', async () => {
        const tooMany = Array.from({ length: 101 }, (_unused, index) => `4000000000000${String(index).padStart(5, '0')}`);

        for (const ids of ['', 'nope', `${KITTEN_ID},`, `${KITTEN_ID}, ${GHOST_ID}`, tooMany.join(',')]) {
            const response = await get(ids);
            expect(response.status, ids).toBe(400);
            expect(((await response.json()) as { error: string }).error, ids).toBe(
                'Send 1 to 100 user ids, separated by commas.'
            );
        }
        expect(resolveMemberNames).not.toHaveBeenCalled();
    });

    it('refuses an id past a snowflake\'s 64 bits, naming it', async () => {
        const response = await get(`${KITTEN_ID},99999999999999999999`);

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe('`99999999999999999999` is not a user id.');
        expect(resolveMemberNames).not.toHaveBeenCalled();
    });
});
