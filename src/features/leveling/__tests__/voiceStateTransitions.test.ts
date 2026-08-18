import { describe, expect, it } from 'vitest';
import {
    countNonBotOccupancy,
    getVoiceTransition,
    shouldSkipMemberForVoiceXp,
    toMachineEvents,
} from '../logic/voiceStateTransitions';

describe('voiceStateTransitions', () => {
    it('classifies join, leave, move, and none', () => {
        expect(getVoiceTransition(null, 'channel-1')).toBe('join');
        expect(getVoiceTransition('channel-1', null)).toBe('leave');
        expect(getVoiceTransition('channel-1', 'channel-2')).toBe('move');
        expect(getVoiceTransition('channel-1', 'channel-1')).toBe('none');
    });

    it('skips bots and counts non-bot occupancy', () => {
        expect(shouldSkipMemberForVoiceXp({ user: { bot: true } } as never)).toBe(true);
        expect(shouldSkipMemberForVoiceXp({ user: { bot: false } } as never)).toBe(false);
        expect(
            countNonBotOccupancy(
                [
                    { channelId: 'vc-1', isBot: false },
                    { channelId: 'vc-1', isBot: true },
                    { channelId: 'vc-1', isBot: false },
                    { channelId: 'vc-2', isBot: false },
                ],
                'vc-1'
            )
        ).toBe(2);
    });

    it('maps a join that makes occupancy 2 into join plus occupancy increase', () => {
        expect(
            toMachineEvents({
                guildId: 'guild-1',
                userId: 'user-1',
                oldChannelId: null,
                newChannelId: 'vc-1',
                oldChannelOccupancyAfter: 0,
                newChannelOccupancyAfter: 2,
            }).map((event) => event.type)
        ).toEqual(['MemberJoined', 'OccupancyIncreased']);
    });

    it('maps a leave that leaves one person into leave plus occupancy decrease', () => {
        expect(
            toMachineEvents({
                guildId: 'guild-1',
                userId: 'user-1',
                oldChannelId: 'vc-1',
                newChannelId: null,
                oldChannelOccupancyAfter: 1,
                newChannelOccupancyAfter: 0,
            }).map((event) => event.type)
        ).toEqual(['MemberLeft', 'OccupancyDecreased']);
    });

    it('maps a channel move as leave then join', () => {
        const events = toMachineEvents({
            guildId: 'guild-1',
            userId: 'user-1',
            oldChannelId: 'vc-1',
            newChannelId: 'vc-2',
            oldChannelOccupancyAfter: 1,
            newChannelOccupancyAfter: 1,
        });

        expect(events.map((event) => event.type)).toEqual(['MemberLeft', 'OccupancyDecreased', 'MemberJoined']);
        expect(events[2]).toMatchObject({ type: 'MemberJoined', channelId: 'vc-2', occupancy: 1 });
    });

    it('does not emit occupancy events when a join lands in an already-eligible channel', () => {
        expect(
            toMachineEvents({
                guildId: 'guild-1',
                userId: 'user-1',
                oldChannelId: null,
                newChannelId: 'vc-1',
                oldChannelOccupancyAfter: 0,
                newChannelOccupancyAfter: 3,
            }).map((event) => event.type)
        ).toEqual(['MemberJoined']);
    });
});
