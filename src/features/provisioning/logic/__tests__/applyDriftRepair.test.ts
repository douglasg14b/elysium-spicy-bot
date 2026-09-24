import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { applyDriftRepair } from '../applyDriftRepair';
import type { JourneyDriftPlan } from '../journeyDriftPlan';
import type { ResourceDriftKind, ResourceDriftReport } from '../resourceDrift';

/**
 * Repair reconciles the guild to the declaration. The two guards worth checking are
 * both promises rather than mechanics:
 *
 *  - an **adopted** resource is never repaired, matching `buildUnpublishPlan`'s refusal
 *    to delete one
 *  - a **`wrongType`** binding is never repaired automatically, because the fix is a
 *    re-bind and only the operator knows which object they meant
 *
 * Plus the re-check, which is what stops a repair claiming credit for a fix the
 * operator made by hand while reading the report.
 */

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const EVERYONE = 'guild-1';

interface FakeChannelState {
    name: string;
    parentId: string | null;
    readonly type: ChannelType;
    readonly setName: ReturnType<typeof vi.fn>;
    readonly setParent: ReturnType<typeof vi.fn>;
    readonly edit: ReturnType<typeof vi.fn>;
}

function fakeChannel(
    name: string,
    parentId: string | null = null,
    type: ChannelType = ChannelType.GuildText
): FakeChannelState {
    const state: FakeChannelState = {
        name,
        parentId,
        type,
        setName: vi.fn(async (next: string) => {
            state.name = next;
        }),
        setParent: vi.fn(async (next: string | null) => {
            state.parentId = next;
        }),
        edit: vi.fn(async () => undefined),
    };
    return state;
}

function makeGuild(channels: Record<string, FakeChannelState>, guildId = 'guild-1'): Guild {
    return {
        id: guildId,
        name: 'Test Guild',
        channels: {
            cache: {
                get: (id: string) => {
                    const channel = channels[id];
                    if (!channel) return undefined;
                    return {
                        ...channel,
                        get name() {
                            return channel.name;
                        },
                        get parentId() {
                            return channel.parentId;
                        },
                        setName: channel.setName,
                        setParent: channel.setParent,
                        permissionOverwrites: { edit: channel.edit },
                    };
                },
            },
        },
        roles: { cache: { get: () => undefined } },
    } as never;
}

function report(overrides: Partial<ResourceDriftReport> = {}): ResourceDriftReport {
    return {
        resourceKey: 'welcome-channel',
        name: 'welcome',
        kind: 'textChannel',
        discordId: 'channel-1',
        drift: [],
        repairable: true,
        ...overrides,
    };
}

function plan(drifted: readonly ResourceDriftReport[], guildId = 'guild-1'): JourneyDriftPlan {
    return {
        guildId,
        journeyKey: 'journey-1',
        drifted,
        cleanKeys: [],
        unchecked: [],
    };
}

const renamedDrift: ResourceDriftKind = {
    kind: 'renamed',
    declared: 'welcome',
    actual: 'lobby',
};

const repo = { renameBinding: vi.fn(async () => true) };

describe('applyDriftRepair', () => {
    it('renames a channel back to what the journey declared', async () => {
        const channel = fakeChannel('lobby');
        const result = await applyDriftRepair({
            guild: makeGuild({ 'channel-1': channel }),
            plan: plan([report({ drift: [renamedDrift] })]),
            approvedKeys: new Set(['welcome-channel']),
            repo,
        });

        expect(channel.setName).toHaveBeenCalledWith('welcome', expect.any(String));
        expect(result.results).toEqual([
            {
                resourceKey: 'welcome-channel',
                kind: 'textChannel',
                name: 'welcome',
                outcome: 'repaired',
                repaired: ['renamed'],
            },
        ]);
    });

    it('acts only on approved keys', async () => {
        const channel = fakeChannel('lobby');
        const result = await applyDriftRepair({
            guild: makeGuild({ 'channel-1': channel }),
            plan: plan([report({ drift: [renamedDrift] })]),
            approvedKeys: new Set(),
            repo,
        });

        expect(channel.setName).not.toHaveBeenCalled();
        expect(result.results).toEqual([]);
    });

    /**
     * The adoption promise. `buildUnpublishPlan` already refuses to delete an adopted
     * resource; a promise that holds for deletion and not for a rename is not one.
     */
    it('refuses to repair an adopted resource', async () => {
        const channel = fakeChannel('lobby');
        const result = await applyDriftRepair({
            guild: makeGuild({ 'channel-1': channel }),
            plan: plan([report({ drift: [renamedDrift], repairable: false })]),
            approvedKeys: new Set(['welcome-channel']),
            repo,
        });

        expect(channel.setName).not.toHaveBeenCalled();
        expect(result.results[0]?.outcome).toBe('refused');
        expect(result.results[0]?.explanation).toMatch(/adopted/);
    });

    /**
     * A re-bind, not a rename — and which object the operator meant is not something
     * this code can know.
     */
    it('refuses to repair a binding that points at the wrong kind of object', async () => {
        const channel = fakeChannel('welcome');
        const result = await applyDriftRepair({
            guild: makeGuild({ 'channel-1': channel }),
            plan: plan([
                report({
                    drift: [{ kind: 'wrongType', declared: 'textChannel', actual: 'GuildVoice' }],
                }),
            ]),
            approvedKeys: new Set(['welcome-channel']),
            repo,
        });

        expect(channel.setName).not.toHaveBeenCalled();
        expect(result.results[0]?.outcome).toBe('refused');
        expect(result.results[0]?.explanation).toMatch(/cannot be repaired automatically/);
    });

    /**
     * A plan is reviewed by a human and confirmation takes time. An operator who fixed
     * the rename themselves must not be told the repair did it — this report is the
     * only evidence they get of what actually happened.
     */
    it('reports nothing repaired when the operator already fixed it by hand', async () => {
        const channel = fakeChannel('welcome');
        const result = await applyDriftRepair({
            guild: makeGuild({ 'channel-1': channel }),
            plan: plan([report({ drift: [renamedDrift] })]),
            approvedKeys: new Set(['welcome-channel']),
            repo,
        });

        expect(channel.setName).not.toHaveBeenCalled();
        expect(result.results[0]).toMatchObject({ outcome: 'repaired', repaired: [] });
    });

    it('moves a channel back into its declared category', async () => {
        const channel = fakeChannel('welcome', null);
        await applyDriftRepair({
            guild: makeGuild({ 'channel-1': channel }),
            plan: plan([
                report({
                    drift: [
                        {
                            kind: 'reparented',
                            declaredParentId: 'category-1',
                            actualParentId: null,
                        },
                    ],
                }),
            ]),
            approvedKeys: new Set(['welcome-channel']),
            repo,
        });

        // `lockPermissions: false` is the load-bearing half — Discord's default syncs
        // overwrites to the new category, destroying the model being protected.
        expect(channel.setParent).toHaveBeenCalledWith(
            'category-1',
            expect.objectContaining({ lockPermissions: false })
        );
    });

    describe('permissions', () => {
        const permissionDrift: ResourceDriftKind = {
            kind: 'permissions',
            differences: [{ id: EVERYONE, missingAllow: [], missingDeny: [String(VIEW)] }],
        };

        it('reapplies the compiled overwrites per id', async () => {
            const channel = fakeChannel('welcome');
            await applyDriftRepair({
                guild: makeGuild({ 'channel-1': channel }),
                plan: plan([report({ drift: [permissionDrift] })]),
                approvedKeys: new Set(['welcome-channel']),
                compiledOverwrites: new Map([
                    ['welcome-channel', [{ id: EVERYONE, allow: [], deny: [VIEW] }]],
                ]),
                repo,
            });

            expect(channel.edit).toHaveBeenCalledWith(
                EVERYONE,
                { ViewChannel: false },
                expect.any(Object)
            );
        });

        it('translates allow and deny bits to the flag names edit expects', async () => {
            const channel = fakeChannel('welcome');
            await applyDriftRepair({
                guild: makeGuild({ 'channel-1': channel }),
                plan: plan([report({ drift: [permissionDrift] })]),
                approvedKeys: new Set(['welcome-channel']),
                compiledOverwrites: new Map([
                    ['welcome-channel', [{ id: 'role-staff', allow: [VIEW], deny: [SEND] }]],
                ]),
                repo,
            });

            expect(channel.edit).toHaveBeenCalledWith(
                'role-staff',
                { ViewChannel: true, SendMessages: false },
                expect.any(Object)
            );
        });

        /**
         * Guessing at a permission model would be the one failure worse than the drift
         * it was meant to fix.
         */
        it('fails rather than guessing when no compiled model was supplied', async () => {
            const channel = fakeChannel('welcome');
            const result = await applyDriftRepair({
                guild: makeGuild({ 'channel-1': channel }),
                plan: plan([report({ drift: [permissionDrift] })]),
                approvedKeys: new Set(['welcome-channel']),
                repo,
            });

            expect(channel.edit).not.toHaveBeenCalled();
            expect(result.results[0]?.outcome).toBe('failed');
            expect(result.results[0]?.explanation).toMatch(/without guessing/);
        });
    });

    it('refuses a plan built for a different guild without touching anything', async () => {
        const channel = fakeChannel('lobby');
        const result = await applyDriftRepair({
            guild: makeGuild({ 'channel-1': channel }, 'guild-2'),
            plan: plan([report({ drift: [renamedDrift] })], 'guild-1'),
            approvedKeys: new Set(['welcome-channel']),
            repo,
        });

        expect(channel.setName).not.toHaveBeenCalled();
        expect(result.results).toEqual([]);
        expect(result.refusal).toMatch(/guild-1/);
    });

    it('reports a failure per item and keeps going', async () => {
        const failing = fakeChannel('lobby');
        failing.setName.mockRejectedValueOnce(new Error('Missing Permissions'));
        const fine = fakeChannel('wrong-name');

        const result = await applyDriftRepair({
            guild: makeGuild({ 'channel-1': failing, 'channel-2': fine }),
            plan: plan([
                report({ drift: [renamedDrift] }),
                report({
                    resourceKey: 'rules-channel',
                    discordId: 'channel-2',
                    name: 'rules',
                    drift: [{ kind: 'renamed', declared: 'rules', actual: 'wrong-name' }],
                }),
            ]),
            approvedKeys: new Set(['welcome-channel', 'rules-channel']),
            repo,
        });

        expect(result.results[0]?.outcome).toBe('failed');
        expect(result.results[1]?.outcome).toBe('repaired');
        expect(fine.setName).toHaveBeenCalledWith('rules', expect.any(String));
    });
});
