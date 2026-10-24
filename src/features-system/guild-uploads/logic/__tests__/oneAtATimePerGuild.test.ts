import { afterEach, describe, expect, it, vi } from 'vitest';
import { guildUploadsRepo } from '../../data/guildUploadsRepo';
import { deleteGuildUpload } from '../deleteGuildUpload';
import { oneAtATimePerGuild } from '../oneAtATimePerGuild';

/** The per-guild queue every upload write runs on: stores and deletes, one at a time per server. */

/** A task that runs until `release` is called, and a promise that settles when it has started. */
function heldTask(): { readonly started: Promise<void>; readonly release: () => void; readonly work: () => Promise<void> } {
    let markStarted = (): void => undefined;
    let release = (): void => undefined;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    return {
        started,
        release: () => release(),
        work: async () => {
            markStarted();
            await released;
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('oneAtATimePerGuild', () => {
    it("runs a guild's work in the order it was queued, each after the last has finished", async () => {
        const order: string[] = [];
        const first = heldTask();

        const firstDone = oneAtATimePerGuild('guild-order', async () => {
            await first.work();
            order.push('first');
        });
        const secondDone = oneAtATimePerGuild('guild-order', async () => {
            order.push('second');
        });
        await first.started;
        await Promise.resolve();
        expect(order).toEqual([]);

        first.release();
        await Promise.all([firstDone, secondDone]);
        expect(order).toEqual(['first', 'second']);
    });

    it('carries on after a failed step, which fails only its own caller', async () => {
        const failed = oneAtATimePerGuild('guild-failure', async () => {
            throw new Error('the picture bit back');
        });
        const next = oneAtATimePerGuild('guild-failure', async () => 'still standing');

        await expect(failed).rejects.toThrow('the picture bit back');
        await expect(next).resolves.toBe('still standing');
    });

    it("never holds one guild's work behind another's", async () => {
        const blocker = heldTask();
        const blocked = oneAtATimePerGuild('guild-busy', blocker.work);
        await blocker.started;

        await expect(oneAtATimePerGuild('guild-free', async () => 'done')).resolves.toBe('done');

        blocker.release();
        await blocked;
    });

    it('holds a delete until the write queued before it for the same guild has finished', async () => {
        const holds = vi.spyOn(guildUploadsRepo, 'holds').mockResolvedValue(false);
        const store = heldTask();
        const storing = oneAtATimePerGuild('guild-store-then-delete', store.work);
        await store.started;

        const deleting = deleteGuildUpload('guild-store-then-delete', 'upload-1');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(holds).not.toHaveBeenCalled();

        store.release();
        await storing;
        await expect(deleting).resolves.toEqual({ kind: 'notFound' });
        expect(holds).toHaveBeenCalledOnce();
    });
});
