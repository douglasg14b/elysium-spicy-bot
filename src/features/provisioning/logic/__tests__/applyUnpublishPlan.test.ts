import { ChannelType, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { applyUnpublishPlan } from '../applyUnpublishPlan';
import type { UnpublishItem, UnpublishPlan } from '../unpublishPlan';

/**
 * That the teardown does what the plan said, in the order that survives a crash.
 *
 * The ordering assertion is the point of this file: **the Discord object is deleted
 * before the binding row is removed.** Reversed, a crash in between leaves a live
 * channel with no record that we made it, which nothing can later find. It is asserted
 * as a literal call sequence, exactly as `applyInstallPlan.test.ts` asserts the mirror
 * ordering on the install side.
 */

interface FakeGuildOptions {
    readonly channelIds?: readonly string[];
    readonly roleIds?: readonly string[];
    readonly calls: string[];
    readonly channelDeleteError?: Error;
    readonly roleDeleteError?: Error;
    /**
     * Which channels sit inside which category, by id.
     *
     * A category listed here is typed as `GuildCategory`; a child named here exists in
     * the cache whether or not it was listed in `channelIds`, because a survivor is
     * very often a channel this run has never heard of.
     */
    readonly childrenByCategory?: Readonly<Record<string, readonly string[]>>;
}

function makeGuild(options: FakeGuildOptions): Guild {
    const channelIds = new Set(options.channelIds ?? []);
    const children = options.childrenByCategory ?? {};
    const categoryIds = new Set(Object.keys(children));
    const roleIds = new Set(options.roleIds ?? []);

    const parentOf = new Map<string, string>();
    for (const [categoryId, childIds] of Object.entries(children)) {
        for (const childId of childIds) {
            parentOf.set(childId, categoryId);
            channelIds.add(childId);
        }
    }

    function channel(id: string) {
        return {
            id,
            name: id,
            type: categoryIds.has(id) ? ChannelType.GuildCategory : ChannelType.GuildText,
            parentId: parentOf.get(id) ?? null,
            delete: async () => {
                if (options.channelDeleteError) throw options.channelDeleteError;
                options.calls.push(`discord:delete-channel:${id}`);
                channelIds.delete(id);
                parentOf.delete(id);
            },
        };
    }

    return {
        id: 'guild-1',
        name: 'Test Guild',
        channels: {
            cache: {
                get: (id: string) => (channelIds.has(id) ? channel(id) : undefined),
                has: (id: string) => channelIds.has(id),
                filter: (predicate: (value: ReturnType<typeof channel>) => boolean) => ({
                    map: <TMapped,>(mapper: (value: ReturnType<typeof channel>) => TMapped) =>
                        [...channelIds].map(channel).filter(predicate).map(mapper),
                }),
            },
        },
        roles: {
            cache: {
                get: (id: string) =>
                    roleIds.has(id)
                        ? {
                              id,
                              delete: async () => {
                                  if (options.roleDeleteError) throw options.roleDeleteError;
                                  options.calls.push(`discord:delete-role:${id}`);
                                  roleIds.delete(id);
                              },
                          }
                        : undefined,
                has: (id: string) => roleIds.has(id),
            },
        },
    } as never;
}

function plan(items: readonly UnpublishItem[]): UnpublishPlan {
    return { guildId: 'guild-1', journeyKey: 'journey-1', items };
}

function deleteItem(overrides: Partial<UnpublishItem> = {}): UnpublishItem {
    return {
        bindingId: 1,
        resourceKey: 'chan',
        kind: 'textChannel',
        name: 'tickets',
        action: 'delete',
        discordId: 'channel-1',
        ...overrides,
    };
}

function makeRepo(calls: string[], error?: Error) {
    return {
        forget: vi.fn(async (id: number) => {
            if (error) throw error;
            calls.push(`repo:forget:${id}`);
            return true;
        }),
    };
}

describe('the crash-safe ordering', () => {
    it('deletes the Discord object before removing the binding row', async () => {
        const calls: string[] = [];
        const guild = makeGuild({ channelIds: ['channel-1'], calls });

        await applyUnpublishPlan({
            guild,
            plan: plan([deleteItem()]),
            repo: makeRepo(calls),
        });

        // The whole of it. Reversed, a crash between the two orphans a live channel
        // that nothing afterwards knows was ours.
        expect(calls).toEqual(['discord:delete-channel:channel-1', 'repo:forget:1']);
    });

    it('keeps the binding row when Discord refuses the delete', async () => {
        const calls: string[] = [];
        const repo = makeRepo(calls);
        const guild = makeGuild({
            channelIds: ['channel-1'],
            calls,
            channelDeleteError: new Error('Missing Permissions'),
        });

        const result = await applyUnpublishPlan({ guild, plan: plan([deleteItem()]), repo });

        // The object still stands, so the record of it must stand too.
        expect(repo.forget).not.toHaveBeenCalled();
        expect(result.results[0].outcome).toBe('failed');
        expect(result.results[0].explanation).toContain('Missing Permissions');
    });
});

describe('carrying on past a problem', () => {
    it('does not abandon the rest of the run when one delete fails', async () => {
        const calls: string[] = [];
        const repo = makeRepo(calls);
        const guild = makeGuild({
            channelIds: ['channel-1'],
            roleIds: ['role-1'],
            calls,
            channelDeleteError: new Error('Missing Permissions'),
        });

        const result = await applyUnpublishPlan({
            guild,
            plan: plan([
                deleteItem(),
                deleteItem({ bindingId: 2, resourceKey: 'rol', kind: 'role', discordId: 'role-1', name: 'Helper' }),
            ]),
            repo,
        });

        expect(result.results[0].outcome).toBe('failed');
        // The role had no dependency on the channel, and stranding it as a live object
        // with no owner would be the worse outcome.
        expect(result.results[1].outcome).toBe('deleted');
        expect(calls).toContain('discord:delete-role:role-1');
    });

    it('treats an object deleted between plan and confirm as a success', async () => {
        const calls: string[] = [];
        const repo = makeRepo(calls);
        // Planned as a delete, but gone by the time it is confirmed.
        const guild = makeGuild({ channelIds: [], calls });

        const result = await applyUnpublishPlan({ guild, plan: plan([deleteItem()]), repo });

        // `forgotten`, not `deleted`: the desired state holds, so this is a success —
        // but we did not do it. `calls` below is the proof, holding no Discord delete
        // at all, and a report that said "deleted" beside it would be claiming credit
        // for somebody else's cleanup on the one operation the operator cannot undo.
        expect(result.results[0].outcome).toBe('forgotten');
        expect(calls).toEqual(['repo:forget:1']);
    });

    it('reports a row that could not be removed after its object was deleted', async () => {
        const calls: string[] = [];
        const guild = makeGuild({ channelIds: ['channel-1'], calls });
        const repo = makeRepo(calls, new Error('database is locked'));

        const result = await applyUnpublishPlan({ guild, plan: plan([deleteItem()]), repo });

        // The destructive half already succeeded and cannot be undone, so this is
        // reported honestly rather than thrown — and the leftover row converges on the
        // next run, which plans it as a `forget`.
        expect(result.results[0].outcome).toBe('failed');
        expect(result.results[0].explanation).toContain('record could not be deleted');
    });
});

describe('the cascade guard at apply time', () => {
    it('refuses a category that gained a child after the plan was built', async () => {
        // The window this closes: an operator reads the preview, and while they are
        // reading, somebody drags a channel into the category. Dragging takes a second;
        // deciding takes longer. Channels are deleted before categories, so a category
        // sits at the widest point of that window.
        const calls: string[] = [];
        const repo = makeRepo(calls);
        const guild = makeGuild({
            channelIds: ['cat-1'],
            calls,
            // Not in the plan, and not deleted by this run: a survivor.
            childrenByCategory: { 'cat-1': ['someone-elses-channel'] },
        });

        const result = await applyUnpublishPlan({
            guild,
            plan: plan([
                deleteItem({ kind: 'category', discordId: 'cat-1', name: 'Support', resourceKey: 'cat' }),
            ]),
            repo,
        });

        expect(result.results[0].outcome).toBe('refused');
        expect(result.results[0].explanation).toContain('someone-elses-channel');
        // Neither the category nor its record. Discord would have cascaded the delete.
        expect(calls).toEqual([]);
        expect(repo.forget).not.toHaveBeenCalled();
    });

    it('deletes a category whose children this run has already removed', async () => {
        const calls: string[] = [];
        const repo = makeRepo(calls);
        const guild = makeGuild({
            channelIds: ['cat-1', 'channel-a'],
            calls,
            childrenByCategory: { 'cat-1': ['channel-a'] },
        });

        const result = await applyUnpublishPlan({
            guild,
            plan: plan([
                deleteItem({ bindingId: 1, discordId: 'channel-a', name: 'tickets', resourceKey: 'a' }),
                deleteItem({
                    bindingId: 2,
                    kind: 'category',
                    discordId: 'cat-1',
                    name: 'Support',
                    resourceKey: 'cat',
                }),
            ]),
            repo,
        });

        // The child went first, so by the time the category is judged it is empty.
        expect(result.results[0].outcome).toBe('deleted');
        expect(result.results[1].outcome).toBe('deleted');
    });

    it('refuses a category whose child failed to delete', async () => {
        // `deletedIds` holds what was *actually* deleted, not what was planned. A child
        // that would not delete is still inside, so the category must not cascade onto
        // it.
        const calls: string[] = [];
        const repo = makeRepo(calls);
        const guild = makeGuild({
            channelIds: ['cat-1', 'channel-a'],
            calls,
            childrenByCategory: { 'cat-1': ['channel-a'] },
            channelDeleteError: new Error('Missing Permissions'),
        });

        const result = await applyUnpublishPlan({
            guild,
            plan: plan([
                deleteItem({ bindingId: 1, discordId: 'channel-a', name: 'tickets', resourceKey: 'a' }),
                deleteItem({
                    bindingId: 2,
                    kind: 'category',
                    discordId: 'cat-1',
                    name: 'Support',
                    resourceKey: 'cat',
                }),
            ]),
            repo,
        });

        expect(result.results[0].outcome).toBe('failed');
        expect(result.results[1].outcome).toBe('refused');
    });
});

describe('what apply must never do', () => {
    it('touches nothing in the guild for a refused item', async () => {
        const calls: string[] = [];
        const repo = makeRepo(calls);
        const guild = makeGuild({ channelIds: ['channel-adopted'], calls });

        const result = await applyUnpublishPlan({
            guild,
            plan: plan([
                {
                    bindingId: 1,
                    resourceKey: 'theirs',
                    kind: 'textChannel',
                    name: 'general',
                    action: 'refuse',
                    discordId: 'channel-adopted',
                    refusalReason: 'adopted',
                    explanation: 'Adopted, not created.',
                },
            ]),
            repo,
        });

        // Neither the channel nor the row. A refusal is not a soft delete.
        expect(calls).toEqual([]);
        expect(repo.forget).not.toHaveBeenCalled();
        expect(result.results[0].outcome).toBe('refused');
    });

    it('removes only the row for a forget', async () => {
        const calls: string[] = [];
        const guild = makeGuild({ channelIds: [], calls });

        const result = await applyUnpublishPlan({
            guild,
            plan: plan([
                deleteItem({ action: 'forget', discordId: undefined, resourceKey: 'pending' }),
            ]),
            repo: makeRepo(calls),
        });

        expect(calls).toEqual(['repo:forget:1']);
        expect(result.results[0].outcome).toBe('forgotten');
    });
});
