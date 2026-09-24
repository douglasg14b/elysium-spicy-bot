import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ResourceBindingEntity } from '../../data/resourceBindingsSchema';
import { buildJourneyDriftPlan } from '../journeyDriftPlan';
import type { JourneyDeclaration, ResourceDeclaration } from '../resourceDeclaration';

/**
 * The guild-reading half of drift. The comparison rules themselves live in
 * `resourceDrift.test.ts`; what is checked here is what this module decides *not* to
 * report, which is where its judgement is:
 *
 *  - a binding whose object is gone (install's subject, not drift's)
 *  - a binding whose key the journey no longer declares (teardown's subject)
 *  - a declared parent that is not bound yet (not comparable)
 */

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const THREADS = PermissionFlagsBits.SendMessagesInThreads;
const REACT = PermissionFlagsBits.AddReactions;

const BOT_ID = 'bot-member';
const EVERYONE = 'guild-1';
const STAFF_ROLE = 'role-staff';

interface FakeOverwrite {
    readonly id: string;
    readonly allow: bigint;
    readonly deny: bigint;
}

interface FakeChannel {
    readonly id: string;
    readonly name: string;
    readonly type: ChannelType;
    readonly parentId: string | null;
    readonly overwrites?: readonly FakeOverwrite[];
}

interface FakeRole {
    readonly id: string;
    readonly name: string;
}

function textChannel(
    id: string,
    name: string,
    parentId: string | null = null,
    overwrites: readonly FakeOverwrite[] = []
): FakeChannel {
    return { id, name, type: ChannelType.GuildText, parentId, overwrites };
}

function category(id: string, name: string): FakeChannel {
    return { id, name, type: ChannelType.GuildCategory, parentId: null };
}

/** Combine bits the way Discord stores them, as one field per overwrite. */
function bitsOf(...flags: bigint[]): bigint {
    return flags.reduce((combined, flag) => combined | flag, 0n);
}

function makeGuild(
    channels: readonly FakeChannel[] = [],
    roles: readonly FakeRole[] = []
): Guild {
    const channelById = new Map(channels.map((channel) => [channel.id, channel] as const));
    const roleById = new Map(roles.map((role) => [role.id, role] as const));

    const withOverwrites = (channel: FakeChannel) => ({
        ...channel,
        permissionOverwrites: {
            cache: {
                map: <TMapped,>(
                    mapper: (overwrite: {
                        id: string;
                        allow: { bitfield: bigint };
                        deny: { bitfield: bigint };
                    }) => TMapped
                ) =>
                    (channel.overwrites ?? []).map((overwrite) =>
                        mapper({
                            id: overwrite.id,
                            allow: { bitfield: overwrite.allow },
                            deny: { bitfield: overwrite.deny },
                        })
                    ),
            },
        },
    });

    return {
        id: 'guild-1',
        name: 'Test Guild',
        channels: {
            cache: {
                get: (id: string) => {
                    const channel = channelById.get(id);
                    return channel ? withOverwrites(channel) : undefined;
                },
            },
        },
        roles: {
            cache: {
                get: (id: string) => roleById.get(id),
                has: (id: string) => roleById.has(id),
            },
            everyone: { id: EVERYONE },
        },
        members: { me: { id: BOT_ID } },
    } as never;
}

let nextBindingId = 1;

function binding(overrides: Partial<ResourceBindingEntity> = {}): ResourceBindingEntity {
    return {
        id: nextBindingId++,
        guildId: 'guild-1',
        journeyKey: 'journey-1',
        resourceKey: 'welcome-channel',
        kind: 'textChannel',
        state: 'created',
        discordId: 'channel-1',
        name: 'welcome',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as ResourceBindingEntity;
}

function journey(resources: readonly ResourceDeclaration[]): JourneyDeclaration {
    return { journeyKey: 'journey-1', name: 'Journey One', resources } as JourneyDeclaration;
}

const permissionContext = { staffRoleIds: [STAFF_ROLE] } as const;

describe('buildJourneyDriftPlan', () => {
    it('reports a clean journey with nothing drifted', () => {
        const plan = buildJourneyDriftPlan({
            guild: makeGuild([textChannel('channel-1', 'welcome')]),
            journey: journey([
                { key: 'welcome-channel', kind: 'textChannel', defaultName: 'welcome' },
            ]),
            bindings: [binding()],
            permissionContext,
        });

        expect(plan.drifted).toEqual([]);
        expect(plan.cleanKeys).toEqual(['welcome-channel']);
    });

    it('reports a renamed channel', () => {
        const plan = buildJourneyDriftPlan({
            guild: makeGuild([textChannel('channel-1', 'lobby')]),
            journey: journey([
                { key: 'welcome-channel', kind: 'textChannel', defaultName: 'welcome' },
            ]),
            bindings: [binding()],
            permissionContext,
        });

        expect(plan.drifted).toHaveLength(1);
        expect(plan.drifted[0]?.drift).toEqual([
            { kind: 'renamed', declared: 'welcome', actual: 'lobby' },
        ]);
        expect(plan.cleanKeys).toEqual([]);
    });

    /**
     * `buildInstallPlan` already detects this and plans a recreate, naming it in the
     * item's reason. Reporting it here too would give the operator two surfaces for
     * one situation and two buttons that appear to differ.
     */
    it('does not report a binding whose object is gone — that is install\'s subject', () => {
        const plan = buildJourneyDriftPlan({
            guild: makeGuild([]),
            journey: journey([
                { key: 'welcome-channel', kind: 'textChannel', defaultName: 'welcome' },
            ]),
            bindings: [binding()],
            permissionContext,
        });

        expect(plan.drifted).toEqual([]);
        expect(plan.cleanKeys).toEqual([]);
    });

    it('does not report a resource that was never installed', () => {
        const plan = buildJourneyDriftPlan({
            guild: makeGuild([]),
            journey: journey([
                { key: 'welcome-channel', kind: 'textChannel', defaultName: 'welcome' },
            ]),
            bindings: [],
            permissionContext,
        });

        expect(plan.drifted).toEqual([]);
        expect(plan.cleanKeys).toEqual([]);
    });

    it('does not report an intended binding that never reached the guild', () => {
        const plan = buildJourneyDriftPlan({
            guild: makeGuild([textChannel('channel-1', 'something-else')]),
            journey: journey([
                { key: 'welcome-channel', kind: 'textChannel', defaultName: 'welcome' },
            ]),
            bindings: [binding({ state: 'intended' })],
            permissionContext,
        });

        expect(plan.drifted).toEqual([]);
    });

    /**
     * An orphan — the resource was removed from the panel while its Discord object
     * still exists. Repairing it toward a declaration that no longer exists is
     * meaningless; it is a teardown question and belongs to that surface.
     */
    it('skips a binding whose key the journey no longer declares', () => {
        const plan = buildJourneyDriftPlan({
            guild: makeGuild([textChannel('channel-9', 'abandoned')]),
            journey: journey([]),
            bindings: [binding({ resourceKey: 'removed-channel', discordId: 'channel-9' })],
            permissionContext,
        });

        expect(plan.drifted).toEqual([]);
        expect(plan.cleanKeys).toEqual([]);
    });

    describe('parents', () => {
        it('reports a channel dragged out of its declared category', () => {
            const plan = buildJourneyDriftPlan({
                guild: makeGuild([
                    category('category-1', 'Journey'),
                    textChannel('channel-1', 'welcome', null),
                ]),
                journey: journey([
                    { key: 'journey-category', kind: 'category', defaultName: 'Journey' },
                    {
                        key: 'welcome-channel',
                        kind: 'textChannel',
                        defaultName: 'welcome',
                        parentKey: 'journey-category',
                    },
                ]),
                bindings: [
                    binding({
                        resourceKey: 'journey-category',
                        kind: 'category',
                        discordId: 'category-1',
                        name: 'Journey',
                    }),
                    binding(),
                ],
                permissionContext,
            });

            expect(plan.drifted).toHaveLength(1);
            expect(plan.drifted[0]?.drift).toEqual([
                { kind: 'reparented', declaredParentId: 'category-1', actualParentId: null },
            ]);
        });

        it('does not compare a parent that has no binding yet', () => {
            const plan = buildJourneyDriftPlan({
                guild: makeGuild([textChannel('channel-1', 'welcome', null)]),
                journey: journey([
                    { key: 'journey-category', kind: 'category', defaultName: 'Journey' },
                    {
                        key: 'welcome-channel',
                        kind: 'textChannel',
                        defaultName: 'welcome',
                        parentKey: 'journey-category',
                    },
                ]),
                bindings: [binding()],
                permissionContext,
            });

            expect(plan.drifted).toEqual([]);
        });
    });

    describe('permissions', () => {
        const staffOnly: ResourceDeclaration = {
            key: 'welcome-channel',
            kind: 'textChannel',
            defaultName: 'welcome',
            permissions: [
                { audience: 'everyone', access: 'hidden' },
                { audience: 'roles', access: 'readWrite', roleIds: [STAFF_ROLE] },
            ],
        };

        const roles = [{ id: STAFF_ROLE, name: 'Staff' }];

        it('reports nothing when the live overwrites still satisfy the declaration', () => {
            const plan = buildJourneyDriftPlan({
                guild: makeGuild(
                    [
                        textChannel('channel-1', 'welcome', null, [
                            { id: EVERYONE, allow: 0n, deny: VIEW },
                            {
                                id: STAFF_ROLE,
                                allow: bitsOf(VIEW, SEND, THREADS, REACT),
                                deny: 0n,
                            },
                        ]),
                    ],
                    roles
                ),
                journey: journey([staffOnly]),
                bindings: [binding()],
                permissionContext,
            });

            expect(plan.drifted).toEqual([]);
        });

        /** The case the whole feature exists for: a staff-only channel gone public. */
        it('reports a staff-only channel whose everyone-deny was removed', () => {
            const plan = buildJourneyDriftPlan({
                guild: makeGuild(
                    [
                        textChannel('channel-1', 'welcome', null, [
                            { id: EVERYONE, allow: 0n, deny: 0n },
                            {
                                id: STAFF_ROLE,
                                allow: bitsOf(VIEW, SEND, THREADS, REACT),
                                deny: 0n,
                            },
                        ]),
                    ],
                    roles
                ),
                journey: journey([staffOnly]),
                bindings: [binding()],
                permissionContext,
            });

            expect(plan.drifted).toHaveLength(1);
            const drift = plan.drifted[0]?.drift[0];
            expect(drift?.kind).toBe('permissions');
            expect(drift).toMatchObject({
                differences: [{ id: EVERYONE, missingDeny: [String(VIEW)] }],
            });
        });

        /**
         * A `subject` audience names a per-run member and cannot compile while
         * provisioning shared structure. Reported as a stated skip rather than as
         * clean — a false clean here is a privacy failure.
         */
        /**
         * A permission may name a role **this journey creates**, via the `resource:`
         * prefix. `applyInstallPlan` resolves those against the ids it just created
         * before compiling; drift has the same information in its bindings and must do
         * the same.
         *
         * Without it, `audienceToIds` finds `resource:in-approval` absent from the role
         * cache and throws, so the resource lands in `unchecked` blaming a `subject`
         * audience that is not involved. That is the *most* security-sensitive shape
         * there is — "this room is visible only to the role this journey creates" —
         * going permanently unchecked, with a misleading reason.
         */
        it('resolves a permission naming a role this journey declares', () => {
            const plan = buildJourneyDriftPlan({
                guild: makeGuild(
                    [
                        textChannel('channel-1', 'welcome', null, [
                            { id: EVERYONE, allow: 0n, deny: VIEW },
                            {
                                id: 'role-created',
                                allow: bitsOf(VIEW, SEND, THREADS, REACT),
                                deny: 0n,
                            },
                        ]),
                    ],
                    [{ id: 'role-created', name: 'In Approval' }]
                ),
                journey: journey([
                    { key: 'approval-role', kind: 'role', defaultName: 'In Approval' },
                    {
                        key: 'welcome-channel',
                        kind: 'textChannel',
                        defaultName: 'welcome',
                        permissions: [
                            { audience: 'everyone', access: 'hidden' },
                            {
                                audience: 'roles',
                                access: 'readWrite',
                                roleIds: ['resource:approval-role'],
                            },
                        ],
                    },
                ]),
                bindings: [
                    binding({
                        resourceKey: 'approval-role',
                        kind: 'role',
                        discordId: 'role-created',
                        name: 'In Approval',
                    }),
                    binding(),
                ],
                permissionContext,
            });

            // Compared, not skipped — and the live overwrites satisfy the declaration.
            expect(plan.unchecked).toEqual([]);
            expect(plan.drifted).toEqual([]);
            expect(plan.cleanKeys).toContain('welcome-channel');
        });

        /**
         * The false-clean this feature exists to prevent. An unchecked staff-only
         * channel reported as clean is a system certifying privacy it never verified,
         * so `unchecked` is a third answer rather than a rounding of the other two.
         */
        it('reports a declaration it could not compile as unchecked, not clean', () => {
            const plan = buildJourneyDriftPlan({
                guild: makeGuild([textChannel('channel-1', 'welcome')], roles),
                journey: journey([
                    {
                        key: 'welcome-channel',
                        kind: 'textChannel',
                        defaultName: 'welcome',
                        permissions: [{ audience: 'subject', access: 'readWrite' }],
                    },
                ]),
                bindings: [binding()],
                permissionContext,
            });

            expect(plan.drifted).toEqual([]);
            expect(plan.cleanKeys).toEqual([]);
            expect(plan.unchecked).toEqual([
                {
                    resourceKey: 'welcome-channel',
                    name: 'welcome',
                    reason: expect.stringContaining('subject'),
                },
            ]);
        });

        /**
         * The two questions are independent. A resource renamed *and* carrying an
         * uncompilable intent has to appear in both lists — a single if/else chain
         * would drop whichever it tested second.
         */
        it('reports a resource that both drifted and went unchecked in both lists', () => {
            const plan = buildJourneyDriftPlan({
                guild: makeGuild([textChannel('channel-1', 'renamed')], roles),
                journey: journey([
                    {
                        key: 'welcome-channel',
                        kind: 'textChannel',
                        defaultName: 'welcome',
                        permissions: [{ audience: 'subject', access: 'readWrite' }],
                    },
                ]),
                bindings: [binding()],
                permissionContext,
            });

            expect(plan.drifted).toHaveLength(1);
            expect(plan.unchecked).toHaveLength(1);
            expect(plan.cleanKeys).toEqual([]);
        });
    });

    describe('the adoption promise', () => {
        it('detects drift on an adopted resource but marks it unrepairable', () => {
            const plan = buildJourneyDriftPlan({
                guild: makeGuild([textChannel('channel-1', 'renamed-by-hand')]),
                journey: journey([
                    { key: 'welcome-channel', kind: 'textChannel', defaultName: 'welcome' },
                ]),
                bindings: [binding({ state: 'adopted' })],
                permissionContext,
            });

            expect(plan.drifted).toHaveLength(1);
            expect(plan.drifted[0]?.repairable).toBe(false);
        });
    });

    it('reports a binding that now points at a different kind of object', () => {
        const plan = buildJourneyDriftPlan({
            guild: makeGuild([category('channel-1', 'welcome')]),
            journey: journey([
                { key: 'welcome-channel', kind: 'textChannel', defaultName: 'welcome' },
            ]),
            bindings: [binding()],
            permissionContext,
        });

        expect(plan.drifted[0]?.drift).toEqual([
            { kind: 'wrongType', declared: 'textChannel', actual: 'category' },
        ]);
    });
});
