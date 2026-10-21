import { Collection, DiscordAPIError, RESTJSONErrorCodes, type Guild } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearMemberSnapshotCache,
    fetchMemberSnapshotsById,
    MEMBER_LOOKUP_TTL_MS,
} from '../fetchMemberSnapshots';

/**
 * The dashboard's member lookups, which must not turn every page load into a gateway member
 * request: discord.js does not handle that request's rate limit, so a limited one stalls
 * every member fetch on the shard for minutes. Each case counts what reached Discord.
 */

interface FakeMember {
    readonly id: string;
    readonly displayName: string;
    readonly partial: boolean;
    readonly user: { readonly username: string; readonly bot: boolean; displayAvatarURL(): string };
}

function member(id: string, partial = false): FakeMember {
    return {
        id,
        displayName: `Name ${id}`,
        partial,
        user: { username: `user${id}`, bot: false, displayAvatarURL: () => `https://cdn.example/${id}.png` },
    };
}

/**
 * A guild whose gateway cache holds `cached`, and whose `members.fetch` answers with
 * whichever of `inGuild` were asked for — over the gateway for a list, over REST (and
 * Unknown Member for anybody else) for one id, as discord.js routes them. What it finds goes
 * into the cache, as discord.js's does.
 */
function fakeGuild(options: { cached?: FakeMember[]; inGuild?: FakeMember[] } = {}) {
    const inGuild = new Map((options.inGuild ?? []).map((entry) => [entry.id, entry]));
    const cache = new Map((options.cached ?? []).map((entry) => [entry.id, entry]));
    const fetch = vi.fn(async ({ user }: { user: string | string[] }) => {
        if (typeof user === 'string') {
            const found = inGuild.get(user);
            if (!found) {
                throw new DiscordAPIError(
                    { code: RESTJSONErrorCodes.UnknownMember, message: 'Unknown Member' },
                    RESTJSONErrorCodes.UnknownMember,
                    404,
                    'GET',
                    '',
                    {}
                );
            }
            cache.set(found.id, found);
            return found;
        }
        const found = user.flatMap((userId): [string, FakeMember][] => {
            const entry = inGuild.get(userId);
            return entry ? [[userId, entry]] : [];
        });
        for (const [userId, entry] of found) cache.set(userId, entry);
        return new Collection(found);
    });

    const guild = {
        id: 'guild-1',
        members: { cache, fetch },
    } as unknown as Guild;

    return { guild, fetch };
}

beforeEach(() => {
    clearMemberSnapshotCache();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('fetchMemberSnapshotsById', () => {
    it('answers cached members from the cache and fetches only the rest, together', async () => {
        const { guild, fetch } = fakeGuild({ cached: [member('1')], inGuild: [member('2'), member('3')] });

        const found = await fetchMemberSnapshotsById(guild, ['1', '2', '3']);

        expect([...found.keys()].sort()).toEqual(['1', '2', '3']);
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledWith({ user: ['2', '3'] });
    });

    it('does not trust a partial member from the cache', async () => {
        const { guild, fetch } = fakeGuild({ cached: [member('1', true)], inGuild: [member('1')] });

        await fetchMemberSnapshotsById(guild, ['1']);

        expect(fetch).toHaveBeenCalledOnce();
    });

    it('asks Discord nothing on a second call within the TTL, departed members included', async () => {
        const { guild, fetch } = fakeGuild({ inGuild: [member('2')] });

        await fetchMemberSnapshotsById(guild, ['2', 'departed']);
        const again = await fetchMemberSnapshotsById(guild, ['2', 'departed']);

        expect(fetch).toHaveBeenCalledOnce();
        // A departed member still has XP; they are simply absent, not an error.
        expect([...again.keys()]).toEqual(['2']);
    });

    it('asks about a departed member again once the TTL has passed', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
        const { guild, fetch } = fakeGuild({ inGuild: [member('2')] });

        await fetchMemberSnapshotsById(guild, ['2', 'departed']);
        vi.setSystemTime(Date.now() + MEMBER_LOOKUP_TTL_MS);
        await fetchMemberSnapshotsById(guild, ['2', 'departed']);

        expect(fetch).toHaveBeenCalledTimes(2);
        // The member found the first time is answered from the cache; only the absence expired.
        expect(fetch).toHaveBeenLastCalledWith({ user: 'departed' });
    });

    it('shares one request between concurrent calls', async () => {
        const { guild, fetch } = fakeGuild({ inGuild: [member('2'), member('3')] });

        const [first, second] = await Promise.all([
            fetchMemberSnapshotsById(guild, ['2', '3']),
            fetchMemberSnapshotsById(guild, ['2', '3']),
        ]);

        expect(fetch).toHaveBeenCalledOnce();
        expect([...first.keys()].sort()).toEqual(['2', '3']);
        expect([...second.keys()].sort()).toEqual(['2', '3']);
    });

    it('looks one member up over REST, and caches Unknown Member as absent', async () => {
        const { guild, fetch } = fakeGuild();

        const found = await fetchMemberSnapshotsById(guild, ['departed']);
        await fetchMemberSnapshotsById(guild, ['departed']);

        expect(found.size).toBe(0);
        // A string, not a list: discord.js sends a list as a gateway member request.
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledWith({ user: 'departed' });
    });

    it('treats an id that was never a user as absent, not as a fault', async () => {
        const { guild, fetch } = fakeGuild();
        fetch.mockRejectedValueOnce(
            new DiscordAPIError(
                { code: RESTJSONErrorCodes.UnknownUser, message: 'Unknown User' },
                RESTJSONErrorCodes.UnknownUser,
                404,
                'GET',
                '',
                {}
            )
        );

        const found = await fetchMemberSnapshotsById(guild, ['100000000000000009']);
        await fetchMemberSnapshotsById(guild, ['100000000000000009']);

        expect(found.size).toBe(0);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('lets a failed request fail its callers without poisoning the next one', async () => {
        const { guild, fetch } = fakeGuild({ inGuild: [member('2'), member('3')] });
        fetch.mockRejectedValueOnce(new Error('Members did not arrive in time.'));

        await expect(fetchMemberSnapshotsById(guild, ['2', '3'])).rejects.toThrow('Members did not arrive in time.');
        const retried = await fetchMemberSnapshotsById(guild, ['2', '3']);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(retried.size).toBe(2);
    });
});
