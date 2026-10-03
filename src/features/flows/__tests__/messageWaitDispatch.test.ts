import type { Client, Guild, Message } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageActivityEvent } from '../../../features-system/activity';
import { RESUME_EVENT } from '../blocks/types';
import type { FlowRunEntity, FlowRunWaitConfig } from '../data/flowRunsSchema';

const resumeFlowRun = vi.fn();

vi.mock('../engine/flowRunResume', () => ({
    resumeFlowRun: (...args: unknown[]) => resumeFlowRun(...args),
}));

const { rebuildMessageWaitIndex, wakeMessageWaits } = await import('../engine/messageWaitDispatch');
const { messageWaitIndex } = await import('../engine/messageWaitIndex');

/**
 * The live wake and the startup load, with the resume itself stubbed: what each one hands
 * the claim, and which runs it leaves alone.
 */

const GUILD_ID = 'guild-1';
const MEMBER_ID = 'member-1';
const CLIENT = {} as Client;
const SENT_AT = new Date('2026-10-03T12:00:00.000Z');

function messageWait(channelId?: string): FlowRunWaitConfig {
    return { eventKind: 'message', parkedAt: '2026-10-03T09:00:00.000Z', ...(channelId ? { channelId } : {}) };
}

function park(runId: string, channelId?: string): void {
    messageWaitIndex.record({ runId, guildId: GUILD_ID, userId: MEMBER_ID, waitConfig: messageWait(channelId), wakeAt: null });
}

function messageFrom(userId: string, channelId: string): MessageActivityEvent {
    return {
        kind: 'message',
        activityEventId: 1,
        guild: { id: GUILD_ID } as Guild,
        userId,
        channelId,
        parentChannelId: null,
        message: { client: CLIENT, createdAt: SENT_AT } as Message<true>,
    };
}

beforeEach(() => {
    for (const runId of messageWaitIndex.runIds()) messageWaitIndex.delete(runId);
    resumeFlowRun.mockReset().mockResolvedValue({ status: 'completed' });
});

describe('wakeMessageWaits', () => {
    it('claims each matching run as a message wait still open when the message was sent', async () => {
        park('run-1', 'dungeon');

        await wakeMessageWaits(messageFrom(MEMBER_ID, 'dungeon'));

        expect(resumeFlowRun).toHaveBeenCalledWith(CLIENT, { runId: 'run-1' }, RESUME_EVENT, undefined, {
            waitKind: 'message',
            eventAt: SENT_AT,
        });
    });

    it('skips a run that parked on a new wait while an earlier run was resuming', async () => {
        park('run-1');
        park('run-2');
        // While run-1 resumes, run-2 times out and parks again — on a wait in another channel.
        resumeFlowRun.mockImplementationOnce(async () => {
            park('run-2', 'elsewhere');
            return { status: 'completed' };
        });

        await wakeMessageWaits(messageFrom(MEMBER_ID, 'dungeon'));

        expect(resumeFlowRun).toHaveBeenCalledTimes(1);
        expect(resumeFlowRun.mock.calls[0]?.[1]).toEqual({ runId: 'run-1' });
    });

    it('draws one token per run woken, and leaves a refused run parked for the next message', async () => {
        park('run-1');
        park('run-2');
        const take = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);

        await wakeMessageWaits(messageFrom(MEMBER_ID, 'dungeon'), { take });

        expect(take.mock.calls).toEqual([
            [GUILD_ID, MEMBER_ID, 'wake'],
            [GUILD_ID, MEMBER_ID, 'wake'],
        ]);
        expect(resumeFlowRun).toHaveBeenCalledTimes(1);
        expect(messageWaitIndex.get('run-2')).toBeDefined();
    });

    it('ignores reactions', async () => {
        park('run-1');

        await wakeMessageWaits({ kind: 'reaction', activityEventId: 1, guild: { id: GUILD_ID } as Guild, userId: MEMBER_ID, channelId: 'dungeon' });

        expect(resumeFlowRun).not.toHaveBeenCalled();
    });
});

describe('rebuildMessageWaitIndex', () => {
    it('keeps a run that parked while the stored runs were being read', async () => {
        const stored = {
            runId: 'run-stored',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: MEMBER_ID },
            waitConfig: messageWait(),
            wakeAt: null,
        } as FlowRunEntity;
        const findWaiting = vi.fn(async () => {
            park('run-fresh');
            return [stored];
        });

        await rebuildMessageWaitIndex({ findWaiting });

        expect(messageWaitIndex.runIds().sort()).toEqual(['run-fresh', 'run-stored']);
    });

    it('keeps what the index holds when the read fails, and says so', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        park('run-fresh');

        await rebuildMessageWaitIndex({ findWaiting: vi.fn().mockRejectedValue(new Error('bad row')) });

        expect(messageWaitIndex.runIds()).toEqual(['run-fresh']);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('until the next restart'), expect.any(Error));
        error.mockRestore();
    });
});
