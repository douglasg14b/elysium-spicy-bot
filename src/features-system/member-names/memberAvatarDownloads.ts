import { CDN } from 'discord.js';
import { MIB } from '../../shared/byteSizes';
import { detectImageType } from '../guild-uploads';
import { memberAvatarsRepo, type MemberAvatarsRepo } from './data/memberAvatarsRepo';

/** An account's avatar as one sighting reported it; `avatarHash` null when they have none set. */
export interface AvatarSighting {
    readonly userId: string;
    readonly avatarHash: string | null;
}

/** Fetches a picture's bytes from its address. Throws on anything but a picture's bytes in full. */
export type FetchAvatar = (url: string) => Promise<Uint8Array>;

/** What the queue reads and writes: the stored hashes, a downloaded picture, and a removal. */
export type MemberAvatarStore = Pick<MemberAvatarsRepo, 'storedHashes' | 'store' | 'remove'>;

/** What {@link createMemberAvatarDownloads} is built from; tests pass stand-ins for the network and the store. */
export interface MemberAvatarDownloadsOptions {
    readonly fetchAvatar: FetchAvatar;
    readonly store: MemberAvatarStore;
    /** Downloads at once, across the whole bot. */
    readonly concurrency: number;
}

/** The background queue keeping `member_avatars` in step with the avatars the bot sees. */
export interface MemberAvatarDownloads {
    /**
     * Bring each account's held picture in line with what a sighting reported: download one
     * that is not the picture held, and drop the picture held for an account seen with no
     * avatar set. The name write that saw them has already happened, and nothing waits on
     * this. Sightings are taken in the order they are noted: a later note wins over an
     * earlier one for the same account, however their reads of the store interleave.
     */
    note(sightings: readonly AvatarSighting[]): void;
    /** Resolves once every note and download queued so far has finished. For tests. */
    whenIdle(): Promise<void>;
}

/** How many avatars download at once across the bot: a few, so a first sweep never floods Discord's CDN. */
const DOWNLOAD_CONCURRENCY = 4;

/** How long one download may take before it is given up as failed. */
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * The most one avatar may be. A 128 px picture is a few KiB; anything near this is not the
 * picture asked for, and is not kept.
 */
export const MEMBER_AVATAR_MAX_BYTES = MIB;

const cdn = new CDN();

/**
 * Where an account's avatar is downloaded from: 128 px, a still PNG — the address leveling's
 * `cardAvatarUrlFromUser(user, 128)` gives the leaderboard for anyone with an avatar set, so
 * an animated one is kept as its still frame.
 */
export function memberAvatarSourceUrl(userId: string, avatarHash: string): string {
    return cdn.avatar(userId, avatarHash, { extension: 'png', forceStatic: true, size: 128 });
}

/**
 * The picture at `url`, through the global `fetch`, given up after {@link DOWNLOAD_TIMEOUT_MS}.
 * One that declares itself over {@link MEMBER_AVATAR_MAX_BYTES} is refused unread.
 */
export async function fetchAvatarBytes(url: string): Promise<Uint8Array> {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`Discord's CDN answered ${response.status}.`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (declared > MEMBER_AVATAR_MAX_BYTES) {
        await response.body?.cancel();
        throw new Error(`Discord's CDN declared ${declared} bytes, over the ${MEMBER_AVATAR_MAX_BYTES}-byte cap.`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The background queue every avatar download goes through: one process-wide queue, a few
 * at a time, one per account at a time.
 *
 * Each account's pending work is the picture it should hold — a hash to download, or null to
 * drop what is held — and only the newest asked for is kept. Work already queued or under way
 * for that same picture is not queued again, and a sighting matching what is held queues
 * nothing, so the first sweep downloads everyone once and later ones only the changed. The
 * stored hashes are read here, outside any guild's write queue and any transaction — SQLite
 * has one connection.
 *
 * A failed download is logged and dropped. Nothing retries it: the next sighting of the
 * account finds the picture still not held and queues it again.
 */
export function createMemberAvatarDownloads(options: MemberAvatarDownloadsOptions): MemberAvatarDownloads {
    /** Accounts waiting, and the picture each should end up holding (null: none), oldest first. */
    const waiting = new Map<string, string | null>();
    /** Accounts being worked on now, and the picture each is being brought to. */
    const working = new Map<string, string | null>();
    /**
     * The newest picture noted for each account whose note is still reading the store. A note
     * whose read finishes after a later note was made for the same account yields to it.
     */
    const newestNoted = new Map<string, string | null>();
    /** Every note and job not yet finished, for {@link MemberAvatarDownloads.whenIdle}. */
    const unfinished = new Set<Promise<void>>();

    function track(work: Promise<void>): void {
        unfinished.add(work);
        void work.finally(() => unfinished.delete(work));
    }

    function queued(userId: string, avatarHash: string | null): boolean {
        return (
            (waiting.has(userId) && waiting.get(userId) === avatarHash) ||
            (working.has(userId) && working.get(userId) === avatarHash)
        );
    }

    function pump(): void {
        for (const [userId, avatarHash] of waiting) {
            if (working.size >= options.concurrency) return;
            if (working.has(userId)) continue;
            waiting.delete(userId);
            working.set(userId, avatarHash);
            track(bringUpToDate(userId, avatarHash));
        }
    }

    async function bringUpToDate(userId: string, avatarHash: string | null): Promise<void> {
        try {
            if (avatarHash === null) {
                await options.store.remove(userId);
                return;
            }
            const bytes = await options.fetchAvatar(memberAvatarSourceUrl(userId, avatarHash));
            // Again on what arrived: a response need not declare its length, or tell the truth.
            if (bytes.byteLength > MEMBER_AVATAR_MAX_BYTES) {
                throw new Error(`${bytes.byteLength} bytes came back, over the ${MEMBER_AVATAR_MAX_BYTES}-byte cap.`);
            }
            const contentType = detectImageType(bytes);
            if (!contentType) {
                throw new Error('What came back is not a PNG, JPEG, GIF or WebP picture.');
            }
            await options.store.store({ userId, avatarHash, contentType, bytes: Buffer.from(bytes) }, new Date());
        } catch (error) {
            const what = avatarHash === null ? 'Dropping the removed avatar' : 'Downloading the avatar';
            console.warn(
                `[member-names] ${what} of ${userId} failed (${reasonOf(error)}); it is tried again the next time they are seen.`
            );
        } finally {
            working.delete(userId);
            pump();
        }
    }

    async function noteNow(latest: ReadonlyMap<string, string | null>): Promise<void> {
        const unqueued: [string, string | null][] = [];
        for (const [userId, avatarHash] of latest) {
            if (queued(userId, avatarHash)) {
                // Already on its way: an older note still reading for this account yields to it.
                newestNoted.delete(userId);
            } else {
                newestNoted.set(userId, avatarHash);
                unqueued.push([userId, avatarHash]);
            }
        }
        if (unqueued.length === 0) return;

        try {
            const held = await options.store.storedHashes(unqueued.map(([userId]) => userId));
            for (const [userId, avatarHash] of unqueued) {
                // A later note for this account is newer than this one, whichever read finished first.
                if (!newestNoted.has(userId) || newestNoted.get(userId) !== avatarHash) continue;
                newestNoted.delete(userId);
                // Asked again after the read: another note may have queued the same picture meanwhile.
                if ((held.get(userId) ?? null) !== avatarHash && !queued(userId, avatarHash)) {
                    waiting.set(userId, avatarHash);
                }
            }
        } finally {
            // A failed read leaves nothing behind to hold back a later note.
            for (const [userId, avatarHash] of unqueued) {
                if (newestNoted.has(userId) && newestNoted.get(userId) === avatarHash) newestNoted.delete(userId);
            }
        }
        pump();
    }

    return {
        note(sightings) {
            const latest = new Map<string, string | null>();
            for (const sighting of sightings) latest.set(sighting.userId, sighting.avatarHash || null);
            track(
                noteNow(latest).catch((error: unknown) => {
                    console.error('[member-names] Could not read which avatars are held; nothing was queued:', error);
                })
            );
        },
        async whenIdle() {
            while (unfinished.size > 0) {
                await Promise.allSettled([...unfinished]);
            }
        },
    };
}

/** The bot's one avatar download queue. */
export const memberAvatarDownloads = createMemberAvatarDownloads({
    fetchAvatar: fetchAvatarBytes,
    store: memberAvatarsRepo,
    concurrency: DOWNLOAD_CONCURRENCY,
});
