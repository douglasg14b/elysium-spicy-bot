import { describe, expect, it } from 'vitest';
import { declaredRoleReference } from '../declaredRoleReference';
import {
    ResourceDeclarationError,
    assertInstallable,
    orderResourcesForApply,
    validateJourneyDeclaration,
    type JourneyDeclaration,
    type ResourceDeclaration,
} from '../resourceDeclaration';

/**
 * Declaration validation, which runs before anything touches the guild.
 *
 * Every rejection here is one that would otherwise surface mid-apply with resources
 * already created — the half-applied state the whole crash-safety design exists to
 * avoid. Catching it up front is far cheaper than unwinding.
 */

function journey(resources: ResourceDeclaration[]): JourneyDeclaration {
    return { journeyKey: 'onboarding', name: 'Onboarding', resources };
}

describe('validateJourneyDeclaration', () => {
    it('accepts a category with a child channel and a standalone role', () => {
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'cat', kind: 'category', defaultName: 'Arrivals' },
                    { key: 'chan', kind: 'textChannel', defaultName: 'welcome', parentKey: 'cat' },
                    { key: 'role', kind: 'role', defaultName: 'Verified' },
                ])
            )
        ).not.toThrow();
    });

    /**
     * An empty journey is coherent, and storing one is legitimate — it is what grouping
     * two flows that declare nothing yet produces, and what every journey looks like the
     * moment before its first resource. This used to throw, which meant
     * `journeysRepo.create` refused to group two empty flows at all. The rule moved to
     * {@link assertInstallable}; see the test below it.
     */
    it('accepts a journey declaring nothing — storing one is not installing one', () => {
        expect(() => validateJourneyDeclaration(journey([]))).not.toThrow();
    });

    it('refuses to install a journey declaring nothing', () => {
        // The rule the emptiness check was always about, now asked where it is true.
        expect(() => assertInstallable(journey([]))).toThrow(ResourceDeclarationError);
    });

    it('allows installing a journey that declares something', () => {
        expect(() =>
            assertInstallable(journey([{ key: 'chan', kind: 'textChannel', defaultName: 'welcome' }]))
        ).not.toThrow();
    });

    it('rejects a duplicate resource key', () => {
        // A key must resolve to exactly one binding; the unique index would reject
        // the second insert mid-apply, after the first resource was already created.
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'chan', kind: 'textChannel', defaultName: 'welcome' },
                    { key: 'chan', kind: 'textChannel', defaultName: 'rules' },
                ])
            )
        ).toThrow(/more than once/i);
    });

    it('rejects a parent the journey does not declare', () => {
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'chan', kind: 'textChannel', defaultName: 'welcome', parentKey: 'ghost' },
                ])
            )
        ).toThrow(/does not declare/i);
    });

    it('rejects a parent that is not a category', () => {
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'other', kind: 'textChannel', defaultName: 'rules' },
                    { key: 'chan', kind: 'textChannel', defaultName: 'welcome', parentKey: 'other' },
                ])
            )
        ).toThrow(/Only a category can be a parent/i);
    });

    it('rejects a role with a parent', () => {
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'cat', kind: 'category', defaultName: 'Arrivals' },
                    { key: 'role', kind: 'role', defaultName: 'Verified', parentKey: 'cat' },
                ])
            )
        ).toThrow(/do not live under categories/i);
    });

    it('accepts a permission naming a role the journey declares', () => {
        // The case the whole feature exists for: "visible only to the role this
        // journey creates".
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'in-approval', kind: 'role', defaultName: 'In Approval' },
                    {
                        key: 'approval-room',
                        kind: 'textChannel',
                        defaultName: 'approval-room',
                        permissions: [
                            { audience: 'everyone', access: 'hidden' },
                            {
                                audience: 'roles',
                                roleIds: [declaredRoleReference('in-approval')],
                                access: 'readWrite',
                            },
                        ],
                    },
                ])
            )
        ).not.toThrow();
    });

    it('rejects a permission naming a role the journey does not declare', () => {
        // Without this, the unknown key survives to `compilePermissionIntents` and
        // throws mid-apply with channels already created.
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    {
                        key: 'approval-room',
                        kind: 'textChannel',
                        defaultName: 'approval-room',
                        permissions: [
                            {
                                audience: 'roles',
                                roleIds: [declaredRoleReference('ghost-role')],
                                access: 'readWrite',
                            },
                        ],
                    },
                ])
            )
        ).toThrow(/does not declare/i);
    });

    it('rejects a permission naming a declared resource that is not a role', () => {
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'lobby', kind: 'textChannel', defaultName: 'lobby' },
                    {
                        key: 'approval-room',
                        kind: 'textChannel',
                        defaultName: 'approval-room',
                        permissions: [
                            {
                                audience: 'roles',
                                roleIds: [declaredRoleReference('lobby')],
                                access: 'readWrite',
                            },
                        ],
                    },
                ])
            )
        ).toThrow(/Only a role can appear in a permission/i);
    });

    it('leaves a plain snowflake in roleIds alone', () => {
        // A real role id is not a reference and must not be checked against the
        // journey's own keys — most permissions name roles that already exist.
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    {
                        key: 'approval-room',
                        kind: 'textChannel',
                        defaultName: 'approval-room',
                        permissions: [
                            { audience: 'roles', roleIds: ['847263518290110'], access: 'readWrite' },
                        ],
                    },
                ])
            )
        ).not.toThrow();
    });

    it('rejects a category that names a parent', () => {
        // Categories do not nest in Discord, and `applyInstallPlan`'s category branch
        // creates with no `parent` argument — so this was accepted, stored, and
        // silently ignored. A field that looks like it does something and does not is
        // worse than a refusal.
        expect(() =>
            validateJourneyDeclaration(
                journey([
                    { key: 'outer', kind: 'category', defaultName: 'Outer' },
                    { key: 'inner', kind: 'category', defaultName: 'Inner', parentKey: 'outer' },
                ])
            )
        ).toThrow(/Categories do not nest/i);
    });

    describe('adopting something that already exists', () => {
        it('accepts a resource that adopts an existing channel', () => {
            expect(() =>
                validateJourneyDeclaration(
                    journey([
                        {
                            key: 'announce',
                            kind: 'textChannel',
                            defaultName: 'announcements',
                            adoptDiscordId: '100000000000000001',
                        },
                    ])
                )
            ).not.toThrow();
        });

        it('rejects two resources adopting the same guild object', () => {
            // One channel bound to two keys makes "which key owns this" ambiguous,
            // and nothing downstream can answer it — `buildInstallPlan` judges each
            // resource alone, so only a whole-journey check can catch this.
            expect(() =>
                validateJourneyDeclaration(
                    journey([
                        {
                            key: 'announce',
                            kind: 'textChannel',
                            defaultName: 'announcements',
                            adoptDiscordId: '100000000000000001',
                        },
                        {
                            key: 'news',
                            kind: 'textChannel',
                            defaultName: 'news',
                            adoptDiscordId: '100000000000000001',
                        },
                    ])
                )
            ).toThrow(/both adopt 100000000000000001/i);
        });

        it('allows two resources adopting different objects', () => {
            expect(() =>
                validateJourneyDeclaration(
                    journey([
                        {
                            key: 'announce',
                            kind: 'textChannel',
                            defaultName: 'announcements',
                            adoptDiscordId: '100000000000000001',
                        },
                        {
                            key: 'news',
                            kind: 'textChannel',
                            defaultName: 'news',
                            adoptDiscordId: '100000000000000002',
                        },
                    ])
                )
            ).not.toThrow();
        });
    });
});

describe('orderResourcesForApply', () => {
    it('puts a parent before its child regardless of declaration order', () => {
        const ordered = orderResourcesForApply([
            { key: 'chan', kind: 'textChannel', defaultName: 'welcome', parentKey: 'cat' },
            { key: 'cat', kind: 'category', defaultName: 'Arrivals' },
        ]);

        expect(ordered.map((resource) => resource.key)).toEqual(['cat', 'chan']);
    });

    it('keeps every resource exactly once', () => {
        const input: ResourceDeclaration[] = [
            { key: 'cat', kind: 'category', defaultName: 'Arrivals' },
            { key: 'a', kind: 'textChannel', defaultName: 'a', parentKey: 'cat' },
            { key: 'b', kind: 'textChannel', defaultName: 'b', parentKey: 'cat' },
            { key: 'role', kind: 'role', defaultName: 'Verified' },
        ];

        const ordered = orderResourcesForApply(input);

        expect(ordered).toHaveLength(4);
        expect(new Set(ordered.map((resource) => resource.key)).size).toBe(4);
    });

    it('names the participants in a parent cycle rather than hanging', () => {
        // Unreachable through validation, which rejects unknown parents first — but
        // an infinite loop here would be a hang with no diagnostic at all.
        expect(() =>
            orderResourcesForApply([
                { key: 'a', kind: 'textChannel', defaultName: 'a', parentKey: 'b' },
                { key: 'b', kind: 'textChannel', defaultName: 'b', parentKey: 'a' },
            ])
        ).toThrow(/cycle/i);
    });

    it('puts a declared role before a channel whose permissions reference it', () => {
        /*
         * The sabotage test for item 4's ordering edge, and the reason it lists the
         * channel FIRST: with the edge removed, `parentKey`-only ordering leaves both
         * resources ready on the first pass, so they come out in declaration order and
         * the channel is created before the role exists.
         *
         * That failure is not cosmetic. `compilePermissionIntents` refuses a role it
         * cannot resolve — correctly, since the alternative is a channel less
         * restricted than the author asked for — but it refuses mid-apply, with the
         * channel already in the guild. This test is the guard against that.
         */
        const ordered = orderResourcesForApply([
            {
                key: 'approval-room',
                kind: 'textChannel',
                defaultName: 'approval-room',
                permissions: [
                    { audience: 'everyone', access: 'hidden' },
                    {
                        audience: 'roles',
                        roleIds: [declaredRoleReference('in-approval')],
                        access: 'readWrite',
                    },
                ],
            },
            { key: 'in-approval', kind: 'role', defaultName: 'In Approval' },
        ]);

        expect(ordered.map((resource) => resource.key)).toEqual([
            'in-approval',
            'approval-room',
        ]);
    });

    it('orders a role reference and a parent together', () => {
        // Both edge kinds on one resource: the channel needs its category *and* the
        // role it references, and neither is declared before it.
        const ordered = orderResourcesForApply([
            {
                key: 'approval-room',
                kind: 'textChannel',
                defaultName: 'approval-room',
                parentKey: 'arrivals',
                permissions: [
                    {
                        audience: 'roles',
                        roleIds: [declaredRoleReference('in-approval')],
                        access: 'readWrite',
                    },
                ],
            },
            { key: 'in-approval', kind: 'role', defaultName: 'In Approval' },
            { key: 'arrivals', kind: 'category', defaultName: 'Arrivals' },
        ]);

        const positionOf = (key: string) =>
            ordered.findIndex((resource) => resource.key === key);

        expect(positionOf('approval-room')).toBeGreaterThan(positionOf('in-approval'));
        expect(positionOf('approval-room')).toBeGreaterThan(positionOf('arrivals'));
    });

    it('ignores a plain snowflake when ordering', () => {
        // A real role id names nothing in this journey, so it must create no edge —
        // otherwise every permission referencing an existing role would deadlock.
        const ordered = orderResourcesForApply([
            {
                key: 'approval-room',
                kind: 'textChannel',
                defaultName: 'approval-room',
                permissions: [
                    { audience: 'roles', roleIds: ['847263518290110'], access: 'readWrite' },
                ],
            },
        ]);

        expect(ordered.map((resource) => resource.key)).toEqual(['approval-room']);
    });
});
