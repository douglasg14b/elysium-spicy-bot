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

describe('voiceSessionCoordinator', () => {
    it('persists a join and fans occupancy out to the other member', async () => {
        const repo = new InMemoryVoiceSessionRepo();
        const ended: EndedVoiceSession[] = [];
        const now = new Date('2026-08-17T12:00:00.000Z');
        const coordinator = createVoiceSessionCoordinator({
            voiceSessionRepo: repo,
            onSessionEnd: async (session) => {
                ended.push(session);
            },
            now: () => now,
        });

        await coordinator.applyEvents([
            {
                type: 'MemberJoined',
                guildId: 'guild-1',
                userId: 'user-a',
                channelId: 'vc-1',
                occupancy: 1,
            },
        ]);
        expect((await repo.get('guild-1', 'user-a'))?.eligibleSince).toBeNull();

        await coordinator.applyEvents([
            {
                type: 'MemberJoined',
                guildId: 'guild-1',
                userId: 'user-b',
                channelId: 'vc-1',
                occupancy: 2,
            },
            { type: 'OccupancyIncreased', guildId: 'guild-1', channelId: 'vc-1' },
        ]);

        expect((await repo.get('guild-1', 'user-a'))?.eligibleSince).toEqual(now);
        expect((await repo.get('guild-1', 'user-b'))?.eligibleSince).toEqual(now);
        expect(ended).toEqual([]);
    });

    it('ends the leaver and pauses remaining occupancy', async () => {
        const repo = new InMemoryVoiceSessionRepo();
        const ended: EndedVoiceSession[] = [];
        const startedAt = new Date('2026-08-17T11:50:00.000Z');
        const now = new Date('2026-08-17T12:00:00.000Z');
        await repo.upsert({
            guildId: 'guild-1',
            userId: 'user-a',
            channelId: 'vc-1',
            sessionStartedAt: startedAt,
            eligibleAccumulatorMs: 0,
            eligibleSince: startedAt,
        });
        await repo.upsert({
            guildId: 'guild-1',
            userId: 'user-b',
            channelId: 'vc-1',
            sessionStartedAt: startedAt,
            eligibleAccumulatorMs: 0,
            eligibleSince: startedAt,
        });

        const coordinator = createVoiceSessionCoordinator({
            voiceSessionRepo: repo,
            onSessionEnd: async (session) => {
                ended.push(session);
            },
            now: () => now,
        });

        await coordinator.applyEvents([
            { type: 'MemberLeft', guildId: 'guild-1', userId: 'user-b' },
            { type: 'OccupancyDecreased', guildId: 'guild-1', channelId: 'vc-1' },
        ]);

        expect(await repo.get('guild-1', 'user-b')).toBeNull();
        expect((await repo.get('guild-1', 'user-a'))?.eligibleSince).toBeNull();
        expect(ended).toHaveLength(1);
        expect(ended[0]?.userId).toBe('user-b');
        expect(ended[0]?.eligibleMs).toBe(10 * 60_000);
    });
});
