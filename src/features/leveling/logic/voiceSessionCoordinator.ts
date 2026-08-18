import { DiscordAPIError, type Collection, type Guild, type VoiceState } from 'discord.js';
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
        const sessions = await this.voiceSessionRepo.listByGuild(guild.id);
        const voiceStates =
            options?.voiceStates ??
            (await fetchLiveVoiceStates(guild, {
                refreshUserIds: sessions.map((session) => session.userId),
            }));
        const liveMembers = collectLiveNonBotMembers(voiceStates);
        const occupancyByChannel = buildOccupancyByChannel(liveMembers);
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

const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const UNKNOWN_VOICE_STATE_ERROR_CODE = 10065;

/**
 * discord.js `VoiceStateManager.fetch()` requires a user snowflake. A no-arg call
 * hits `GET /guilds/{id}/voice-states/null` and Discord rejects it (50035).
 * Guild voice state is already in the gateway cache (`GuildVoiceStates` intent).
 * Open-session user IDs are confirmed per-user so missed leaves can still be caught.
 */
export async function fetchLiveVoiceStates(
    guild: Guild,
    options?: { refreshUserIds?: ReadonlyArray<string> }
): Promise<ReadonlyMap<string, VoiceState>> {
    const live = new Map(guild.voiceStates.cache);

    for (const userId of options?.refreshUserIds ?? []) {
        if (!DISCORD_SNOWFLAKE_PATTERN.test(userId)) {
            continue;
        }

        try {
            const state = await guild.voiceStates.fetch(userId);
            if (state.channelId) {
                live.set(state.id, state);
            } else {
                live.delete(userId);
            }
        } catch (error) {
            if (isMissingVoiceStateError(error)) {
                live.delete(userId);
            }
        }
    }

    return live;
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

function isMissingVoiceStateError(error: unknown): boolean {
    if (!(error instanceof DiscordAPIError)) {
        return false;
    }

    return error.status === 404 || error.code === UNKNOWN_VOICE_STATE_ERROR_CODE;
}
