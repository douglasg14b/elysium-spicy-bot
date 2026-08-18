import { describe, expect, it } from 'vitest';
import type { VoiceSessionRow } from '../data/levelingVoiceSessionRepo';
import {
    closeEligibleSegment,
    deriveConnectedState,
    isEligibleOccupancy,
    planGuildReconciliation,
    transition,
    type VoiceSessionEvent,
} from '../logic/voiceSessionStateMachine';

const NOW = new Date('2026-08-17T12:00:00.000Z');
const EARLIER = new Date('2026-08-17T11:50:00.000Z');

function session(overrides: Partial<VoiceSessionRow> = {}): VoiceSessionRow {
    return {
        guildId: 'guild-1',
        userId: 'user-1',
        channelId: 'channel-1',
        sessionStartedAt: EARLIER,
        eligibleAccumulatorMs: 0,
        eligibleSince: null,
        ...overrides,
    };
}

describe('voiceSessionStateMachine', () => {
    it('starts alone when occupancy is 1', () => {
        const result = transition(
            null,
            { type: 'MemberJoined', guildId: 'guild-1', userId: 'user-1', channelId: 'channel-1', occupancy: 1 },
            NOW
        );

        expect(result.nextState?.eligibleSince).toBeNull();
        expect(result.effects).toEqual([{ type: 'PersistSession', session: result.nextState }]);
        expect(deriveConnectedState(result.nextState!)).toBe('ConnectedAlone');
    });

    it('starts eligible when occupancy is 2+', () => {
        const result = transition(
            null,
            { type: 'MemberJoined', guildId: 'guild-1', userId: 'user-1', channelId: 'channel-1', occupancy: 2 },
            NOW
        );

        expect(result.nextState?.eligibleSince).toEqual(NOW);
        expect(deriveConnectedState(result.nextState!)).toBe('ConnectedEligible');
    });

    it('starts the eligible clock on OccupancyIncreased', () => {
        const result = transition(
            session(),
            { type: 'OccupancyIncreased', guildId: 'guild-1', channelId: 'channel-1' },
            NOW
        );

        expect(result.nextState?.eligibleSince).toEqual(NOW);
        expect(result.effects[0]?.type).toBe('PersistSession');
    });

    it('banks eligible time on OccupancyDecreased', () => {
        const result = transition(
            session({ eligibleSince: EARLIER, eligibleAccumulatorMs: 5_000 }),
            { type: 'OccupancyDecreased', guildId: 'guild-1', channelId: 'channel-1' },
            NOW
        );

        expect(result.nextState?.eligibleSince).toBeNull();
        expect(result.nextState?.eligibleAccumulatorMs).toBe(5_000 + 10 * 60_000);
    });

    it('ignores occupancy events for a different channel', () => {
        const existing = session({ eligibleSince: EARLIER });
        const result = transition(
            existing,
            { type: 'OccupancyIncreased', guildId: 'guild-1', channelId: 'channel-other' },
            NOW
        );

        expect(result.effects).toEqual([]);
        expect(result.nextState).toEqual(existing);
    });

    it('ends a session on MemberLeft and includes closed eligible time', () => {
        const result = transition(
            session({ eligibleSince: EARLIER, eligibleAccumulatorMs: 1_000 }),
            { type: 'MemberLeft', guildId: 'guild-1', userId: 'user-1' },
            NOW
        );

        expect(result.nextState).toBeNull();
        expect(result.effects[0]).toMatchObject({
            type: 'EndSession',
            eligibleMs: 1_000 + 10 * 60_000,
            endedAt: NOW,
        });
    });

    it('treats a join while already in another channel as leave then join', () => {
        const result = transition(
            session({ channelId: 'channel-1', eligibleSince: EARLIER }),
            { type: 'MemberJoined', guildId: 'guild-1', userId: 'user-1', channelId: 'channel-2', occupancy: 1 },
            NOW
        );

        expect(result.effects.map((effect) => effect.type)).toEqual(['EndSession', 'PersistSession']);
        expect(result.nextState?.channelId).toBe('channel-2');
        expect(result.nextState?.eligibleSince).toBeNull();
    });

    it('resumes eligibility from live occupancy', () => {
        const alone = transition(
            session({ eligibleSince: null }),
            {
                type: 'ReconcileResume',
                guildId: 'guild-1',
                userId: 'user-1',
                channelId: 'channel-1',
                occupancy: 3,
            },
            NOW
        );
        expect(alone.nextState?.eligibleSince).toEqual(NOW);

        const pause = transition(
            session({ eligibleSince: EARLIER }),
            {
                type: 'ReconcileResume',
                guildId: 'guild-1',
                userId: 'user-1',
                channelId: 'channel-1',
                occupancy: 1,
            },
            NOW
        );
        expect(pause.nextState?.eligibleSince).toBeNull();
        expect(pause.nextState?.eligibleAccumulatorMs).toBe(10 * 60_000);
    });

    it('plans orphan, mismatch, resume, and missing joins', () => {
        const events = planGuildReconciliation({
            guildId: 'guild-1',
            allowStartSessions: true,
            sessions: [
                session({ userId: 'orphan' }),
                session({ userId: 'moved', channelId: 'channel-old' }),
                session({ userId: 'stayed', eligibleSince: EARLIER }),
            ],
            liveMembers: [
                { userId: 'moved', channelId: 'channel-2' },
                { userId: 'stayed', channelId: 'channel-1' },
                { userId: 'new', channelId: 'channel-2' },
            ],
            occupancyByChannel: new Map([
                ['channel-1', 1],
                ['channel-2', 2],
            ]),
        });

        expect(events.map((event: VoiceSessionEvent) => event.type)).toEqual([
            'MemberLeft',
            'MemberLeft',
            'MemberJoined',
            'ReconcileResume',
            'MemberJoined',
        ]);
        expect(events[2]).toMatchObject({ type: 'MemberJoined', userId: 'moved', channelId: 'channel-2', occupancy: 2 });
        expect(events[4]).toMatchObject({ type: 'MemberJoined', userId: 'new', occupancy: 2 });
    });

    it('ends every open session when starting new ones is not allowed', () => {
        const events = planGuildReconciliation({
            guildId: 'guild-1',
            allowStartSessions: false,
            sessions: [session({ userId: 'stayed' })],
            liveMembers: [{ userId: 'stayed', channelId: 'channel-1' }],
            occupancyByChannel: new Map([['channel-1', 2]]),
        });

        expect(events).toEqual([{ type: 'MemberLeft', guildId: 'guild-1', userId: 'stayed' }]);
    });

    it('closes an open eligible segment without mutating the original row', () => {
        const original = session({ eligibleSince: EARLIER, eligibleAccumulatorMs: 100 });
        const closed = closeEligibleSegment(original, NOW);
        expect(original.eligibleSince).toEqual(EARLIER);
        expect(closed.eligibleAccumulatorMs).toBe(100 + 10 * 60_000);
        expect(isEligibleOccupancy(2)).toBe(true);
        expect(isEligibleOccupancy(1)).toBe(false);
    });
});
