import { describe, expect, it } from 'vitest';
import type { VoiceSessionRow } from '../data/levelingVoiceSessionRepo';
import { createVoiceSessionCoordinator, type EndedVoiceSession } from '../logic/voiceSessionCoordinator';

class InMemoryVoiceSessionRepo {
    private readonly sessions = new Map<string, VoiceSessionRow>();

    private key(guildId: string, userId: string): string {
        return `${guildId}:${userId}`;
    }

    async get(guildId: string, userId: string): Promise<VoiceSessionRow | null> {
        return this.sessions.get(this.key(guildId, userId)) ?? null;
    }

    async upsert(session: VoiceSessionRow): Promise<void> {
        this.sessions.set(this.key(session.guildId, session.userId), { ...session });
    }

    async delete(guildId: string, userId: string): Promise<void> {
        this.sessions.delete(this.key(guildId, userId));
    }

    async listByGuild(guildId: string): Promise<VoiceSessionRow[]> {
        return [...this.sessions.values()].filter((session) => session.guildId === guildId);
    }

    async listByChannel(guildId: string, channelId: string): Promise<VoiceSessionRow[]> {
        return [...this.sessions.values()].filter(
            (session) => session.guildId === guildId && session.channelId === channelId
        );
    }
}

describe('voiceSessionReconciliation', () => {
    it('finalizes orphans and inserts missing live members', async () => {
        const repo = new InMemoryVoiceSessionRepo();
        const ended: EndedVoiceSession[] = [];
        const startedAt = new Date('2026-08-17T11:00:00.000Z');
        const now = new Date('2026-08-17T12:00:00.000Z');
        await repo.upsert({
            guildId: 'guild-1',
            userId: 'orphan',
            channelId: 'vc-1',
            sessionStartedAt: startedAt,
            eligibleAccumulatorMs: 30_000,
            eligibleSince: startedAt,
        });

        const coordinator = createVoiceSessionCoordinator({
            voiceSessionRepo: repo,
            onSessionEnd: async (session) => {
                ended.push(session);
            },
            now: () => now,
        });

        await coordinator.reconcileGuild(
            { id: 'guild-1' } as never,
            {
                voiceStates: new Map([
                    [
                        'new-user',
                        {
                            id: 'new-user',
                            channelId: 'vc-1',
                            member: { user: { bot: false } },
                        },
                    ],
                ]) as never,
                allowStartSessions: true,
                now,
            }
        );

        expect(ended).toHaveLength(1);
        expect(ended[0]?.userId).toBe('orphan');
        expect(await repo.get('guild-1', 'orphan')).toBeNull();
        expect((await repo.get('guild-1', 'new-user'))?.channelId).toBe('vc-1');
    });

    it('resumes matching rows from live occupancy', async () => {
        const repo = new InMemoryVoiceSessionRepo();
        const now = new Date('2026-08-17T12:00:00.000Z');
        await repo.upsert({
            guildId: 'guild-1',
            userId: 'stayer',
            channelId: 'vc-1',
            sessionStartedAt: new Date('2026-08-17T11:00:00.000Z'),
            eligibleAccumulatorMs: 0,
            eligibleSince: null,
        });

        const coordinator = createVoiceSessionCoordinator({
            voiceSessionRepo: repo,
            onSessionEnd: async () => undefined,
            now: () => now,
        });

        await coordinator.reconcileGuild(
            { id: 'guild-1' } as never,
            {
                voiceStates: new Map([
                    [
                        'stayer',
                        {
                            id: 'stayer',
                            channelId: 'vc-1',
                            member: { user: { bot: false } },
                        },
                    ],
                    [
                        'other',
                        {
                            id: 'other',
                            channelId: 'vc-1',
                            member: { user: { bot: false } },
                        },
                    ],
                ]) as never,
                allowStartSessions: true,
                now,
            }
        );

        expect((await repo.get('guild-1', 'stayer'))?.eligibleSince).toEqual(now);
        expect((await repo.get('guild-1', 'other'))?.eligibleSince).toEqual(now);
    });
});
