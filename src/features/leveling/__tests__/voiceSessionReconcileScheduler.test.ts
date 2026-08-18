import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
    resetVoiceSessionReconcileSchedulerForTests,
    runVoiceSessionReconcileTick,
    startVoiceSessionReconcileScheduler,
    stopVoiceSessionReconcileScheduler,
} from '../logic/voiceSessionReconcileScheduler';

describe('voiceSessionReconcileScheduler', () => {
    beforeEach(() => {
        resetVoiceSessionReconcileSchedulerForTests();
    });

    it('skips a tick when the previous tick is still running', async () => {
        let release!: () => void;
        const reconcileGuild = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                })
        );

        const client = {
            user: { id: 'bot' },
            guilds: { cache: new Map([['guild-1', { id: 'guild-1' }]]) },
        };

        const first = runVoiceSessionReconcileTick(client as never, {
            listEnabledGuildIds: async () => ['guild-1'],
            listGuildIdsWithOpenSessions: async () => [],
            reconcileGuild,
            delay: async () => undefined,
        });

        await vi.waitFor(() => {
            expect(reconcileGuild).toHaveBeenCalledTimes(1);
        });

        await runVoiceSessionReconcileTick(client as never, {
            listEnabledGuildIds: async () => ['guild-1'],
            listGuildIdsWithOpenSessions: async () => [],
            reconcileGuild,
            delay: async () => undefined,
        });

        expect(reconcileGuild).toHaveBeenCalledTimes(1);
        release();
        await first;
    });

    it('unions enabled guilds with open-session guilds and skips missing cache entries', async () => {
        const reconcileGuild = vi.fn().mockResolvedValue(undefined);
        const guildA = { id: 'guild-a' };
        const client = {
            user: { id: 'bot' },
            guilds: {
                cache: new Map([
                    ['guild-a', guildA],
                    ['guild-b', { id: 'guild-b' }],
                ]),
            },
        };

        await runVoiceSessionReconcileTick(client as never, {
            listEnabledGuildIds: async () => ['guild-a', 'missing'],
            listGuildIdsWithOpenSessions: async () => ['guild-b', 'guild-a'],
            reconcileGuild,
            delay: async () => undefined,
        });

        expect(reconcileGuild).toHaveBeenCalledTimes(2);
        expect(reconcileGuild.mock.calls.map((call) => call[0].id).sort()).toEqual(['guild-a', 'guild-b']);
    });

    it('starts only once and can be stopped', () => {
        const client = { user: { id: 'bot' }, guilds: { cache: new Map() } };
        startVoiceSessionReconcileScheduler(client as never, { reconcileGuild: vi.fn() } as never, 60_000);
        startVoiceSessionReconcileScheduler(client as never, { reconcileGuild: vi.fn() } as never, 60_000);
        stopVoiceSessionReconcileScheduler();
        stopVoiceSessionReconcileScheduler();
    });
});
