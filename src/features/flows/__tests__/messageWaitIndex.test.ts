import { describe, expect, it } from 'vitest';
import type { FlowRunEntity, FlowRunWaitConfig } from '../data/flowRunsSchema';
import { MessageWaitIndex } from '../engine/messageWaitIndex';

/**
 * The in-memory index of runs waiting on a message: what a message matches, and how
 * each park replaces or removes a run's entry.
 */

const GUILD_ID = 'guild-1';
const PARKED_AT = '2026-10-03T09:00:00.000Z';

function messageWait(channelId?: string): FlowRunWaitConfig {
    return { eventKind: 'message', parkedAt: PARKED_AT, ...(channelId ? { channelId } : {}) };
}

function indexWith(...parks: { runId: string; userId?: string; waitConfig: FlowRunWaitConfig | null }[]) {
    const index = new MessageWaitIndex();
    for (const park of parks) {
        index.record({ guildId: GUILD_ID, userId: 'member-1', wakeAt: null, ...park });
    }
    return index;
}

function postedBy(userId: string, channelId: string, parentChannelId: string | null = null) {
    return { guildId: GUILD_ID, userId, channelId, parentChannelId };
}

describe('MessageWaitIndex', () => {
    it("matches the poster's run listening anywhere, in that channel, or in the channel a thread sits under", () => {
        const index = indexWith(
            { runId: 'anywhere', waitConfig: messageWait() },
            { runId: 'in-dungeon', waitConfig: messageWait('dungeon') },
            { runId: 'in-lounge', waitConfig: messageWait('lounge') }
        );

        const runIdsFor = (channelId: string, parentChannelId: string | null = null) =>
            index
                .matching(postedBy('member-1', channelId, parentChannelId))
                .map((entry) => entry.runId)
                .sort();

        expect(runIdsFor('dungeon')).toEqual(['anywhere', 'in-dungeon']);
        expect(runIdsFor('thread-1', 'dungeon')).toEqual(['anywhere', 'in-dungeon']);
    });

    it('matches nobody for another member, or another guild', () => {
        const index = indexWith({ runId: 'run-1', waitConfig: messageWait() });

        expect(index.matching(postedBy('member-2', 'dungeon'))).toEqual([]);
        expect(index.matching({ ...postedBy('member-1', 'dungeon'), guildId: 'guild-2' })).toEqual([]);
    });

    it('hands back a copy of the entries, so a holder can tell a run that parked again since', () => {
        const index = indexWith({ runId: 'run-1', waitConfig: messageWait() });

        const [matched] = index.matching(postedBy('member-1', 'dungeon'));
        index.delete('run-1');
        index.record({ runId: 'run-1', guildId: GUILD_ID, userId: 'member-1', waitConfig: messageWait(), wakeAt: null });

        expect(matched?.runId).toBe('run-1');
        expect(index.get('run-1')).not.toBe(matched);
    });

    it('loads stored runs without overwriting an entry a newer transition already wrote', () => {
        const index = indexWith({ runId: 'run-1', waitConfig: messageWait('lounge') });
        const stored = (runId: string, channelId: string) =>
            ({
                runId,
                guildId: GUILD_ID,
                contextSnapshot: { guildId: GUILD_ID, userId: 'member-1' },
                waitConfig: messageWait(channelId),
                wakeAt: null,
            }) as FlowRunEntity;

        index.addMissing([stored('run-1', 'dungeon'), stored('run-2', 'dungeon')]);

        expect(index.get('run-1')?.channelId).toBe('lounge');
        expect(index.get('run-2')?.channelId).toBe('dungeon');
    });

    it('removes the entry when the run parks on anything but a message', () => {
        const index = indexWith({ runId: 'run-1', waitConfig: messageWait() });

        index.record({ runId: 'run-1', guildId: GUILD_ID, userId: 'member-1', waitConfig: null, wakeAt: new Date() });
        expect(index.get('run-1')).toBeUndefined();
        expect(index.matching(postedBy('member-1', 'dungeon'))).toEqual([]);

        index.record({ runId: 'run-1', guildId: GUILD_ID, userId: 'member-1', waitConfig: messageWait(), wakeAt: null });
        index.record({
            runId: 'run-1',
            guildId: GUILD_ID,
            userId: 'member-1',
            waitConfig: { eventKind: 'reactionAdd' },
            wakeAt: null,
        });
        expect(index.runIds()).toEqual([]);
    });

    it('replaces an entry with a new object on every park, so a holder can tell it parked again', () => {
        const index = indexWith({ runId: 'run-1', waitConfig: messageWait('dungeon') });
        const first = index.get('run-1');

        index.record({ runId: 'run-1', guildId: GUILD_ID, userId: 'member-1', waitConfig: messageWait('lounge'), wakeAt: null });

        expect(index.get('run-1')).not.toBe(first);
        expect(index.get('run-1')).toMatchObject({ channelId: 'lounge', parkedAt: new Date(PARKED_AT) });
        expect(index.matching(postedBy('member-1', 'dungeon'))).toEqual([]);
    });
});
