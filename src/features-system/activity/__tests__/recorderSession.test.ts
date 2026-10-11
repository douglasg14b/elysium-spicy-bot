import type { Client } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from '../../data-persistence/database';
import { migrateTestDatabase } from '../../data-persistence/__tests__/support/migrateTestDatabase';
import { TestDiscord } from '../../../shared/__tests__/support/testDiscord';
import { isBackfillPending, markBackfillPending, whenBackfillFinished } from '../backfillState';
import { RECORDER_HEARTBEAT_INTERVAL_MS } from '../backfillGaps';
import type { UnfilledRecorderSession } from '../data/activityRecorderSessionsRepo';
import { activityRecorderSessionsRepo } from '../data/activityRecorderSessionsRepo';
import { startRecorderSession, stopRecorderHeartbeat, type RecorderSessionDependencies } from '../recorderSession';

/**
 * A recorder session's lifecycle: opening it, finding the gaps, and — the part the flow
 * scheduler relies on — when the pending flag is up and when it comes down.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A client in no guild, for sessions whose backfill has nothing to ask Discord. */
const NO_GUILDS = { guilds: { cache: new Map() } } as unknown as Client<true>;

const started: TestDiscord[] = [];

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('activity_events').execute();
    await database.deleteFrom('activity_recorder_sessions').execute();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(async () => {
    stopRecorderHeartbeat();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const discord of started.splice(0)) await discord.destroy();
});

/** Session dependencies with every repo call stubbed, overridable per test. */
function stubbedDependencies(
    sessionsRepo: Partial<RecorderSessionDependencies['sessionsRepo']> = {}
): RecorderSessionDependencies {
    return {
        activityEventsRepo: { recordMany: vi.fn().mockResolvedValue(0) },
        sessionsRepo: {
            open: vi.fn().mockResolvedValue(1),
            heartbeat: vi.fn().mockResolvedValue(undefined),
            findUnfilled: vi.fn().mockResolvedValue([]),
            markGapFilled: vi.fn().mockResolvedValue(undefined),
            ...sessionsRepo,
        },
    };
}

describe('startRecorderSession', () => {
    it('marks the very first session filled as it opens, with nothing to backfill', async () => {
        await startRecorderSession(NO_GUILDS);

        const sessions = await database.selectFrom('activity_recorder_sessions').selectAll().execute();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.gapFilledAt).toEqual(sessions[0]?.startedAt);
        expect(isBackfillPending()).toBe(false);
    });

    it('backfills the gap since the last session ran, marks it filled, and lowers the flag', async () => {
        const discord = new TestDiscord();
        started.push(discord);
        const guild = discord.createGuild();
        const member = guild.createMember({ username: 'switch' });
        const channel = guild.createTextChannel({ name: 'playroom' });
        const previous = await activityRecorderSessionsRepo.open(new Date(Date.now() - 3 * HOUR));
        await activityRecorderSessionsRepo.heartbeat(previous, new Date(Date.now() - 2 * HOUR));
        channel.receiveMessage({ from: member, content: 'heard live', sentAt: new Date(Date.now() - 150 * MINUTE) });
        channel.receiveMessage({ from: member, content: 'missed', sentAt: new Date(Date.now() - 90 * MINUTE) });
        const client = await discord.start();

        await startRecorderSession(client);

        const rows = await database.selectFrom('activity_events').select('occurredAt').execute();
        expect(rows).toHaveLength(1);
        expect(await activityRecorderSessionsRepo.findUnfilled()).toEqual([]);
        expect(isBackfillPending()).toBe(false);
    });

    it('holds the flag up until the backfill has finished, not merely started', async () => {
        const gap: UnfilledRecorderSession = {
            id: 2,
            startedAt: new Date(Date.now() - HOUR),
            previousLastSeenAt: new Date(Date.now() - 2 * HOUR),
        };
        // The backfill's last step is marking the gap; pause it there.
        let finishMarking: () => void = () => undefined;
        const markGapFilled = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishMarking = resolve;
                })
        );
        const dependencies = stubbedDependencies({ findUnfilled: vi.fn().mockResolvedValue([gap]), markGapFilled });

        const session = startRecorderSession(NO_GUILDS, dependencies);
        await vi.waitFor(() => expect(markGapFilled).toHaveBeenCalledWith(gap.id, expect.any(Date)));

        expect(isBackfillPending()).toBe(true);
        finishMarking();
        await session;
        expect(isBackfillPending()).toBe(false);
    });

    it('lowers the flag and says so loudly when the gaps cannot be found', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const dependencies = stubbedDependencies({ findUnfilled: vi.fn().mockRejectedValue(new Error('db down')) });

        await startRecorderSession(NO_GUILDS, dependencies);

        expect(isBackfillPending()).toBe(false);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not find the gaps'), expect.anything());
    });

    it('lowers the flag when the session itself cannot be opened', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const dependencies = stubbedDependencies({ open: vi.fn().mockRejectedValue(new Error('db down')) });

        await startRecorderSession(NO_GUILDS, dependencies);

        expect(isBackfillPending()).toBe(false);
        expect(dependencies.sessionsRepo.findUnfilled).not.toHaveBeenCalled();
    });

    it('tells a waiting caller the backfill is over once it has finished, and only once', async () => {
        const finished = vi.fn();
        markBackfillPending();
        whenBackfillFinished(finished);
        expect(finished).not.toHaveBeenCalled();

        await startRecorderSession(NO_GUILDS);
        expect(finished).toHaveBeenCalledOnce();

        // The next session raises and lowers the flag again; the caller was already told.
        await startRecorderSession(NO_GUILDS);
        expect(finished).toHaveBeenCalledOnce();
    });

    it('tells a waiting caller the backfill is over when it failed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const finished = vi.fn();
        markBackfillPending();
        whenBackfillFinished(finished);

        await startRecorderSession(
            NO_GUILDS,
            stubbedDependencies({ findUnfilled: vi.fn().mockRejectedValue(new Error('db down')) })
        );

        expect(finished).toHaveBeenCalledOnce();
    });

    it('tells a caller registering after the backfill is over straight away', async () => {
        await startRecorderSession(NO_GUILDS);
        const finished = vi.fn();

        whenBackfillFinished(finished);

        expect(finished).toHaveBeenCalledOnce();
    });

    it('logs a failed heartbeat and keeps beating', async () => {
        vi.useFakeTimers();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const heartbeat = vi.fn().mockRejectedValueOnce(new Error('db blip')).mockResolvedValue(undefined);
        await startRecorderSession(NO_GUILDS, stubbedDependencies({ open: vi.fn().mockResolvedValue(7), heartbeat }));

        await vi.advanceTimersByTimeAsync(2 * RECORDER_HEARTBEAT_INTERVAL_MS);

        expect(heartbeat).toHaveBeenCalledTimes(2);
        expect(heartbeat).toHaveBeenCalledWith(7, expect.any(Date));
        expect(error).toHaveBeenCalledWith(expect.stringContaining('heartbeat failed'), expect.anything());
    });
});
