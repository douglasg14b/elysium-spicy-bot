import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberAvatarDownload } from '../data/memberAvatarsRepo';
import {
    createMemberAvatarDownloads,
    fetchAvatarBytes,
    MEMBER_AVATAR_MAX_BYTES,
    memberAvatarSourceUrl,
    type FetchAvatar,
    type MemberAvatarStore,
} from '../memberAvatarDownloads';

/**
 * The avatar download queue on its own: what it fetches, when it does not, and what a failure
 * leaves behind. The store and the network are stand-ins; the store's SQL is the repo test's.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A store holding `held` (user id → hash), recording every picture kept. */
function fakeStore(held: Record<string, string> = {}) {
    const hashes = new Map(Object.entries(held));
    const kept: MemberAvatarDownload[] = [];
    const store: MemberAvatarStore = {
        storedHashes: vi.fn(async (userIds: readonly string[]) => {
            return new Map(userIds.flatMap((userId) => {
                const hash = hashes.get(userId);
                return hash ? [[userId, hash] as const] : [];
            }));
        }),
        store: vi.fn(async (download: MemberAvatarDownload) => {
            hashes.set(download.userId, download.avatarHash);
            kept.push(download);
        }),
        remove: vi.fn(async (userId: string) => {
            hashes.delete(userId);
        }),
    };
    return { store, kept, hashes };
}

/** A fetch whose answers are released by hand, to hold downloads in flight. */
function heldFetch() {
    const releases: (() => void)[] = [];
    let inFlight = 0;
    let mostInFlight = 0;
    const fetchAvatar = vi.fn<FetchAvatar>(
        () =>
            new Promise<Uint8Array>((resolve) => {
                inFlight += 1;
                mostInFlight = Math.max(mostInFlight, inFlight);
                releases.push(() => {
                    inFlight -= 1;
                    resolve(PNG);
                });
            })
    );
    return {
        fetchAvatar,
        mostInFlight: () => mostInFlight,
        /** Release every download waiting now, then let the queue start the next ones. */
        async releaseAll() {
            for (const release of releases.splice(0)) release();
            await new Promise((resolve) => setImmediate(resolve));
        },
    };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the avatar download queue', () => {
    it('downloads a picture it does not hold, as a still 128 px PNG, and keeps it as the type its bytes are', async () => {
        const { store, kept } = fakeStore();
        const fetchAvatar = vi.fn<FetchAvatar>(async () => PNG);
        const downloads = createMemberAvatarDownloads({ fetchAvatar, store, concurrency: 4 });

        downloads.note([{ userId: '1', avatarHash: 'a_animated' }]);
        await downloads.whenIdle();

        expect(fetchAvatar).toHaveBeenCalledWith('https://cdn.discordapp.com/avatars/1/a_animated.png?size=128');
        expect(memberAvatarSourceUrl('1', 'a_animated')).toBe('https://cdn.discordapp.com/avatars/1/a_animated.png?size=128');
        expect(kept).toEqual([{ userId: '1', avatarHash: 'a_animated', contentType: 'image/png', bytes: Buffer.from(PNG) }]);
    });

    it('downloads only on a change: nothing for the picture held, or for no avatar set', async () => {
        const { store, kept } = fakeStore({ '1': 'same' });
        const fetchAvatar = vi.fn<FetchAvatar>(async () => PNG);
        const downloads = createMemberAvatarDownloads({ fetchAvatar, store, concurrency: 4 });

        downloads.note([
            { userId: '1', avatarHash: 'same' },
            { userId: '2', avatarHash: null },
        ]);
        await downloads.whenIdle();
        expect(fetchAvatar).not.toHaveBeenCalled();

        downloads.note([{ userId: '1', avatarHash: 'changed' }]);
        await downloads.whenIdle();
        expect(fetchAvatar).toHaveBeenCalledTimes(1);
        expect(kept.map((download) => download.avatarHash)).toEqual(['changed']);
    });

    it('drops the picture held for an account seen with no avatar set, and touches nothing when none is held', async () => {
        const { store, hashes } = fakeStore({ '1': 'oldface' });
        const fetchAvatar = vi.fn<FetchAvatar>(async () => PNG);
        const downloads = createMemberAvatarDownloads({ fetchAvatar, store, concurrency: 4 });

        downloads.note([
            { userId: '1', avatarHash: null },
            { userId: '2', avatarHash: null },
        ]);
        await downloads.whenIdle();

        expect(hashes.has('1')).toBe(false);
        expect(store.remove).toHaveBeenCalledTimes(1);
        expect(store.remove).toHaveBeenCalledWith('1');
        expect(fetchAvatar).not.toHaveBeenCalled();
    });

    it('takes the later of two notes for one account, however their reads of the store interleave', async () => {
        const { store, kept } = fakeStore();
        // The first read — the earlier note's, a sweep's say — is the slow one.
        let releaseSlowRead: () => void = () => undefined;
        const slowRead = new Promise<void>((resolve) => (releaseSlowRead = resolve));
        const read = store.storedHashes;
        let reads = 0;
        store.storedHashes = vi.fn(async (userIds: readonly string[]) => {
            reads += 1;
            if (reads === 1) await slowRead;
            return read(userIds);
        });
        const fetchAvatar = vi.fn<FetchAvatar>(async () => PNG);
        const downloads = createMemberAvatarDownloads({ fetchAvatar, store, concurrency: 4 });

        downloads.note([{ userId: '1', avatarHash: 'old' }]);
        downloads.note([{ userId: '1', avatarHash: 'new' }]);
        await vi.waitFor(() => expect(kept.map((download) => download.avatarHash)).toEqual(['new']));
        releaseSlowRead();
        await downloads.whenIdle();

        expect(kept.map((download) => download.avatarHash)).toEqual(['new']);
    });

    it('logs a failed download once and does not retry it; the next sighting does', async () => {
        const { store, kept } = fakeStore();
        const fetchAvatar = vi.fn<FetchAvatar>().mockRejectedValueOnce(new Error('CDN fell over')).mockResolvedValue(PNG);
        const downloads = createMemberAvatarDownloads({ fetchAvatar, store, concurrency: 4 });

        downloads.note([{ userId: '1', avatarHash: 'face' }]);
        await downloads.whenIdle();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(fetchAvatar).toHaveBeenCalledTimes(1);
        expect(kept).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain('CDN fell over');

        downloads.note([{ userId: '1', avatarHash: 'face' }]);
        await downloads.whenIdle();
        expect(fetchAvatar).toHaveBeenCalledTimes(2);
        expect(kept.map((download) => download.avatarHash)).toEqual(['face']);
    });

    it('keeps nothing over 1 MiB, however it arrived', async () => {
        const { store, kept } = fakeStore();
        const oversized = new Uint8Array(MEMBER_AVATAR_MAX_BYTES + 1);
        oversized.set(PNG);
        const downloads = createMemberAvatarDownloads({ fetchAvatar: async () => oversized, store, concurrency: 4 });

        downloads.note([{ userId: '1', avatarHash: 'huge' }]);
        await downloads.whenIdle();

        expect(kept).toEqual([]);
        expect(String(warn.mock.calls[0]?.[0])).toContain('over the 1048576-byte cap');
    });

    it('refuses a download that declares itself over 1 MiB without reading it', async () => {
        const body = new ReadableStream<Uint8Array>({ pull: () => undefined });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(body, { status: 200, headers: { 'Content-Length': String(MEMBER_AVATAR_MAX_BYTES + 1) } }))
        );
        try {
            await expect(fetchAvatarBytes('https://cdn.discordapp.com/avatars/1/huge.png?size=128')).rejects.toThrow(
                'over the 1048576-byte cap'
            );
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('keeps nothing that is not a picture', async () => {
        const { store, kept } = fakeStore();
        const downloads = createMemberAvatarDownloads({
            fetchAvatar: async () => new TextEncoder().encode('<html>not a picture</html>'),
            store,
            concurrency: 4,
        });

        downloads.note([{ userId: '1', avatarHash: 'face' }]);
        await downloads.whenIdle();

        expect(kept).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('downloads one picture once, however often it is seen while waiting or downloading', async () => {
        const { store, kept } = fakeStore();
        const network = heldFetch();
        const downloads = createMemberAvatarDownloads({ fetchAvatar: network.fetchAvatar, store, concurrency: 4 });

        downloads.note([{ userId: '1', avatarHash: 'face' }]);
        downloads.note([{ userId: '1', avatarHash: 'face' }]);
        await vi.waitFor(() => expect(network.fetchAvatar).toHaveBeenCalledTimes(1));
        downloads.note([{ userId: '1', avatarHash: 'face' }]);
        await network.releaseAll();
        await downloads.whenIdle();

        expect(network.fetchAvatar).toHaveBeenCalledTimes(1);
        expect(kept).toHaveLength(1);
    });

    it('downloads a picture changed mid-download after the first, so the newest is the one kept', async () => {
        const { store, kept } = fakeStore();
        const network = heldFetch();
        const downloads = createMemberAvatarDownloads({ fetchAvatar: network.fetchAvatar, store, concurrency: 4 });

        downloads.note([{ userId: '1', avatarHash: 'old' }]);
        await vi.waitFor(() => expect(network.fetchAvatar).toHaveBeenCalledTimes(1));
        downloads.note([{ userId: '1', avatarHash: 'new' }]);
        await new Promise((resolve) => setImmediate(resolve));
        // One download per account at a time: the new picture waits for the old one.
        expect(network.fetchAvatar).toHaveBeenCalledTimes(1);

        await network.releaseAll();
        await vi.waitFor(() => expect(network.fetchAvatar).toHaveBeenCalledTimes(2));
        await network.releaseAll();
        await downloads.whenIdle();

        expect(kept.map((download) => download.avatarHash)).toEqual(['old', 'new']);
    });

    it('downloads no more than its concurrency at once, and every one in the end', async () => {
        const { store, kept } = fakeStore();
        const network = heldFetch();
        const downloads = createMemberAvatarDownloads({ fetchAvatar: network.fetchAvatar, store, concurrency: 4 });

        downloads.note(Array.from({ length: 10 }, (_unused, index) => ({ userId: String(index), avatarHash: 'face' })));
        await vi.waitFor(() => expect(network.fetchAvatar).toHaveBeenCalledTimes(4));
        while (kept.length < 10) await network.releaseAll();
        await downloads.whenIdle();

        expect(network.mostInFlight()).toBe(4);
        expect(network.fetchAvatar).toHaveBeenCalledTimes(10);
    });
});
