import { describe, expect, it } from 'vitest';
import type { PermissionIntent, ResourceDeclaration } from '../../api/types';
import { declaredRoleOptionValue } from '../declaredRoleReference';
import {
    detectResourceProblems,
    hasBlockingResourceProblem,
    type ResourceChipsForResource,
} from '../detectResourceProblems';
import { RESOURCE_CHIPS, type ResourceChipId } from '../resourceChips';

/**
 * What the chips claim about a declaration, tested where the claim is made.
 *
 * The red tier asserts "the server would refuse this", and that assertion is checked
 * against the server itself in
 * `src/features/provisioning/logic/__tests__/resourceChipAgreement.test.ts` — which
 * lives on that side of the boundary because a `src/` import inside `web/` breaks the
 * web build. This file covers the rest: the warnings, the info tier, and the
 * suppression rules that decide which of two true chips is worth showing.
 */

function channel(overrides: Partial<ResourceDeclaration> = {}): ResourceDeclaration {
    return {
        key: 'questions',
        kind: 'textChannel',
        defaultName: 'questions',
        ...overrides,
    };
}

function role(key: string, overrides: Partial<ResourceDeclaration> = {}): ResourceDeclaration {
    return { key, kind: 'role', defaultName: key, ...overrides };
}

const HIDE_EVERYONE: PermissionIntent = { audience: 'everyone', access: 'hidden' };

/** Chip ids for one row, so assertions read as the vocabulary rather than as objects. */
function idsAt(detected: readonly ResourceChipsForResource[], index: number): ResourceChipId[] {
    const entry = detected[index];
    if (!entry) throw new Error(`No detection result at index ${index}`);
    return entry.chips.map((chip) => chip.id);
}

function idsFor(resource: ResourceDeclaration): ResourceChipId[] {
    return idsAt(detectResourceProblems([resource]), 0);
}

describe('silence is the default', () => {
    it('gives a plain created channel no chips at all', () => {
        // The governing rule in one assertion: if an ordinary row spoke, every row
        // would, and the vocabulary would carry no information.
        expect(idsFor(channel())).toEqual([]);
    });

    it('says nothing about a channel that inherits from its category', () => {
        const detected = detectResourceProblems([
            { key: 'arrivals', kind: 'category', defaultName: 'Arrivals' },
            channel({ parentKey: 'arrivals' }),
        ]);

        expect(idsAt(detected, 0)).toEqual([]);
        expect(idsAt(detected, 1)).toEqual([]);
    });

    it('says nothing about a single rule that is not a hide', () => {
        // One rule is not a sequence, so `orderedRules` would be a count of one.
        expect(
            idsFor(channel({ permissions: [{ audience: 'staff', access: 'readWrite' }] }))
        ).toEqual([]);
    });
});

describe('duplicate keys', () => {
    it('flags both rows sharing a key, not just the second', () => {
        const detected = detectResourceProblems([
            channel({ key: 'aftercare', defaultName: 'aftercare' }),
            channel({ key: 'aftercare', defaultName: 'aftercare-2' }),
        ]);

        expect(idsAt(detected, 0)).toContain('duplicateKey');
        expect(idsAt(detected, 1)).toContain('duplicateKey');
    });

    it('leaves a third row with a distinct key alone', () => {
        const detected = detectResourceProblems([
            channel({ key: 'aftercare' }),
            channel({ key: 'aftercare' }),
            channel({ key: 'debrief' }),
        ]);

        expect(idsAt(detected, 2)).toEqual([]);
    });

    it('does not flag two rows whose keys differ only by case of the same word', () => {
        // `Aftercare` is an *invalid* key rather than a duplicate of `aftercare`. The
        // distinction matters because the two chips send the operator to different
        // fixes, and the server treats them as different failures too.
        const detected = detectResourceProblems([
            channel({ key: 'aftercare' }),
            channel({ key: 'Aftercare' }),
        ]);

        expect(idsAt(detected, 0)).toEqual([]);
        expect(idsAt(detected, 1)).toEqual(['invalidKey']);
    });
});

describe('duplicate adoption', () => {
    it('flags both resources adopting one guild object', () => {
        const detected = detectResourceProblems([
            channel({ key: 'rules', adoptDiscordId: '100000000000000001' }),
            channel({ key: 'rules-copy', adoptDiscordId: '100000000000000001' }),
        ]);

        expect(idsAt(detected, 0)).toContain('duplicateAdoption');
        expect(idsAt(detected, 1)).toContain('duplicateAdoption');
    });

    it('leaves two resources adopting different objects alone', () => {
        const detected = detectResourceProblems([
            channel({ key: 'rules', adoptDiscordId: '100000000000000001' }),
            channel({ key: 'welcome', adoptDiscordId: '100000000000000002' }),
        ]);

        expect(idsAt(detected, 0)).toEqual(['adopted']);
        expect(idsAt(detected, 1)).toEqual(['adopted']);
    });

    it('does not read two non-adopting resources as adopting the same nothing', () => {
        // The bug this guards: filtering `undefined` out before counting. Without it,
        // every pair of plain rows collides on `undefined` and the list turns red.
        const detected = detectResourceProblems([
            channel({ key: 'one' }),
            channel({ key: 'two' }),
        ]);

        expect(idsAt(detected, 0)).toEqual([]);
        expect(idsAt(detected, 1)).toEqual([]);
    });
});

describe('invalid key and missing name', () => {
    it.each([
        ['an underscore', 'qa_channel'],
        ['an uppercase letter', 'qaChannel'],
        ['a leading hyphen', '-qa'],
        ['a trailing hyphen', 'qa-'],
        ['a double hyphen', 'qa--channel'],
        ['a space', 'qa channel'],
        ['emptiness', ''],
    ])('flags a key containing %s', (_description, key) => {
        expect(idsFor(channel({ key }))).toEqual(['invalidKey']);
    });

    it('accepts a key of digits and single hyphens', () => {
        expect(idsFor(channel({ key: 'qa-2-channel' }))).toEqual([]);
    });

    it('flags a key past the 64-character cap', () => {
        expect(idsFor(channel({ key: 'a'.repeat(65) }))).toEqual(['invalidKey']);
        expect(idsFor(channel({ key: 'a'.repeat(64) }))).toEqual([]);
    });

    it('reports an empty name as "Name required" rather than as a key problem', () => {
        const chips = detectResourceProblems([channel({ defaultName: '' })])[0]?.chips ?? [];
        const invalid = chips.find((chip) => chip.id === 'invalidKey');

        expect(invalid?.detail.field).toBe('name');
        expect(RESOURCE_CHIPS.invalidKey.label(invalid?.detail ?? {})).toBe('Name required');
    });

    it('blames the name when the key is wrong too, because that is the visible fault', () => {
        const chips = detectResourceProblems([channel({ key: 'BAD', defaultName: '' })])[0]
            ?.chips ?? [];

        expect(chips.map((chip) => chip.id)).toEqual(['invalidKey']);
        expect(chips[0]?.detail.field).toBe('name');
    });

    it('flags a name past the 100-character cap', () => {
        expect(idsFor(channel({ defaultName: 'x'.repeat(101) }))).toEqual(['invalidKey']);
    });
});

describe('a rule that names no role', () => {
    it('flags a roles intent with an empty list', () => {
        const chips = detectResourceProblems([
            channel({ permissions: [{ audience: 'roles', roleIds: [], access: 'readWrite' }] }),
        ])[0]?.chips ?? [];

        expect(chips.map((chip) => chip.id)).toEqual(['ruleNamesNoRole']);
    });

    it('flags a roles intent with no roleIds member at all', () => {
        expect(
            idsFor(channel({ permissions: [{ audience: 'roles', access: 'readWrite' }] }))
        ).toEqual(['ruleNamesNoRole']);
    });

    it('carries the rule index so the chip can name and focus the right row', () => {
        const chips = detectResourceProblems([
            channel({
                permissions: [
                    HIDE_EVERYONE,
                    { audience: 'roles', roleIds: [], access: 'readWrite' },
                ],
            }),
        ])[0]?.chips ?? [];

        const offending = chips.find((chip) => chip.id === 'ruleNamesNoRole');
        expect(offending?.detail.ruleIndex).toBe(1);
        // The mockup's wording is one-based, and this is where that is decided.
        expect(RESOURCE_CHIPS.ruleNamesNoRole.label(offending?.detail ?? {})).toBe(
            'Rule 2 names no role'
        );
    });

    it('flags a reference to a declared role key the flow does not declare', () => {
        expect(
            idsFor(
                channel({
                    permissions: [
                        {
                            audience: 'roles',
                            roleIds: [declaredRoleOptionValue('deleted-role')],
                            access: 'readWrite',
                        },
                    ],
                })
            )
        ).toEqual(['ruleNamesNoRole']);
    });

    it('flags a reference to a key that is declared but is not a role', () => {
        // The mistake this catches is real and silent: the keys live in one namespace,
        // so `resource:arrivals` is a perfectly well-formed reference to a category.
        const detected = detectResourceProblems([
            { key: 'arrivals', kind: 'category', defaultName: 'Arrivals' },
            channel({
                permissions: [
                    {
                        audience: 'roles',
                        roleIds: [declaredRoleOptionValue('arrivals')],
                        access: 'readWrite',
                    },
                ],
            }),
        ]);

        expect(idsAt(detected, 1)).toEqual(['ruleNamesNoRole']);
    });

    it('accepts a reference to a role the flow does declare', () => {
        const detected = detectResourceProblems([
            role('in-approval'),
            channel({
                permissions: [
                    {
                        audience: 'roles',
                        roleIds: [declaredRoleOptionValue('in-approval')],
                        access: 'readWrite',
                    },
                ],
            }),
        ]);

        expect(idsAt(detected, 1)).toEqual([]);
    });

    it('accepts a plain snowflake without asking whether the role still exists', () => {
        // The server does not check this at save time either — a role can be deleted
        // between declaring it and installing, so a save-time guarantee would expire.
        expect(
            idsFor(
                channel({
                    permissions: [
                        { audience: 'roles', roleIds: ['847263518290110'], access: 'readWrite' },
                    ],
                })
            )
        ).toEqual([]);
    });

    it('flags a rule where one of several ids is a dead reference', () => {
        expect(
            idsFor(
                channel({
                    permissions: [
                        {
                            audience: 'roles',
                            roleIds: ['847263518290110', declaredRoleOptionValue('gone')],
                            access: 'readWrite',
                        },
                    ],
                })
            )
        ).toEqual(['ruleNamesNoRole']);
    });

    it('ignores role ids on an audience that does not use them', () => {
        // `staff` takes no ids by design. Judging a stale list left on one would flag
        // a rule the server accepts.
        expect(
            idsFor(channel({ permissions: [{ audience: 'staff', roleIds: [], access: 'readWrite' }] }))
        ).toEqual([]);
    });
});

describe('nobody can see this', () => {
    it('flags an empty permissions array', () => {
        expect(idsFor(channel({ permissions: [] }))).toEqual(['nobodyCanSee']);
    });

    it('says nothing when permissions are absent, which means inherit', () => {
        // The distinction the whole permission model rests on. Treating absent as `[]`
        // would put an amber chip on nearly every row in the modal.
        expect(idsFor(channel({ permissions: undefined }))).toEqual([]);
    });
});

describe('per-run only', () => {
    it('flags any subject audience and points at the rule', () => {
        const chips = detectResourceProblems([
            channel({
                permissions: [HIDE_EVERYONE, { audience: 'subject', access: 'readWrite' }],
            }),
        ])[0]?.chips ?? [];

        const perRun = chips.find((chip) => chip.id === 'perRunOnly');
        expect(perRun).toBeDefined();
        expect(perRun?.detail.ruleIndex).toBe(1);
    });
});

describe('permissions untouched on an adopted resource', () => {
    it('flags an adopted resource carrying rules', () => {
        expect(
            idsFor(channel({ adoptDiscordId: '100000000000000001', permissions: [HIDE_EVERYONE] }))
        ).toEqual(['permissionsUntouched', 'adopted', 'private']);
    });

    it('does not flag an adopted resource with no rules to ignore', () => {
        expect(idsFor(channel({ adoptDiscordId: '100000000000000001' }))).toEqual(['adopted']);
    });

    it('does not flag an adopted resource whose rules are an empty list', () => {
        // `[]` has no rules to be silently dropped, and already says its own thing.
        expect(
            idsFor(channel({ adoptDiscordId: '100000000000000001', permissions: [] }))
        ).toEqual(['nobodyCanSee', 'adopted']);
    });
});

describe('private and ordered rules', () => {
    it('reads an everyone/hidden rule as private', () => {
        expect(idsFor(channel({ permissions: [HIDE_EVERYONE] }))).toEqual(['private']);
    });

    it('does not read an everyone rule that grants access as private', () => {
        expect(
            idsFor(channel({ permissions: [{ audience: 'everyone', access: 'readOnly' }] }))
        ).toEqual([]);
    });

    it('does not read a hidden rule aimed at named roles as private', () => {
        // Hidden *from those roles* is the opposite of hidden from the server.
        expect(
            idsFor(
                channel({
                    permissions: [
                        { audience: 'roles', roleIds: ['847263518290110'], access: 'hidden' },
                    ],
                })
            )
        ).toEqual([]);
    });

    it('counts rules when there are several and none is a hide', () => {
        const chips = detectResourceProblems([
            channel({
                permissions: [
                    { audience: 'staff', access: 'readWrite' },
                    { audience: 'roles', roleIds: ['847263518290110'], access: 'readOnly' },
                    { audience: 'everyone', access: 'readOnly' },
                ],
            }),
        ])[0]?.chips ?? [];

        const ordered = chips.find((chip) => chip.id === 'orderedRules');
        expect(ordered?.detail.ruleCount).toBe(3);
        expect(RESOURCE_CHIPS.orderedRules.label(ordered?.detail ?? {})).toBe('3 rules in order');
    });

    it('suppresses the count when the resource is already flagged private', () => {
        // Two chips both meaning "there are deliberate rules here" is the redundancy
        // clause (b) of the governing rule exists to stop.
        expect(
            idsFor(
                channel({
                    permissions: [
                        HIDE_EVERYONE,
                        { audience: 'staff', access: 'readWrite' },
                        { audience: 'roles', roleIds: ['847263518290110'], access: 'readOnly' },
                    ],
                })
            )
        ).toEqual(['private']);
    });
});

describe('render order', () => {
    it('leads with the save-blocking problem, whatever else is true', () => {
        const detected = detectResourceProblems([
            channel({ key: 'dup', adoptDiscordId: '100000000000000001' }),
            channel({
                key: 'dup',
                adoptDiscordId: '100000000000000001',
                permissions: [HIDE_EVERYONE],
            }),
        ]);

        expect(idsAt(detected, 1)).toEqual([
            'duplicateKey',
            'duplicateAdoption',
            'permissionsUntouched',
            'adopted',
            'private',
        ]);
    });
});

describe('hasBlockingResourceProblem', () => {
    it('is true when any row carries an error-tier chip', () => {
        const detected = detectResourceProblems([channel({ key: 'dup' }), channel({ key: 'dup' })]);

        expect(hasBlockingResourceProblem(detected)).toBe(true);
    });

    it('is false for a list whose only chips are warnings', () => {
        // The toolbar's count turns red on this, and an amber chip is not a reason to
        // tell someone their flow cannot save.
        const detected = detectResourceProblems([
            channel({ key: 'debrief', permissions: [] }),
            channel({ key: 'ticket', permissions: [{ audience: 'subject', access: 'readWrite' }] }),
        ]);

        expect(detected.flatMap((entry) => entry.chips).length).toBeGreaterThan(0);
        expect(hasBlockingResourceProblem(detected)).toBe(false);
    });

    it('is false for an empty list', () => {
        expect(hasBlockingResourceProblem(detectResourceProblems([]))).toBe(false);
    });
});
