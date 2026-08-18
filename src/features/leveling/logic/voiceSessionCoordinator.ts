import type { Collection, Guild, VoiceState } from 'discord.js';
import type { LevelingVoiceSessionRepo } from '../data/levelingVoiceSessionRepo';
import {
    planGuildReconciliation,
    transition,
    type VoiceSessionEffect,
    type VoiceSessionEvent,
} from './voiceSessionStateMachine';
import {
    getVoiceUpdateContext,
    shouldSkipMemberForVoiceXp,
    toMachineEvents,
} from './voiceStateTransitions';

export type EndedVoiceSession = {
    guildId: string;
    userId: string;
    channelId: string;
    eligibleMs: number;
    sessionStartedAt: Date;
    endedAt: Date;
};

export type VoiceSessionCoordinatorDependencies = {
    voiceSessionRepo: Pick<
        LevelingVoiceSessionRepo,
        'get' | 'upsert' | 'delete' | 'listByGuild' | 'listByChannel'
    >;
    onSessionEnd: (ended: EndedVoiceSession) => Promise<void>;
    now?: () => Date;
};

export class VoiceSessionCoordinator {
    private readonly voiceSessionRepo: VoiceSessionCoordinatorDependencies['voiceSessionRepo'];
    private readonly onSessionEnd: VoiceSessionCoordinatorDependencies['onSessionEnd'];
    private readonly now: () => Date;

    constructor(dependencies: VoiceSessionCoordinatorDependencies) {
        this.voiceSessionRepo = dependencies.voiceSessionRepo;
        this.onSessionEnd = dependencies.onSessionEnd;
        this.now = dependencies.now ?? (() => new Date());
    }

    async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
        const member = newState.member ?? oldState.member;
        if (shouldSkipMemberForVoiceXp(member)) {
            return;
        }

        const context = getVoiceUpdateContext(oldState, newState);
        if (!context) {
            return;
        }

        const events = toMachineEvents(context);
        await this.applyEvents(events);
    }

    async reconcileGuild(
        guild: Guild,
        options?: {
            voiceStates?: Collection<string, VoiceState> | ReadonlyMap<string, VoiceState>;
            allowStartSessions?: boolean;
            now?: Date;
        }
    ): Promise<void> {
        const now = options?.now ?? this.now();
        const voiceStates = options?.voiceStates ?? (await fetchLiveVoiceStates(guild));
        const liveMembers = collectLiveNonBotMembers(voiceStates);
        const occupancyByChannel = buildOccupancyByChannel(liveMembers);
        const sessions = await this.voiceSessionRepo.listByGuild(guild.id);
        const events = planGuildReconciliation({
            guildId: guild.id,
            sessions,
            liveMembers,
            occupancyByChannel,
            allowStartSessions: options?.allowStartSessions ?? true,
        });

        await this.applyEvents(events, now);
    }

    async applyEvents(events: ReadonlyArray<VoiceSessionEvent>, now: Date = this.now()): Promise<void> {
        for (const event of events) {
            await this.applyEvent(event, now);
        }
    }

    private async applyEvent(event: VoiceSessionEvent, now: Date): Promise<void> {
        if (event.type === 'OccupancyIncreased' || event.type === 'OccupancyDecreased') {
            const sessions = await this.voiceSessionRepo.listByChannel(event.guildId, event.channelId);
            for (const session of sessions) {
                const result = transition(session, event, now);
                await this.applyEffects(result.effects);
            }
            return;
        }

        const session = await this.voiceSessionRepo.get(event.guildId, event.userId);
        const result = transition(session, event, now);
        await this.applyEffects(result.effects);
    }

    private async applyEffects(effects: ReadonlyArray<VoiceSessionEffect>): Promise<void> {
        for (const effect of effects) {
            if (effect.type === 'PersistSession') {
                await this.voiceSessionRepo.upsert(effect.session);
                continue;
            }

            await this.onSessionEnd({
                guildId: effect.session.guildId,
                userId: effect.session.userId,
                channelId: effect.session.channelId,
                eligibleMs: effect.eligibleMs,
                sessionStartedAt: effect.session.sessionStartedAt,
                endedAt: effect.endedAt,
            });
            await this.voiceSessionRepo.delete(effect.session.guildId, effect.session.userId);
        }
    }
}

export function createVoiceSessionCoordinator(
    dependencies: VoiceSessionCoordinatorDependencies
): VoiceSessionCoordinator {
    return new VoiceSessionCoordinator(dependencies);
}

export async function fetchLiveVoiceStates(guild: Guild): Promise<ReadonlyMap<string, VoiceState>> {
    try {
        const manager = guild.voiceStates as {
            fetch: (user?: unknown) => Promise<unknown>;
            cache: ReadonlyMap<string, VoiceState>;
        };
        const fetched = await manager.fetch();
        if (isVoiceStateMap(fetched)) {
            return fetched;
        }
        return manager.cache;
    } catch (error) {
        console.warn('[leveling] Failed to fetch guild voice states; using cache:', error);
        return guild.voiceStates.cache;
    }
}

function collectLiveNonBotMembers(
    voiceStates: Iterable<[string, VoiceState]> | ReadonlyMap<string, VoiceState>
): Array<{ userId: string; channelId: string }> {
    const members: Array<{ userId: string; channelId: string }> = [];

    for (const [, state] of voiceStates) {
        if (!state.channelId || state.member?.user.bot) {
            continue;
        }

        members.push({ userId: state.id, channelId: state.channelId });
    }

    return members;
}

function buildOccupancyByChannel(
    liveMembers: ReadonlyArray<{ userId: string; channelId: string }>
): Map<string, number> {
    const occupancy = new Map<string, number>();
    for (const member of liveMembers) {
        occupancy.set(member.channelId, (occupancy.get(member.channelId) ?? 0) + 1);
    }
    return occupancy;
}

function isVoiceStateMap(value: unknown): value is ReadonlyMap<string, VoiceState> {
    return !!value && typeof value === 'object' && typeof (value as Map<string, VoiceState>).values === 'function';
}
