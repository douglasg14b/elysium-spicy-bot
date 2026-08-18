import { VOICE_ELIGIBLE_OCCUPANCY_THRESHOLD } from '../constants';
import type { VoiceSessionRow } from '../data/levelingVoiceSessionRepo';

export type VoiceSessionState = VoiceSessionRow | null;

export type VoiceSessionEvent =
    | { type: 'MemberJoined'; guildId: string; userId: string; channelId: string; occupancy: number }
    | { type: 'MemberLeft'; guildId: string; userId: string }
    | { type: 'OccupancyIncreased'; guildId: string; channelId: string }
    | { type: 'OccupancyDecreased'; guildId: string; channelId: string }
    | { type: 'ReconcileResume'; guildId: string; userId: string; channelId: string; occupancy: number };

export type VoiceSessionEffect =
    | { type: 'PersistSession'; session: VoiceSessionRow }
    | {
          type: 'EndSession';
          session: VoiceSessionRow;
          eligibleMs: number;
          endedAt: Date;
      };

export type VoiceSessionTransition = {
    nextState: VoiceSessionState;
    effects: VoiceSessionEffect[];
};

export type LiveVoicePresence = {
    userId: string;
    channelId: string;
};

export function isEligibleOccupancy(occupancy: number): boolean {
    return occupancy >= VOICE_ELIGIBLE_OCCUPANCY_THRESHOLD;
}

export function closeEligibleSegment(session: VoiceSessionRow, now: Date): VoiceSessionRow {
    if (!session.eligibleSince) {
        return { ...session, eligibleSince: null };
    }

    const elapsedMs = Math.max(0, now.getTime() - session.eligibleSince.getTime());
    return {
        ...session,
        eligibleAccumulatorMs: session.eligibleAccumulatorMs + elapsedMs,
        eligibleSince: null,
    };
}

export function deriveConnectedState(session: VoiceSessionRow): 'ConnectedAlone' | 'ConnectedEligible' {
    return session.eligibleSince ? 'ConnectedEligible' : 'ConnectedAlone';
}

export function transition(
    state: VoiceSessionState,
    event: VoiceSessionEvent,
    now: Date
): VoiceSessionTransition {
    switch (event.type) {
        case 'MemberJoined':
            return transitionMemberJoined(state, event, now);
        case 'MemberLeft':
            return transitionMemberLeft(state, now);
        case 'OccupancyIncreased':
            return transitionOccupancyIncreased(state, event, now);
        case 'OccupancyDecreased':
            return transitionOccupancyDecreased(state, event, now);
        case 'ReconcileResume':
            return transitionReconcileResume(state, event, now);
    }
}

export function planGuildReconciliation(input: {
    guildId: string;
    sessions: ReadonlyArray<VoiceSessionRow>;
    liveMembers: ReadonlyArray<LiveVoicePresence>;
    occupancyByChannel: ReadonlyMap<string, number>;
    allowStartSessions: boolean;
}): VoiceSessionEvent[] {
    const liveByUser = new Map(input.liveMembers.map((member) => [member.userId, member]));
    const events: VoiceSessionEvent[] = [];
    const matchedUserIds = new Set<string>();

    for (const session of input.sessions) {
        const live = liveByUser.get(session.userId);
        if (!live || !input.allowStartSessions) {
            events.push({ type: 'MemberLeft', guildId: session.guildId, userId: session.userId });
            if (live) {
                matchedUserIds.add(session.userId);
            }
            continue;
        }

        matchedUserIds.add(session.userId);

        if (live.channelId !== session.channelId) {
            events.push({ type: 'MemberLeft', guildId: session.guildId, userId: session.userId });
            events.push({
                type: 'MemberJoined',
                guildId: session.guildId,
                userId: session.userId,
                channelId: live.channelId,
                occupancy: input.occupancyByChannel.get(live.channelId) ?? 1,
            });
            continue;
        }

        events.push({
            type: 'ReconcileResume',
            guildId: session.guildId,
            userId: session.userId,
            channelId: session.channelId,
            occupancy: input.occupancyByChannel.get(session.channelId) ?? 1,
        });
    }

    if (!input.allowStartSessions) {
        return events;
    }

    for (const liveMember of input.liveMembers) {
        if (matchedUserIds.has(liveMember.userId)) {
            continue;
        }

        events.push({
            type: 'MemberJoined',
            guildId: input.guildId,
            userId: liveMember.userId,
            channelId: liveMember.channelId,
            occupancy: input.occupancyByChannel.get(liveMember.channelId) ?? 1,
        });
    }

    return events;
}

function transitionMemberJoined(
    state: VoiceSessionState,
    event: Extract<VoiceSessionEvent, { type: 'MemberJoined' }>,
    now: Date
): VoiceSessionTransition {
    const newSession = createSession(event, now);
    if (!state) {
        return persist(newSession);
    }

    if (state.channelId === event.channelId) {
        return transitionReconcileResume(
            state,
            {
                type: 'ReconcileResume',
                guildId: event.guildId,
                userId: event.userId,
                channelId: event.channelId,
                occupancy: event.occupancy,
            },
            now
        );
    }

    const ended = closeEligibleSegment(state, now);
    return {
        nextState: newSession,
        effects: [
            { type: 'EndSession', session: ended, eligibleMs: ended.eligibleAccumulatorMs, endedAt: now },
            { type: 'PersistSession', session: newSession },
        ],
    };
}

function transitionMemberLeft(state: VoiceSessionState, now: Date): VoiceSessionTransition {
    if (!state) {
        return { nextState: null, effects: [] };
    }

    const ended = closeEligibleSegment(state, now);
    return {
        nextState: null,
        effects: [{ type: 'EndSession', session: ended, eligibleMs: ended.eligibleAccumulatorMs, endedAt: now }],
    };
}

function transitionOccupancyIncreased(
    state: VoiceSessionState,
    event: Extract<VoiceSessionEvent, { type: 'OccupancyIncreased' }>,
    now: Date
): VoiceSessionTransition {
    if (!state || state.channelId !== event.channelId || state.eligibleSince) {
        return { nextState: state, effects: [] };
    }

    const nextState = { ...state, eligibleSince: now };
    return persist(nextState);
}

function transitionOccupancyDecreased(
    state: VoiceSessionState,
    event: Extract<VoiceSessionEvent, { type: 'OccupancyDecreased' }>,
    now: Date
): VoiceSessionTransition {
    if (!state || state.channelId !== event.channelId || !state.eligibleSince) {
        return { nextState: state, effects: [] };
    }

    return persist(closeEligibleSegment(state, now));
}

function transitionReconcileResume(
    state: VoiceSessionState,
    event: Extract<VoiceSessionEvent, { type: 'ReconcileResume' }>,
    now: Date
): VoiceSessionTransition {
    if (!state) {
        return transitionMemberJoined(
            null,
            {
                type: 'MemberJoined',
                guildId: event.guildId,
                userId: event.userId,
                channelId: event.channelId,
                occupancy: event.occupancy,
            },
            now
        );
    }

    const shouldBeEligible = isEligibleOccupancy(event.occupancy);
    if (shouldBeEligible && !state.eligibleSince) {
        return persist({ ...state, eligibleSince: now });
    }

    if (!shouldBeEligible && state.eligibleSince) {
        return persist(closeEligibleSegment(state, now));
    }

    return { nextState: state, effects: [] };
}

function createSession(
    event: Extract<VoiceSessionEvent, { type: 'MemberJoined' }>,
    now: Date
): VoiceSessionRow {
    return {
        guildId: event.guildId,
        userId: event.userId,
        channelId: event.channelId,
        sessionStartedAt: now,
        eligibleAccumulatorMs: 0,
        eligibleSince: isEligibleOccupancy(event.occupancy) ? now : null,
    };
}

function persist(session: VoiceSessionRow): VoiceSessionTransition {
    return {
        nextState: session,
        effects: [{ type: 'PersistSession', session }],
    };
}
