import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ResourceBindingEntity } from '../../data/resourceBindingsSchema';
import type { ResourceDeclaration } from '../resourceDeclaration';
import {
    detectResourceDrift,
    hasDrift,
    type CompiledOverwrite,
    type LiveOverwrite,
    type LiveResourceSnapshot,
    type ResourceDriftInput,
} from '../resourceDrift';

/**
 * The comparison is pure, so these fixtures are plain objects rather than a fake guild.
 * That is the whole reason the module takes a snapshot instead of a `Guild` — each rule
 * below states its case in a few lines, which is what makes the subtle permission rules
 * reviewable.
 */

/**
 * The two sides of the comparison arrive in different forms, and these fixtures keep
 * that honest rather than smoothing it over: a compiled declaration carries `bigint`
 * bits (what `compilePermissionIntents` returns), while a live overwrite carries the
 * decimal strings `discord.js` serialises to.
 */
const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const THREADS = PermissionFlagsBits.SendMessagesInThreads;
const REACT = PermissionFlagsBits.AddReactions;
const MANAGE_MESSAGES = PermissionFlagsBits.ManageMessages;

/** The same bit as the live side reports it. */
function asLiveBit(bit: bigint): string {
    return String(bit);
}

const BOT_ID = 'bot-1';
const STAFF_ROLE = 'role-staff';
const EVERYONE = 'role-everyone';

function declaration(overrides: Partial<ResourceDeclaration> = {}): ResourceDeclaration {
    return {
        key: 'welcome-channel',
        kind: 'textChannel',
        defaultName: 'welcome',
        ...overrides,
    };
}

function binding(overrides: Partial<ResourceBindingEntity> = {}): ResourceBindingEntity {
    return {
        id: 1,
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

function live(overrides: Partial<LiveResourceSnapshot> = {}): LiveResourceSnapshot {
    return {
        name: 'welcome',
        kind: 'textChannel',
        parentId: null,
        ...overrides,
    };
}

function input(overrides: Partial<ResourceDriftInput> = {}): ResourceDriftInput {
    return {
        declaration: declaration(),
        binding: binding(),
        live: live(),
        botId: BOT_ID,
        ...overrides,
    };
}

describe('detectResourceDrift', () => {
    it('reports nothing when the object still matches', () => {
        const report = detectResourceDrift(input());

        expect(report.drift).toEqual([]);
        expect(hasDrift(report)).toBe(false);
    });

    it('refuses a binding with no Discord id, because that is install\'s concern', () => {
        expect(() =>
            detectResourceDrift(input({ binding: binding({ discordId: null }) }))
        ).toThrow(/no bound Discord id/);
    });

    describe('renamed', () => {
        it('reports a rename against the bound name', () => {
            const report = detectResourceDrift(input({ live: live({ name: 'lobby' }) }));

            expect(report.drift).toEqual([
                { kind: 'renamed', declared: 'welcome', actual: 'lobby' },
            ]);
        });
    });

    describe('reparented', () => {
        it('reports a channel moved out of its declared category', () => {
            const report = detectResourceDrift(
                input({
                    declaration: declaration({ parentKey: 'journey-category' }),
                    live: live({ parentId: 'category-other' }),
                    declaredParentId: 'category-1',
                })
            );

            expect(report.drift).toEqual([
                {
                    kind: 'reparented',
                    declaredParentId: 'category-1',
                    actualParentId: 'category-other',
                },
            ]);
        });

        /**
         * The rule that stops one renamed category from reading as a dozen moved
         * channels. Comparison is by id, so the parent's *name* is irrelevant here —
         * this test pins that by leaving the ids equal and changing nothing else.
         */
        it('does not report a move when only the parent has been renamed', () => {
            const report = detectResourceDrift(
                input({
                    declaration: declaration({ parentKey: 'journey-category' }),
                    live: live({ parentId: 'category-1' }),
                    declaredParentId: 'category-1',
                })
            );

            expect(report.drift).toEqual([]);
        });

        it('states no opinion when the declaration names no parent', () => {
            const report = detectResourceDrift(
                input({ live: live({ parentId: 'category-someone-elses' }) })
            );

            expect(report.drift).toEqual([]);
        });

        it('does not compare when the declared parent has no binding yet', () => {
            const report = detectResourceDrift(
                input({
                    declaration: declaration({ parentKey: 'journey-category' }),
                    live: live({ parentId: null }),
                    declaredParentId: undefined,
                })
            );

            expect(report.drift).toEqual([]);
        });
    });

    describe('wrongType', () => {
        it('reports a binding that now points at a different kind of object', () => {
            const report = detectResourceDrift(
                input({
                    declaration: declaration({ kind: 'category' }),
                    binding: binding({ kind: 'category' }),
                    live: live({ kind: 'textChannel' }),
                })
            );

            expect(report.drift).toEqual([
                { kind: 'wrongType', declared: 'category', actual: 'textChannel' },
            ]);
        });

        it('reports an object that is not a kind we declare at all', () => {
            const report = detectResourceDrift(
                input({ live: live({ kind: { unrecognised: 'GuildVoice' } }) })
            );

            expect(report.drift).toEqual([
                { kind: 'wrongType', declared: 'textChannel', actual: 'GuildVoice' },
            ]);
        });

        /**
         * A type mismatch means the other comparisons are describing an object that is
         * not the resource. Reporting them would offer a rename as the repair for
         * something a rename cannot fix.
         */
        it('suppresses every other drift, because they describe the wrong object', () => {
            const report = detectResourceDrift(
                input({
                    declaration: declaration({ parentKey: 'journey-category' }),
                    live: live({
                        kind: { unrecognised: 'GuildVoice' },
                        name: 'something-else',
                        parentId: 'category-other',
                    }),
                    declaredParentId: 'category-1',
                })
            );

            expect(report.drift).toHaveLength(1);
            expect(report.drift[0]?.kind).toBe('wrongType');
        });
    });

    describe('permissions', () => {
        const staffOnly = declaration({
            permissions: [
                { audience: 'everyone', access: 'hidden' },
                { audience: 'roles', access: 'readWrite', roleIds: [STAFF_ROLE] },
            ],
        });

        const compiled: readonly CompiledOverwrite[] = [
            { id: EVERYONE, allow: [], deny: [VIEW] },
            { id: STAFF_ROLE, allow: [VIEW, SEND, THREADS, REACT], deny: [] },
            // The compiler appends this unconditionally; the comparison must ignore it.
            { id: BOT_ID, allow: [VIEW, SEND, THREADS, REACT], deny: [] },
        ];

        const matching: readonly LiveOverwrite[] = [
            { id: EVERYONE, allow: [], deny: [asLiveBit(VIEW)] },
            {
                id: STAFF_ROLE,
                allow: [VIEW, SEND, THREADS, REACT].map(asLiveBit),
                deny: [],
            },
        ];

        it('reports nothing when the live overwrites satisfy the declaration', () => {
            const report = detectResourceDrift(
                input({
                    declaration: staffOnly,
                    live: live({ overwrites: matching }),
                    compiledOverwrites: compiled,
                })
            );

            expect(report.drift).toEqual([]);
        });

        it('reports the bits a hand-edit removed', () => {
            const report = detectResourceDrift(
                input({
                    declaration: staffOnly,
                    live: live({
                        overwrites: [
                            // Somebody made the staff-only channel public.
                            { id: EVERYONE, allow: [], deny: [] },
                            {
                                id: STAFF_ROLE,
                                allow: [VIEW, SEND, THREADS, REACT].map(asLiveBit),
                                deny: [],
                            },
                        ],
                    }),
                    compiledOverwrites: compiled,
                })
            );

            expect(report.drift).toEqual([
                {
                    kind: 'permissions',
                    differences: [
                        { id: EVERYONE, missingAllow: [], missingDeny: [asLiveBit(VIEW)] },
                    ],
                },
            ]);
        });

        it('reports a declared id with no live overwrite at all', () => {
            const report = detectResourceDrift(
                input({
                    declaration: staffOnly,
                    live: live({
                        overwrites: [{ id: EVERYONE, allow: [], deny: [asLiveBit(VIEW)] }],
                    }),
                    compiledOverwrites: compiled,
                })
            );

            expect(report.drift).toEqual([
                {
                    kind: 'permissions',
                    differences: [
                        {
                            id: STAFF_ROLE,
                            missingAllow: [VIEW, SEND, THREADS, REACT].map(asLiveBit),
                            missingDeny: [],
                        },
                    ],
                },
            ]);
        });

        /**
         * The rule that keeps the report readable on a real guild. A declaration states
         * what must be true, not what must be absent — so an operator granting one more
         * person access is not drift. Without this, every channel reports drift forever
         * and the operator learns to ignore the whole feature.
         */
        it('ignores extra overwrites the declaration never mentioned', () => {
            const report = detectResourceDrift(
                input({
                    declaration: staffOnly,
                    live: live({
                        overwrites: [
                            ...matching,
                            { id: 'member-guest', allow: [asLiveBit(VIEW)], deny: [] },
                        ],
                    }),
                    compiledOverwrites: compiled,
                })
            );

            expect(report.drift).toEqual([]);
        });

        /**
         * `compilePermissionIntents` appends the bot's overwrite unconditionally so it
         * can never be locked out of a channel it has to repair. It is not an authored
         * intent, so surfacing it would show the operator a drift they never declared.
         */
        it('ignores the bot\'s own overwrite', () => {
            const report = detectResourceDrift(
                input({
                    declaration: staffOnly,
                    // The bot's overwrite is absent live, and must still not be drift.
                    live: live({ overwrites: matching }),
                    compiledOverwrites: compiled,
                })
            );

            expect(report.drift).toEqual([]);
        });

        /**
         * Discord returns bitfields carrying bits we never set. Comparing the raw
         * number would report drift on every channel, forever.
         */
        it('ignores unrelated bits present on the live overwrite', () => {
            const report = detectResourceDrift(
                input({
                    declaration: staffOnly,
                    live: live({
                        overwrites: [
                            {
                                id: EVERYONE,
                                allow: [],
                                deny: [VIEW, MANAGE_MESSAGES].map(asLiveBit),
                            },
                            {
                                id: STAFF_ROLE,
                                allow: [VIEW, SEND, THREADS, REACT, MANAGE_MESSAGES].map(
                                    asLiveBit
                                ),
                                deny: [],
                            },
                        ],
                    }),
                    compiledOverwrites: compiled,
                })
            );

            expect(report.drift).toEqual([]);
        });

        it('skips with a stated reason when the declaration could not be compiled', () => {
            const report = detectResourceDrift(
                input({
                    declaration: declaration({
                        permissions: [{ audience: 'subject', access: 'readWrite' }],
                    }),
                    live: live({ overwrites: [] }),
                    compiledOverwrites: undefined,
                })
            );

            expect(report.drift).toEqual([]);
            expect(report.skippedPermissions).toMatch(/subject/);
        });

        it('does not compare permissions on a role', () => {
            const report = detectResourceDrift(
                input({
                    declaration: declaration({
                        kind: 'role',
                        permissions: [{ audience: 'everyone', access: 'hidden' }],
                    }),
                    binding: binding({ kind: 'role' }),
                    live: live({ kind: 'role' }),
                })
            );

            expect(report.drift).toEqual([]);
            expect(report.skippedPermissions).toBeUndefined();
        });
    });

    /**
     * Adoption records the *declared* name, not the live one.
     *
     * `applyInstallPlan` settles an `adopt` with `name: item.name` — the declaration's
     * name — while `requireAdoptable` deliberately never renames the object. So an
     * operator who adopts `#lounge` for a resource defaulting to `welcome` gets a
     * binding saying `welcome` and a channel still called `#lounge`.
     *
     * Comparing against `binding.name` therefore reports a rename that never happened,
     * on every adopted resource, forever. The adoption guard currently hides the
     * consequence by withholding repair — but the report is still wrong, and the guard
     * and the bug are one `state` value apart.
     */
    it('does not report a rename when an adopted object keeps its own name', () => {
        const report = detectResourceDrift(
            input({
                // What `applyInstallPlan` now records on adopt: the object's own name,
                // which differs from the declaration's `defaultName` and should not.
                declaration: declaration({ defaultName: 'welcome' }),
                binding: binding({ state: 'adopted', name: 'lounge' }),
                live: live({ name: 'lounge' }),
            })
        );

        expect(report.drift).toEqual([]);
    });

    describe('the adoption promise', () => {
        /**
         * Detected but not repairable. A staff-only channel going public matters
         * regardless of who created it, so the operator is told — but `buildUnpublishPlan`
         * already refuses to *delete* an adopted resource, and a promise that holds for
         * deletion and not for a rename is not a promise.
         */
        it('detects drift on an adopted resource but withholds repair', () => {
            const report = detectResourceDrift(
                input({
                    // Bound while the channel was called `welcome`, renamed since. This
                    // is drift on an adopted resource — genuinely worth reporting — as
                    // distinct from the phantom case above, where the binding never
                    // matched the live name to begin with.
                    binding: binding({ state: 'adopted', name: 'welcome' }),
                    live: live({ name: 'renamed-by-hand' }),
                })
            );

            expect(hasDrift(report)).toBe(true);
            expect(report.repairable).toBe(false);
        });

        it('allows repair on a resource this journey created', () => {
            const report = detectResourceDrift(
                input({ binding: binding({ state: 'created' }), live: live({ name: 'lobby' }) })
            );

            expect(report.repairable).toBe(true);
        });
    });

    it('reports several drifts together when they are all about the same object', () => {
        const report = detectResourceDrift(
            input({
                declaration: declaration({ parentKey: 'journey-category' }),
                live: live({ name: 'lobby', parentId: null }),
                declaredParentId: 'category-1',
            })
        );

        expect(report.drift.map((entry) => entry.kind)).toEqual(['renamed', 'reparented']);
    });
});
