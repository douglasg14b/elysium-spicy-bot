import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ResourceBindingEntity } from '../../data/resourceBindingsSchema';
import { buildInstallPlan, isPlanApplicable, type PlanItem } from '../installPlan';
import type { JourneyDeclaration } from '../resourceDeclaration';

/**
 * The plan, which is the only thing standing between a journey declaration and a
 * mutated server.
 *
 * The requirement it enforces is "never silently mutate a live server", so the tests
 * that matter most are the ones asserting a *refusal* — an ambiguous name, an
 * existing channel, a missing permission. A plan that quietly does the reasonable
 * thing is the failure being guarded against.
 */

interface FakeChannel {
    id: string;
    name: string;
    type: ChannelType;
}

interface FakeGuildOptions {
    channels?: FakeChannel[];
    roles?: { id: string; name: string }[];
    permissions?: bigint[];
    botRolePosition?: number;
    botCached?: boolean;
}

function makeGuild({
    channels = [],
    // A staff role exists by default: the `staff` audience verifies its roles are
    // real, so a guild with none would fail for the wrong reason.
    roles = [{ id: 'role-staff', name: 'Staff' }],
    permissions = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    botRolePosition = 5,
    botCached = true,
}: FakeGuildOptions = {}) {
    const channelMap = new Map(channels.map((channel) => [channel.id, channel]));
    const roleMap = new Map(roles.map((role) => [role.id, role]));

    return {
        id: 'guild-1',
        name: 'Test Guild',
        channels: {
            cache: {
                has: (id: string) => channelMap.has(id),
                get: (id: string) => channelMap.get(id),
                filter: (fn: (channel: FakeChannel) => boolean) => ({
                    map: <T,>(project: (channel: FakeChannel) => T) =>
                        [...channelMap.values()].filter(fn).map(project),
                }),
            },
        },
        roles: {
            everyone: { id: 'everyone-role' },
            cache: {
                has: (id: string) => roleMap.has(id),
                filter: (fn: (role: { id: string; name: string }) => boolean) => ({
                    map: <T,>(project: (role: { id: string; name: string }) => T) =>
                        [...roleMap.values()].filter(fn).map(project),
                }),
            },
        },
        members: {
            me: botCached
                ? {
                      id: 'bot-member',
                      permissions: {
                          has: (flag: bigint) => permissions.includes(flag),
                      },
                      roles: { highest: { position: botRolePosition } },
                  }
                : null,
        },
    } as never;
}

const JOURNEY: JourneyDeclaration = {
    journeyKey: 'onboarding',
    name: 'Onboarding',
    resources: [
        { key: 'arrivals-category', kind: 'category', defaultName: 'Arrivals' },
        {
            key: 'welcome-channel',
            kind: 'textChannel',
            defaultName: 'welcome',
            parentKey: 'arrivals-category',
        },
        { key: 'verified-role', kind: 'role', defaultName: 'Verified' },
    ],
};

function itemFor(items: readonly PlanItem[], key: string): PlanItem {
    const found = items.find((item) => item.resourceKey === key);
    if (!found) throw new Error(`no plan item for ${key}`);
    return found;
}

function binding(overrides: Partial<ResourceBindingEntity>): ResourceBindingEntity {
    return {
        id: 1,
        guildId: 'guild-1',
        journeyKey: 'onboarding',
        resourceKey: 'welcome-channel',
        kind: 'textChannel',
        state: 'created',
        discordId: 'chan-existing',
        name: 'welcome',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as ResourceBindingEntity;
}

describe('buildInstallPlan', () => {
    it('plans a create for every resource on an empty guild', () => {
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: JOURNEY,
            existingBindings: [],
        });

        expect(plan.items).toHaveLength(3);
        expect(plan.items.every((item) => item.action === 'create')).toBe(true);
        expect(plan.blockers).toHaveLength(0);
        expect(isPlanApplicable(plan)).toBe(true);
    });

    it('orders parents before their children', () => {
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: {
                ...JOURNEY,
                // Declared child-first on purpose: ordering must come from the
                // parent relationship, not from declaration order.
                resources: [JOURNEY.resources[1], JOURNEY.resources[0], JOURNEY.resources[2]],
            },
            existingBindings: [],
        });

        const categoryIndex = plan.items.findIndex((item) => item.resourceKey === 'arrivals-category');
        const channelIndex = plan.items.findIndex((item) => item.resourceKey === 'welcome-channel');
        expect(categoryIndex).toBeLessThan(channelIndex);
    });

    it('reuses a settled binding rather than creating a duplicate', () => {
        const plan = buildInstallPlan({
            guild: makeGuild({
                channels: [{ id: 'chan-existing', name: 'welcome', type: ChannelType.GuildText }],
            }),
            journey: JOURNEY,
            existingBindings: [binding({})],
        });

        const welcome = itemFor(plan.items, 'welcome-channel');
        expect(welcome.action).toBe('reuse');
        expect(welcome.discordId).toBe('chan-existing');
    });

    it('plans a recreate when a bound resource has been deleted from the guild', () => {
        // The binding survives, the channel does not. Recreating silently would hide
        // a deletion the operator may not know about, so it is reported.
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: JOURNEY,
            existingBindings: [binding({})],
        });

        const welcome = itemFor(plan.items, 'welcome-channel');
        expect(welcome.action).toBe('create');
        expect(welcome.reason).toMatch(/no longer exists/i);
    });

    it('treats an intended binding as unsettled and plans the resource again', () => {
        // This is the crash-recovery path: a row written before a crash names a
        // resource that may never have been created.
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: JOURNEY,
            existingBindings: [binding({ state: 'intended', discordId: null })],
        });

        expect(itemFor(plan.items, 'welcome-channel').action).toBe('create');
    });

    describe('never binds by name on its own', () => {
        it('blocks rather than adopting a channel that happens to share the name', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({
                    channels: [{ id: 'chan-theirs', name: 'welcome', type: ChannelType.GuildText }],
                }),
                journey: JOURNEY,
                existingBindings: [],
            });

            const welcome = itemFor(plan.items, 'welcome-channel');
            expect(welcome.action).toBe('blocked');
            expect(welcome.reason).toMatch(/already exists/i);
            // The id is offered as a suggestion so the UI can present "adopt this".
            expect(welcome.discordId).toBe('chan-theirs');
            expect(isPlanApplicable(plan)).toBe(false);
        });

        it('blocks on an ambiguous name rather than picking one', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({
                    channels: [
                        { id: 'chan-a', name: 'welcome', type: ChannelType.GuildText },
                        { id: 'chan-b', name: 'welcome', type: ChannelType.GuildText },
                    ],
                }),
                journey: JOURNEY,
                existingBindings: [],
            });

            const welcome = itemFor(plan.items, 'welcome-channel');
            expect(welcome.action).toBe('blocked');
            expect(welcome.reason).toMatch(/2 channels are named/i);
            expect(welcome.discordId).toBeUndefined();
        });

        it('does not confuse a category with a text channel of the same name', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({
                    channels: [{ id: 'cat-x', name: 'welcome', type: ChannelType.GuildCategory }],
                }),
                journey: JOURNEY,
                existingBindings: [],
            });

            expect(itemFor(plan.items, 'welcome-channel').action).toBe('create');
        });
    });

    describe('explicit adoption', () => {
        it('adopts the resource the operator chose', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({
                    channels: [{ id: 'chan-chosen', name: 'hello', type: ChannelType.GuildText }],
                }),
                journey: JOURNEY,
                existingBindings: [],
                choices: { 'welcome-channel': { adoptDiscordId: 'chan-chosen' } },
            });

            const welcome = itemFor(plan.items, 'welcome-channel');
            expect(welcome.action).toBe('adopt');
            expect(welcome.discordId).toBe('chan-chosen');
        });

        it('blocks when the chosen resource does not exist', () => {
            const plan = buildInstallPlan({
                guild: makeGuild(),
                journey: JOURNEY,
                existingBindings: [],
                choices: { 'welcome-channel': { adoptDiscordId: 'chan-ghost' } },
            });

            expect(itemFor(plan.items, 'welcome-channel').action).toBe('blocked');
        });

        it('honours an operator-supplied name', () => {
            const plan = buildInstallPlan({
                guild: makeGuild(),
                journey: JOURNEY,
                existingBindings: [],
                choices: { 'welcome-channel': { name: 'say-hi' } },
            });

            expect(itemFor(plan.items, 'welcome-channel').name).toBe('say-hi');
        });
    });

    /**
     * Adoption declared by the author, rather than chosen at install.
     *
     * The install form's `choices` were the only way to say "adopt this", and nothing
     * in the builder supplies them — the flow is authored long before install runs.
     * A declaration carrying the id is how "this flow needs #announcements, which we
     * already have" becomes sayable.
     */
    describe('adoption declared on the resource', () => {
        const ADOPTING: JourneyDeclaration = {
            journeyKey: 'onboarding',
            name: 'Onboarding',
            resources: [
                {
                    key: 'welcome-channel',
                    kind: 'textChannel',
                    defaultName: 'welcome',
                    adoptDiscordId: 'chan-declared',
                },
            ],
        };

        it('adopts the channel the declaration names', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({
                    channels: [
                        { id: 'chan-declared', name: 'welcome', type: ChannelType.GuildText },
                    ],
                }),
                journey: ADOPTING,
                existingBindings: [],
            });

            const welcome = itemFor(plan.items, 'welcome-channel');
            expect(welcome.action).toBe('adopt');
            expect(welcome.discordId).toBe('chan-declared');
            expect(isPlanApplicable(plan)).toBe(true);
        });

        it('blocks rather than creating when the declared channel is gone', () => {
            // Creating one instead would install a duplicate of whatever the operator
            // actually meant — they said it already existed.
            const plan = buildInstallPlan({
                guild: makeGuild(),
                journey: ADOPTING,
                existingBindings: [],
            });

            const welcome = itemFor(plan.items, 'welcome-channel');
            expect(welcome.action).toBe('blocked');
            expect(welcome.reason).toMatch(/chan-declared.*does not exist/i);
        });

        it('blocks a category adopting a text channel rather than letting apply throw', () => {
            // The plan used to ask only `channels.cache.has(id)`, which is true for a
            // text channel handed to a resource declared as a category. `apply`'s
            // `requireAdoptable` checks the type and refuses — so the plan showed an
            // applicable adopt, got approved, and threw mid-apply with earlier
            // resources already created.
            const plan = buildInstallPlan({
                guild: makeGuild({
                    channels: [{ id: 'chan-text', name: 'welcome', type: ChannelType.GuildText }],
                }),
                journey: {
                    journeyKey: 'onboarding',
                    name: 'Onboarding',
                    resources: [
                        {
                            key: 'arrivals-category',
                            kind: 'category',
                            defaultName: 'Arrivals',
                            adoptDiscordId: 'chan-text',
                        },
                    ],
                },
                existingBindings: [],
            });

            const category = itemFor(plan.items, 'arrivals-category');
            expect(category.action).toBe('blocked');
            expect(category.reason).toMatch(/is not a category/i);
            expect(isPlanApplicable(plan)).toBe(false);
        });

        it('blocks a text channel adopting a category', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({
                    channels: [
                        { id: 'cat-x', name: 'Arrivals', type: ChannelType.GuildCategory },
                    ],
                }),
                journey: {
                    journeyKey: 'onboarding',
                    name: 'Onboarding',
                    resources: [
                        {
                            key: 'welcome-channel',
                            kind: 'textChannel',
                            defaultName: 'welcome',
                            adoptDiscordId: 'cat-x',
                        },
                    ],
                },
                existingBindings: [],
            });

            expect(itemFor(plan.items, 'welcome-channel').action).toBe('blocked');
        });

        it('lets an install-time choice override the declaration', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({
                    channels: [
                        { id: 'chan-declared', name: 'welcome', type: ChannelType.GuildText },
                        { id: 'chan-chosen', name: 'hello', type: ChannelType.GuildText },
                    ],
                }),
                journey: ADOPTING,
                existingBindings: [],
                choices: { 'welcome-channel': { adoptDiscordId: 'chan-chosen' } },
            });

            expect(itemFor(plan.items, 'welcome-channel').discordId).toBe('chan-chosen');
        });

        it('still lets a settled binding win over a declared adoption', () => {
            // Re-running install must converge, not rebind to something else.
            const plan = buildInstallPlan({
                guild: makeGuild({
                    channels: [
                        { id: 'chan-existing', name: 'welcome', type: ChannelType.GuildText },
                        { id: 'chan-declared', name: 'other', type: ChannelType.GuildText },
                    ],
                }),
                journey: ADOPTING,
                existingBindings: [binding({})],
            });

            const welcome = itemFor(plan.items, 'welcome-channel');
            expect(welcome.action).toBe('reuse');
            expect(welcome.discordId).toBe('chan-existing');
        });
    });

    describe('permission intents are checked at plan time', () => {
        const JOURNEY_WITH_SUBJECT: JourneyDeclaration = {
            journeyKey: 'verification',
            name: 'Verification',
            resources: [
                {
                    key: 'verify-room',
                    kind: 'textChannel',
                    defaultName: 'verify-me',
                    permissions: [{ audience: 'subject', access: 'readWrite' }],
                },
            ],
        };

        it('blocks a resource whose permission model cannot be satisfied', () => {
            // Without this the plan looks applicable and the apply fails partway
            // through, with earlier resources already created.
            const plan = buildInstallPlan({
                guild: makeGuild(),
                journey: JOURNEY_WITH_SUBJECT,
                existingBindings: [],
                permissionContext: { staffRoleIds: ['role-staff'] },
            });

            const item = itemFor(plan.items, 'verify-room');
            expect(item.action).toBe('blocked');
            expect(item.reason).toMatch(/names the member/i);
            expect(isPlanApplicable(plan)).toBe(false);
        });

        it('plans a staff-only channel without needing a subject', () => {
            // Staff is a guild fact known at install time, so this is installable
            // where a subject-scoped resource is not.
            const plan = buildInstallPlan({
                guild: makeGuild(),
                journey: {
                    journeyKey: 'staff-room',
                    name: 'Staff Room',
                    resources: [
                        {
                            key: 'back-office',
                            kind: 'textChannel',
                            defaultName: 'back-office',
                            permissions: [
                                { audience: 'everyone', access: 'hidden' },
                                { audience: 'staff', access: 'readWrite' },
                            ],
                        },
                    ],
                },
                existingBindings: [],
                permissionContext: { staffRoleIds: ['role-staff'] },
            });

            expect(itemFor(plan.items, 'back-office').action).toBe('create');
            expect(isPlanApplicable(plan)).toBe(true);
        });

        it('blocks a staff-scoped resource when no staff roles were supplied', () => {
            const plan = buildInstallPlan({
                guild: makeGuild(),
                journey: {
                    journeyKey: 'staff-room',
                    name: 'Staff Room',
                    resources: [
                        {
                            key: 'back-office',
                            kind: 'textChannel',
                            defaultName: 'back-office',
                            permissions: [{ audience: 'staff', access: 'readWrite' }],
                        },
                    ],
                },
                existingBindings: [],
                permissionContext: { staffRoleIds: [] },
            });

            expect(itemFor(plan.items, 'back-office').action).toBe('blocked');
            expect(itemFor(plan.items, 'back-office').reason).toMatch(/staff role/i);
        });

        it('allows it once the subject is supplied', () => {
            const plan = buildInstallPlan({
                guild: makeGuild(),
                journey: JOURNEY_WITH_SUBJECT,
                existingBindings: [],
                permissionContext: { subjectId: 'member-7', staffRoleIds: ['role-staff'] },
            });

            expect(itemFor(plan.items, 'verify-room').action).toBe('create');
        });

        it('skips the check when no permission context is supplied', () => {
            // A caller that cannot supply one gets the old behaviour rather than a
            // blocker it has no way to clear.
            const plan = buildInstallPlan({
                guild: makeGuild(),
                journey: JOURNEY_WITH_SUBJECT,
                existingBindings: [],
            });

            expect(itemFor(plan.items, 'verify-room').action).toBe('create');
        });
    });

    describe('capability preflight', () => {
        it('blocks the whole plan when Manage Channels is missing', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({ permissions: [PermissionFlagsBits.ManageRoles] }),
                journey: JOURNEY,
                existingBindings: [],
            });

            expect(plan.blockers.join(' ')).toMatch(/Manage Channels/);
            expect(isPlanApplicable(plan)).toBe(false);
        });

        it('blocks when Manage Roles is missing and the journey declares a role', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({ permissions: [PermissionFlagsBits.ManageChannels] }),
                journey: JOURNEY,
                existingBindings: [],
            });

            expect(plan.blockers.join(' ')).toMatch(/Manage Roles/);
        });

        it('reports a role hierarchy problem in the plan rather than at apply time', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({ botRolePosition: 0 }),
                journey: JOURNEY,
                existingBindings: [],
            });

            expect(plan.blockers.join(' ')).toMatch(/bottom of the role list/i);
        });

        it('does not demand Manage Roles for a journey with no roles', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({ permissions: [PermissionFlagsBits.ManageChannels] }),
                journey: { ...JOURNEY, resources: [JOURNEY.resources[0]] },
                existingBindings: [],
            });

            expect(plan.blockers).toHaveLength(0);
        });

        it('refuses to plan at all when the bot member is not cached', () => {
            const plan = buildInstallPlan({
                guild: makeGuild({ botCached: false }),
                journey: JOURNEY,
                existingBindings: [],
            });

            expect(plan.blockers.join(' ')).toMatch(/not cached/i);
        });
    });
});
