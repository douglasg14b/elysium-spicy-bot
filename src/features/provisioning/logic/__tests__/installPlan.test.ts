import { ChannelType, PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ButtonListener } from '../../buttonListeners';
import type { ResourceBindingEntity } from '../../data/resourceBindingsSchema';
import { buildInstallPlan, isPlanApplicable, type PlanItem } from '../installPlan';
import type { MessagePresence } from '../lookupBoundMessage';
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
    // Each channel grants the bot what the server does: no overwrites. A channel's own
    // overwrites are exercised against TestDiscord in `provisioningMessage.integration.test.ts`.
    const channelMap = new Map(
        channels.map((channel) => [
            channel.id,
            { ...channel, permissionsFor: () => ({ has: (flag: bigint) => permissions.includes(flag) }) },
        ])
    );
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

    describe('an install interrupted between creating and recording', () => {
        // The intent row is written before the create is sent, so the object an
        // interrupted install made is the same-named one created *after* the row.
        const INTENT_AT = new Date('2026-09-27T12:00:00Z');
        const idCreatedAt = (msFromIntent: number): string =>
            SnowflakeUtil.generate({ timestamp: INTENT_AT.getTime() + msFromIntent }).toString();
        const intent = binding({ state: 'intended', discordId: null, createdAt: INTENT_AT });

        function planWith(channels: FakeChannel[], boundInGuild?: ReadonlySet<string>) {
            return buildInstallPlan({
                guild: makeGuild({ channels }),
                journey: JOURNEY,
                existingBindings: [intent],
                boundInGuild,
            });
        }

        it('recovers the one object made after the intent, rather than offering it for adoption', () => {
            const made = idCreatedAt(200);
            const welcome = itemFor(
                planWith([{ id: made, name: 'welcome', type: ChannelType.GuildText }]).items,
                'welcome-channel'
            );

            expect(welcome.action).toBe('recover');
            expect(welcome.discordId).toBe(made);
        });

        it('does not recover a same-named object that predates the intent', () => {
            // Made by hand before the install ever ran: a name collision, not ours.
            const theirs = idCreatedAt(-60_000);
            const welcome = itemFor(
                planWith([{ id: theirs, name: 'welcome', type: ChannelType.GuildText }]).items,
                'welcome-channel'
            );

            expect(welcome.action).toBe('blocked');
            expect(welcome.reason).toMatch(/already exists/i);
        });

        it('does not recover a same-named object made long after the intent', () => {
            // The intent's install died before sending anything; the operator made the
            // channel by hand days later. Recovering it would hand it to uninstall.
            const handMade = idCreatedAt(3 * 24 * 60 * 60_000);
            const welcome = itemFor(
                planWith([{ id: handMade, name: 'welcome', type: ChannelType.GuildText }]).items,
                'welcome-channel'
            );

            expect(welcome.action).toBe('blocked');
            expect(welcome.reason).toMatch(/already exists/i);
        });

        it('adopts rather than recovers when the operator names the object to adopt', () => {
            const made = idCreatedAt(200);
            const plan = buildInstallPlan({
                guild: makeGuild({ channels: [{ id: made, name: 'welcome', type: ChannelType.GuildText }] }),
                journey: JOURNEY,
                existingBindings: [intent],
                choices: { 'welcome-channel': { adoptDiscordId: made } },
            });

            expect(itemFor(plan.items, 'welcome-channel')).toMatchObject({ action: 'adopt', discordId: made });
        });

        it('does not recover an object another journey has bound', () => {
            // Recovering it would hand this journey's uninstall another journey's channel.
            const othersChannel = idCreatedAt(200);
            const welcome = itemFor(
                planWith(
                    [{ id: othersChannel, name: 'welcome', type: ChannelType.GuildText }],
                    new Set([othersChannel])
                ).items,
                'welcome-channel'
            );

            expect(welcome.action).toBe('blocked');
        });

        it('asks rather than guesses when several were made since', () => {
            const plan = planWith([
                { id: idCreatedAt(200), name: 'welcome', type: ChannelType.GuildText },
                { id: idCreatedAt(400), name: 'welcome', type: ChannelType.GuildText },
            ]);

            const welcome = itemFor(plan.items, 'welcome-channel');
            expect(welcome.action).toBe('blocked');
            expect(welcome.reason).toMatch(/2 channels of that name have been made since/);
            expect(isPlanApplicable(plan)).toBe(false);
        });
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

/**
 * A declared ticket type, planned by its key against the ticket settings the provider
 * read. Never against the guild cache, and never by name.
 */
describe('buildInstallPlan for a ticket type', () => {
    const SETTINGS = {
        nameTemplate: 'verify-{{####}}',
        permissions: {
            subject: { view: true, send: true, readHistory: true, manageMessages: false },
            opener: { view: true, send: true, readHistory: true, manageMessages: false },
            staff: { view: true, send: true, readHistory: true, manageMessages: true },
        },
        autoClaimOnOpen: false,
    };

    const TYPE_JOURNEY: JourneyDeclaration = {
        journeyKey: 'onboarding',
        name: 'Onboarding',
        resources: [{ key: 'verification', kind: 'ticketType', defaultName: 'Verify me', ticketType: SETTINGS }],
    };

    function reading(types: Record<string, string>, notReadyNote: string | null = null) {
        return {
            status: 'ok' as const,
            ready: notReadyNote === null,
            notReadyNote,
            types: new Map(Object.entries(types).map(([key, label]) => [key, { label }])),
        };
    }

    const typeRow = binding({
        resourceKey: 'verification',
        kind: 'ticketType',
        state: 'adopted',
        discordId: 'verification',
        name: 'Verification',
        ownerKind: 'journey',
        ownerKey: 'onboarding',
    } as Partial<ResourceBindingEntity>);

    it('blocks the whole install, in the provider’s words, when there are no ticket settings', () => {
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: TYPE_JOURNEY,
            existingBindings: [],
            ticketTypes: { status: 'no-config', blockedReason: 'No ticket settings here.' },
        });

        expect(plan.items[0]).toMatchObject({ action: 'blocked', reason: 'No ticket settings here.' });
        expect(isPlanApplicable(plan)).toBe(false);
    });

    it('adopts a type that is already there, under its own label, and says it is used as it is', () => {
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: TYPE_JOURNEY,
            existingBindings: [],
            ticketTypes: reading({ verification: 'Verification' }),
        });

        expect(plan.items[0]).toMatchObject({
            action: 'adopt',
            discordId: 'verification',
            name: 'Verification',
        });
        expect(plan.items[0]?.reason).toMatch(/used as it is/);
    });

    it('reuses a type this journey already recorded', () => {
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: TYPE_JOURNEY,
            existingBindings: [typeRow],
            ticketTypes: reading({ verification: 'Verification' }),
        });

        expect(plan.items[0]).toMatchObject({ action: 'reuse', discordId: 'verification' });
    });

    it('creates a missing type, and says so when this journey had it before', () => {
        const fresh = buildInstallPlan({
            guild: makeGuild(),
            journey: TYPE_JOURNEY,
            existingBindings: [],
            ticketTypes: reading({}),
        });
        expect(fresh.items[0]).toEqual({ resourceKey: 'verification', kind: 'ticketType', name: 'Verify me', parentKey: undefined, action: 'create' });

        const again = buildInstallPlan({
            guild: makeGuild(),
            journey: TYPE_JOURNEY,
            existingBindings: [typeRow],
            ticketTypes: reading({}),
        });
        expect(again.items[0]).toMatchObject({ action: 'create' });
        expect(again.items[0]?.reason).toMatch(/removed .* made again/);
    });

    it('carries the not-set-up note on every ticket type item, and still applies', () => {
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: TYPE_JOURNEY,
            existingBindings: [],
            ticketTypes: reading({}, 'Not set up yet.'),
        });

        expect(plan.items[0]).toMatchObject({ action: 'create', note: 'Not set up yet.' });
        expect(isPlanApplicable(plan)).toBe(true);
    });

    it('asks nothing of the bot’s channel or role permissions for a type', () => {
        const plan = buildInstallPlan({
            guild: makeGuild({ permissions: [] }),
            journey: TYPE_JOURNEY,
            existingBindings: [],
            ticketTypes: reading({}),
        });

        expect(plan.blockers).toEqual([]);
    });

    it('blocks a type over a row of another kind under the same key, rather than forgetting it', () => {
        const plan = buildInstallPlan({
            guild: makeGuild(),
            journey: TYPE_JOURNEY,
            existingBindings: [binding({ resourceKey: 'verification', kind: 'textChannel', discordId: 'chan-1' })],
            ticketTypes: reading({ verification: 'Verification' }),
        });

        expect(plan.items[0]).toMatchObject({ action: 'blocked' });
        expect(plan.items[0]?.reason).toMatch(/still holds a channel/);
    });

    it('throws when a journey declares a type and nobody read the ticket settings', () => {
        expect(() =>
            buildInstallPlan({ guild: makeGuild(), journey: TYPE_JOURNEY, existingBindings: [] })
        ).toThrow(/without reading the server's ticket types/);
    });
});

/**
 * A declared message, planned from whether what this journey posted is still there — read
 * from Discord by the service and handed in — never from the guild's cache.
 */
describe('buildInstallPlan for a message', () => {
    const POSTING = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
    ];
    const UPLOAD = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const RULES = { id: 'chan-rules', name: 'rules', type: ChannelType.GuildText };
    const ELSEWHERE = { id: 'chan-elsewhere', name: 'verify', type: ChannelType.GuildText };

    function messageJourney(overrides: Partial<JourneyDeclaration['resources'][number]> = {}): JourneyDeclaration {
        return {
            journeyKey: 'onboarding',
            name: 'Onboarding',
            resources: [
                // Named apart from `#rules` in the cache, which would otherwise block on the name.
                { key: 'rules', kind: 'textChannel', defaultName: 'house-rules' },
                {
                    key: 'rules-panel',
                    kind: 'message',
                    defaultName: 'Rules panel',
                    parentKey: 'rules',
                    message: { embeds: [{ title: 'House rules' }] },
                    ...overrides,
                },
            ],
        };
    }

    const channelRow = binding({ resourceKey: 'rules', discordId: RULES.id, name: 'rules' });
    const postedRow = binding({
        resourceKey: 'rules-panel',
        kind: 'message',
        discordId: 'msg-1',
        name: 'Rules panel',
        messageChannelId: RULES.id,
        messageDigest: 'digest',
    });

    function plan(input: {
        readonly journey?: JourneyDeclaration;
        readonly bindings?: readonly ResourceBindingEntity[];
        readonly presence?: MessagePresence;
        readonly permissions?: bigint[];
        readonly uploadSizes?: ReadonlyMap<string, number>;
        readonly botCached?: boolean;
        readonly buttonListeners?: readonly ButtonListener[];
    }) {
        return buildInstallPlan({
            guild: makeGuild({
                channels: [RULES, ELSEWHERE],
                permissions: input.permissions ?? [PermissionFlagsBits.ManageChannels, ...POSTING],
                botCached: input.botCached,
            }),
            journey: input.journey ?? messageJourney(),
            existingBindings: input.bindings ?? [],
            messagePresence: input.presence ? new Map([['rules-panel', input.presence]]) : new Map(),
            uploadSizes: input.uploadSizes,
            buttonListeners: input.buttonListeners ?? [],
        });
    }

    /** A trigger of flow `flowName` listening to `buttonKey` of the rules panel. */
    function listener(flowName: string, buttonKey: string, messageKey = 'rules-panel'): ButtonListener {
        return { messageKey, buttonKey, flowId: `flow-${flowName}`, flowName, nodeId: 'trigger', enabled: false };
    }

    it('posts a message never posted, after its channel', () => {
        const built = plan({});

        expect(built.items.map((item) => item.resourceKey)).toEqual(['rules', 'rules-panel']);
        expect(itemFor(built.items, 'rules-panel')).toEqual({
            resourceKey: 'rules-panel',
            kind: 'message',
            name: 'Rules panel',
            parentKey: 'rules',
            action: 'create',
        });
        expect(isPlanApplicable(built)).toBe(true);
    });

    it('blocks a message with no channel picked', () => {
        const built = plan({ journey: messageJourney({ parentKey: undefined }) });

        expect(itemFor(built.items, 'rules-panel')).toMatchObject({ action: 'blocked', reason: 'Pick the channel it goes in.' });
    });

    it('reuses a posted message still in the channel the journey names, and never edits it', () => {
        const built = plan({ bindings: [channelRow, postedRow], presence: 'found' });

        expect(itemFor(built.items, 'rules')).toMatchObject({ action: 'reuse', discordId: RULES.id });
        expect(itemFor(built.items, 'rules-panel')).toMatchObject({ action: 'reuse', discordId: 'msg-1' });
    });

    it('posts again, saying so, when the message it posted is gone', () => {
        const built = plan({ bindings: [channelRow, postedRow], presence: 'gone' });

        expect(itemFor(built.items, 'rules-panel')).toMatchObject({
            action: 'create',
            reason: 'The message this journey posted no longer exists, so it will be posted again.',
        });
    });

    it('blocks, naming the channel and why, when the message could not be read', () => {
        const built = plan({ bindings: [channelRow, postedRow], presence: { unreadable: "the bot can't even see it" } });

        expect(itemFor(built.items, 'rules-panel')).toMatchObject({
            action: 'blocked',
            reason: "Couldn't check it in #rules: the bot can't even see it.",
        });
    });

    it('blocks a posted message whose channel the journey now names differently, since Discord cannot move it', () => {
        const moved = binding({ ...postedRow, messageChannelId: ELSEWHERE.id });

        const built = plan({ bindings: [channelRow, moved], presence: 'found' });

        expect(itemFor(built.items, 'rules-panel')).toMatchObject({
            action: 'blocked',
            reason: "It's posted in #verify, but this journey now puts it in another channel. Discord can't move a message: delete it there and install again.",
        });
    });

    it('blocks a posted message whose channel this install would create, as a move', () => {
        // The channel's own row is gone, so the plan makes a new one; the message sits in the old.
        const built = plan({ bindings: [postedRow], presence: 'found' });

        expect(itemFor(built.items, 'rules')).toMatchObject({ action: 'create' });
        expect(itemFor(built.items, 'rules-panel')).toMatchObject({ action: 'blocked' });
        expect(itemFor(built.items, 'rules-panel').reason).toMatch(/Discord can't move a message/);
    });

    it('blocks a message Discord would refuse, naming the part', () => {
        const built = plan({ journey: messageJourney({ message: { embeds: [{}] } }) });

        expect(itemFor(built.items, 'rules-panel')).toMatchObject({ action: 'blocked' });
        expect(itemFor(built.items, 'rules-panel').reason).toMatch(/^"Rules panel" embed 1: /);
    });

    it('blocks a message showing an upload this server does not hold, naming the part', () => {
        const built = plan({
            journey: messageJourney({ message: { embeds: [{ title: 'Look', image: `upload:${UPLOAD}` }] } }),
            uploadSizes: new Map(),
        });

        expect(itemFor(built.items, 'rules-panel')).toMatchObject({ action: 'blocked' });
        expect(itemFor(built.items, 'rules-panel').reason).toMatch(
            /^"Rules panel" embed 1 image: That uploaded picture isn't in this server/
        );
    });

    it('posts a message showing an upload this server holds', () => {
        const built = plan({
            journey: messageJourney({ message: { embeds: [{ title: 'Look', image: `upload:${UPLOAD}` }] } }),
            uploadSizes: new Map([[UPLOAD, 1024]]),
        });

        expect(itemFor(built.items, 'rules-panel')).toMatchObject({ action: 'create' });
    });

    it('notes, by label, only the buttons no flow listens to — a switched-off flow counts as listening', () => {
        const buttons = [
            { key: 'agree', label: 'I agree', style: 'Success' as const },
            { key: 'nope', label: 'Nope', style: 'Danger' as const },
            { key: 'kinks', label: 'Kinks', style: 'Primary' as const },
        ];
        // `agree` is heard (by an off flow); `kinks` is named only on another message.
        const listeners = [listener('Welcome', 'agree'), listener('Elsewhere', 'kinks', 'other-panel')];

        const fresh = plan({ journey: messageJourney({ buttons }), buttonListeners: listeners });
        const reused = plan({
            journey: messageJourney({ buttons }),
            bindings: [channelRow, postedRow],
            presence: 'found',
            buttonListeners: listeners,
        });

        for (const built of [fresh, reused]) {
            expect(itemFor(built.items, 'rules-panel').note).toBe(
                'Nobody listens to "Nope" or "Kinks" yet — a press answers "Nothing\'s hooked up to this yet".'
            );
        }
    });

    it('notes nothing when every button is heard, or there are none', () => {
        const buttons = [{ key: 'agree', label: 'I agree', style: 'Success' as const }];

        expect(itemFor(plan({ journey: messageJourney({ buttons }), buttonListeners: [listener('Welcome', 'agree')] }).items, 'rules-panel').note).toBeUndefined();
        expect(itemFor(plan({}).items, 'rules-panel').note).toBeUndefined();
    });

    it('names one unheard button alone', () => {
        const buttons = [{ key: 'agree', label: 'Verify', style: 'Success' as const }];

        expect(itemFor(plan({ journey: messageJourney({ buttons }) }).items, 'rules-panel').note).toBe(
            'Nobody listens to "Verify" yet — a press answers "Nothing\'s hooked up to this yet".'
        );
    });

    it('names three or more unheard buttons as a list ending in "or"', () => {
        const buttons = [
            { key: 'agree', label: 'Verify', style: 'Success' as const },
            { key: 'kinks', label: 'Kinks', style: 'Primary' as const },
            { key: 'limits', label: 'Limits', style: 'Secondary' as const },
        ];

        expect(itemFor(plan({ journey: messageJourney({ buttons }) }).items, 'rules-panel').note).toBe(
            'Nobody listens to "Verify", "Kinks" or "Limits" yet — a press answers "Nothing\'s hooked up to this yet".'
        );
    });

    it('refuses to plan a message with buttons without being told who listens to them', () => {
        const buttons = [{ key: 'agree', label: 'Verify', style: 'Success' as const }];

        expect(() =>
            buildInstallPlan({
                guild: makeGuild({ channels: [RULES], permissions: [PermissionFlagsBits.ManageChannels, ...POSTING] }),
                journey: messageJourney({ buttons }),
                existingBindings: [],
                messagePresence: new Map(),
            })
        ).toThrow(/without reading who listens to them/);
    });

    it('blocks a message over a row of another kind under its key, rather than forgetting it', () => {
        const built = plan({ bindings: [binding({ resourceKey: 'rules-panel', kind: 'role', discordId: 'role-1' })] });

        expect(itemFor(built.items, 'rules-panel')).toMatchObject({ action: 'blocked' });
        expect(itemFor(built.items, 'rules-panel').reason).toMatch(/still holds a role under the key "rules-panel"/);
    });

    it('blocks a channel declared under a key that still holds a posted message, rather than taking its row', () => {
        const journey: JourneyDeclaration = {
            journeyKey: 'onboarding',
            name: 'Onboarding',
            resources: [{ key: 'rules-panel', kind: 'textChannel', defaultName: 'panel' }],
        };

        const built = plan({ journey, bindings: [postedRow] });

        expect(itemFor(built.items, 'rules-panel')).toMatchObject({ action: 'blocked' });
        expect(itemFor(built.items, 'rules-panel').reason).toMatch(/still holds a message under the key "rules-panel"/);
    });

    it('blocks the whole install when the bot cannot post, embed or read back', () => {
        const built = plan({ permissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages] });

        expect(built.blockers).toEqual([
            "The bot lacks **Embed Links** and **Read Message History**, which this journey needs to post its messages and check they're still there.",
        ]);
        expect(isPlanApplicable(built)).toBe(false);
    });

    it('asks for Attach Files only when a message shows an upload', () => {
        const withoutAttach = [
            PermissionFlagsBits.ManageChannels,
            ...POSTING.filter((flag) => flag !== PermissionFlagsBits.AttachFiles),
        ];

        expect(plan({ permissions: withoutAttach }).blockers).toEqual([]);
        expect(
            plan({
                permissions: withoutAttach,
                journey: messageJourney({ message: { embeds: [{ title: 'Look', image: `upload:${UPLOAD}` }] } }),
                uploadSizes: new Map([[UPLOAD, 1024]]),
            }).blockers
        ).toEqual(['The bot lacks **Attach Files**, which this journey needs to post the pictures uploaded for its messages.']);
    });

    it("says it couldn't see the bot itself, rather than naming permissions, when reposting into a channel with no bot member", () => {
        const built = plan({ bindings: [channelRow, postedRow], presence: 'gone', botCached: false });

        expect(itemFor(built.items, 'rules-panel')).toMatchObject({
            action: 'blocked',
            reason: "Couldn't see the bot's own member, so whether it can post in #rules can't be checked. Try again in a moment.",
        });
    });

    it('throws when a posted message was planned without checking whether it is still there', () => {
        expect(() =>
            buildInstallPlan({
                guild: makeGuild({ channels: [RULES], permissions: [PermissionFlagsBits.ManageChannels, ...POSTING] }),
                journey: messageJourney(),
                existingBindings: [channelRow, postedRow],
            })
        ).toThrow(/without checking whether it is still there/);
    });
});
