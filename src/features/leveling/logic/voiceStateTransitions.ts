import type { GuildMember, VoiceBasedChannel, VoiceState } from 'discord.js';
import { VOICE_ELIGIBLE_OCCUPANCY_THRESHOLD } from '../constants';
import type { VoiceSessionEvent } from './voiceSessionStateMachine';

export type VoiceChannelTransition = 'join' | 'leave' | 'move' | 'none';

export type VoiceUpdateContext = {
    guildId: string;
    userId: string;
    oldChannelId: string | null;
    newChannelId: string | null;
    oldChannelOccupancyAfter: number;
    newChannelOccupancyAfter: number;
};

export function getVoiceTransition(
    oldChannelId: string | null,
    newChannelId: string | null
): VoiceChannelTransition {
    if (oldChannelId === newChannelId) {
        return 'none';
    }

    if (!oldChannelId && newChannelId) {
        return 'join';
    }

    if (oldChannelId && !newChannelId) {
        return 'leave';
    }

    return 'move';
}

export function shouldSkipMemberForVoiceXp(member: GuildMember | null | undefined): boolean {
    return !!member?.user.bot;
}

export function countNonBotMembers(channel: VoiceBasedChannel | null | undefined): number {
    if (!channel) {
        return 0;
    }

    return channel.members.filter((member) => !member.user.bot).size;
}

export function countNonBotOccupancy(
    members: ReadonlyArray<{ channelId: string | null; isBot: boolean }>,
    channelId: string
): number {
    return members.filter((member) => member.channelId === channelId && !member.isBot).length;
}

export function toMachineEvents(context: VoiceUpdateContext): VoiceSessionEvent[] {
    const transitionKind = getVoiceTransition(context.oldChannelId, context.newChannelId);
    const events: VoiceSessionEvent[] = [];

    if (transitionKind === 'leave' || transitionKind === 'move') {
        events.push({ type: 'MemberLeft', guildId: context.guildId, userId: context.userId });
        if (
            context.oldChannelId &&
            context.oldChannelOccupancyAfter > 0 &&
            context.oldChannelOccupancyAfter < VOICE_ELIGIBLE_OCCUPANCY_THRESHOLD
        ) {
            events.push({
                type: 'OccupancyDecreased',
                guildId: context.guildId,
                channelId: context.oldChannelId,
            });
        }
    }

    if (transitionKind === 'join' || transitionKind === 'move') {
        if (!context.newChannelId) {
            return events;
        }

        events.push({
            type: 'MemberJoined',
            guildId: context.guildId,
            userId: context.userId,
            channelId: context.newChannelId,
            occupancy: context.newChannelOccupancyAfter,
        });

        if (context.newChannelOccupancyAfter === VOICE_ELIGIBLE_OCCUPANCY_THRESHOLD) {
            events.push({
                type: 'OccupancyIncreased',
                guildId: context.guildId,
                channelId: context.newChannelId,
            });
        }
    }

    return events;
}

export function getVoiceUpdateContext(oldState: VoiceState, newState: VoiceState): VoiceUpdateContext | null {
    const guildId = newState.guild.id || oldState.guild.id;
    const userId = newState.id || oldState.id;
    if (!guildId || !userId) {
        return null;
    }

    return {
        guildId,
        userId,
        oldChannelId: oldState.channelId,
        newChannelId: newState.channelId,
        oldChannelOccupancyAfter: countNonBotMembers(oldState.channel),
        newChannelOccupancyAfter: countNonBotMembers(newState.channel),
    };
}
