/**
 * The decisions behind the resource list: what order rows come in, what a filter
 * shows, and what a rename has to rewrite.
 *
 * Tests the failure modes rather than the plumbing, per the repo's "90% not 100%"
 * note. The rename cases are the ones that matter most — they cover a bug that
 * shipped, where renaming a category's key left its children pointing at the old one
 * and the save was refused by the server with no chip to explain it.
 */

import { describe, expect, it } from 'vitest';
import type { ResourceDeclaration } from '../../api/types';
import { declaredRoleOptionValue } from '../declaredRoleReference';
import {
    applyResourcePatch,
    danglingParentKeys,
    danglingRoleReferences,
    filterResourceRows,
    orderResourceRows,
    removeResourceAtIndex,
    renameResourceKeyReferences,
    resourceMatchesFilter,
} from '../resourceRows';

function category(key: string, name = key): ResourceDeclaration {
    return { key, kind: 'category', defaultName: name };
}

function channel(
    key: string,
    parentKey?: string,
    name = key
): ResourceDeclaration {
    const declaration: ResourceDeclaration = { key, kind: 'textChannel', defaultName: name };
    return parentKey ? { ...declaration, parentKey } : declaration;
}

function role(key: string, name = key): ResourceDeclaration {
    return { key, kind: 'role', defaultName: name };
}

/** The shape the panel renders: key and depth, which is all the ordering decides. */
function shape(resources: readonly ResourceDeclaration[]): string[] {
    return orderResourceRows(resources).map((row) => `${'  '.repeat(row.depth)}${row.resource.key}`);
}

describe('ordering rows so children follow their category', () => {
    it('puts each category ahead of its own channels, indented', () => {
        const resources = [
            channel('welcome', 'arrivals'),
            category('arrivals'),
            channel('applications', 'approvals'),
            category('approvals'),
        ];

        expect(shape(resources)).toEqual([
            'arrivals',
            '  welcome',
            'approvals',
            '  applications',
        ]);
    });

    it('keeps declaration order within a category rather than sorting by name', () => {
        // A list that reshuffles on rename moves the row out from under the cursor.
        const resources = [
            category('arrivals'),
            channel('zebra', 'arrivals'),
            channel('apple', 'arrivals'),
        ];

        expect(shape(resources)).toEqual(['arrivals', '  zebra', '  apple']);
    });

    it('puts top-level channels after the categories and roles last', () => {
        const resources = [
            role('verified'),
            channel('lobby'),
            category('arrivals'),
            channel('welcome', 'arrivals'),
        ];

        expect(shape(resources)).toEqual(['arrivals', '  welcome', 'lobby', 'verified']);
    });

    it('shows a channel whose parent does not exist rather than dropping it', () => {
        // The state the rename fix prevents. If one ever survives, the operator still
        // has to be able to see and repair it.
        const resources = [category('arrivals'), channel('orphan', 'gone-away')];

        expect(shape(resources)).toEqual(['arrivals', 'orphan']);
    });

    it('emits every resource exactly once, even when two categories share a key', () => {
        // `ResourcesPanel` renders with `key={row.index}`, and both the expanded-row
        // set and the chip map are keyed by it. A resource emitted twice would collide
        // on all three — and this arises precisely while an operator is fixing the
        // duplicate key the red chip is complaining about.
        const resources = [category('dup'), category('dup'), channel('welcome', 'dup')];

        const indexes = orderResourceRows(resources).map((row) => row.index);

        expect([...indexes].sort()).toEqual([0, 1, 2]);
    });

    it('carries the original list position, not the position after sorting', () => {
        // Chips and patches are both keyed by the original index; conflating the two
        // would edit the wrong resource as soon as the order differed.
        const resources = [channel('welcome', 'arrivals'), category('arrivals')];
        const rows = orderResourceRows(resources);

        expect(rows.map((row) => row.index)).toEqual([1, 0]);
    });
});

describe('matching the filter', () => {
    it('matches a fragment of the name, case-insensitively', () => {
        expect(resourceMatchesFilter(channel('vetting', undefined, 'vetting'), 'VET')).toBe(true);
    });

    it('matches the key, because error chips send you looking for one', () => {
        expect(resourceMatchesFilter(channel('staff-notes', undefined, 'Staff Notes'), 'notes')).toBe(
            true
        );
    });

    it('matches everything when the query is blank or only spaces', () => {
        expect(resourceMatchesFilter(channel('anything'), '   ')).toBe(true);
    });

    it('does not match an unrelated resource', () => {
        expect(resourceMatchesFilter(channel('welcome'), 'vetting')).toBe(false);
    });
});

describe('filtering the list', () => {
    const resources = [
        category('arrivals', 'Arrivals'),
        channel('welcome', 'arrivals'),
        channel('vetting', 'arrivals'),
        category('play', 'Play Spaces'),
        channel('aftercare', 'play'),
        role('verified'),
    ];
    const rows = orderResourceRows(resources);

    it('keeps a matching child visible under its category as context', () => {
        const filtered = filterResourceRows(rows, 'vetting');

        expect(filtered.map((row) => row.resource.key)).toEqual(['arrivals', 'vetting']);
    });

    it('marks the category it only kept for context, so it can be dimmed', () => {
        const filtered = filterResourceRows(rows, 'vetting');
        const [parent, child] = filtered;

        expect(parent?.isFilterContext).toBe(true);
        expect(child?.isFilterContext).toBe(false);
    });

    it('keeps the child indented rather than flattening it', () => {
        // Flattening would delete the fact that `in <category>` was rejected as a chip
        // for — the indentation is the only thing saying where a row lives.
        const filtered = filterResourceRows(rows, 'vetting');

        expect(filtered.find((row) => row.resource.key === 'vetting')?.depth).toBe(1);
    });

    it('shows everything inside a category that matches by name', () => {
        const filtered = filterResourceRows(rows, 'Play');

        expect(filtered.map((row) => row.resource.key)).toEqual(['play', 'aftercare']);
        expect(filtered.every((row) => !row.isFilterContext)).toBe(true);
    });

    it('returns every row untouched for a blank query', () => {
        expect(filterResourceRows(rows, '')).toBe(rows);
    });

    it('returns nothing when nothing matches', () => {
        expect(filterResourceRows(rows, 'nonexistent')).toEqual([]);
    });
});

describe('renaming a key rewrites what points at it', () => {
    it("moves a category's children to the new key", () => {
        const resources = [
            category('arrivals'),
            channel('welcome', 'arrivals'),
            channel('vetting', 'arrivals'),
        ];

        const renamed = renameResourceKeyReferences(resources, 'arrivals', 'entry');

        expect(renamed[1]?.parentKey).toBe('entry');
        expect(renamed[2]?.parentKey).toBe('entry');
    });

    it('leaves a child of a different category alone', () => {
        const resources = [
            category('arrivals'),
            category('play'),
            channel('aftercare', 'play'),
        ];

        const renamed = renameResourceKeyReferences(resources, 'arrivals', 'entry');

        expect(renamed[2]?.parentKey).toBe('play');
    });

    it('repoints a resource: role reference when the role key changes', () => {
        const resources = [
            role('in-approval'),
            {
                ...channel('vetting'),
                permissions: [
                    {
                        audience: 'roles' as const,
                        access: 'readWrite' as const,
                        roleIds: [declaredRoleOptionValue('in-approval'), '8472910'],
                    },
                ],
            },
        ];

        const renamed = renameResourceKeyReferences(resources, 'in-approval', 'pending');

        expect(renamed[1]?.permissions?.[0]?.roleIds).toEqual([
            declaredRoleOptionValue('pending'),
            // A real snowflake beside it is untouched — the two id spaces are disjoint
            // by construction, which is the point of the prefix.
            '8472910',
        ]);
    });

    it('leaves no dangling reference behind after a category rename', () => {
        // Asserts the condition `validateJourneyDeclaration` actually enforces, rather
        // than merely that the new key appears somewhere.
        const resources = [category('arrivals'), channel('welcome', 'arrivals')];

        const renamed = renameResourceKeyReferences(resources, 'arrivals', 'entry').map(
            (resource) => (resource.key === 'arrivals' ? { ...resource, key: 'entry' } : resource)
        );

        expect(danglingParentKeys(renamed)).toEqual([]);
    });

    it('leaves no dangling reference behind after a role rename', () => {
        const resources = [
            role('in-approval'),
            {
                ...channel('vetting'),
                permissions: [
                    {
                        audience: 'roles' as const,
                        access: 'readWrite' as const,
                        roleIds: [declaredRoleOptionValue('in-approval')],
                    },
                ],
            },
        ];

        const renamed = renameResourceKeyReferences(resources, 'in-approval', 'pending').map(
            (resource) =>
                resource.key === 'in-approval' ? { ...resource, key: 'pending' } : resource
        );

        expect(danglingRoleReferences(renamed)).toEqual([]);
    });

    it('ignores a rename that does not change the key', () => {
        const resources = [category('arrivals'), channel('welcome', 'arrivals')];

        expect(renameResourceKeyReferences(resources, 'arrivals', 'arrivals')).toEqual(resources);
    });

    it('does not touch a rule that names only real snowflakes', () => {
        const resources = [
            role('in-approval'),
            {
                ...channel('vetting'),
                permissions: [
                    {
                        audience: 'roles' as const,
                        access: 'readWrite' as const,
                        roleIds: ['8472910'],
                    },
                ],
            },
        ];

        const renamed = renameResourceKeyReferences(resources, 'in-approval', 'pending');

        expect(renamed[1]).toBe(resources[1]);
    });

});

describe('patching one resource', () => {
    it('carries children across when the patch renames a category key', () => {
        // The whole bug, through the path the panel actually uses: typing in the key
        // field patches one resource, and the children have to follow.
        const resources = [category('arrivals'), channel('welcome', 'arrivals')];

        const patched = applyResourcePatch(resources, 0, { key: 'entry' });

        expect(patched[0]?.key).toBe('entry');
        expect(patched[1]?.parentKey).toBe('entry');
        expect(danglingParentKeys(patched)).toEqual([]);
    });

    it('carries role references across when the patch renames a role key', () => {
        const resources = [
            role('in-approval'),
            {
                ...channel('vetting'),
                permissions: [
                    {
                        audience: 'roles' as const,
                        access: 'readWrite' as const,
                        roleIds: [declaredRoleOptionValue('in-approval')],
                    },
                ],
            },
        ];

        const patched = applyResourcePatch(resources, 0, { key: 'pending' });

        expect(patched[1]?.permissions?.[0]?.roleIds).toEqual([
            declaredRoleOptionValue('pending'),
        ]);
        expect(danglingRoleReferences(patched)).toEqual([]);
    });

    it('deletes the field when a patch carries an explicit undefined', () => {
        // Load-bearing: absent `permissions` means "inherit", `[]` means "inherit
        // nothing". Leaving the key present holding `undefined` would be dropped by
        // `JSON.stringify`, so the saved list and the in-memory one would disagree.
        const resources = [{ ...channel('vetting'), permissions: [] }];

        const patched = applyResourcePatch(resources, 0, { permissions: undefined });

        expect('permissions' in (patched[0] ?? {})).toBe(false);
    });

    it('does not treat a patch with no key as a rename', () => {
        // `patch.key === undefined` is absence, not a rename to nothing. Rewriting
        // references here would repoint every child at the string "undefined".
        const resources = [category('arrivals'), channel('welcome', 'arrivals')];

        const patched = applyResourcePatch(resources, 0, { defaultName: 'Entry Hall' });

        expect(patched[1]?.parentKey).toBe('arrivals');
        expect(patched[0]?.key).toBe('arrivals');
    });

    it('leaves the list alone when the index names no resource', () => {
        const resources = [category('arrivals')];

        expect(applyResourcePatch(resources, 7, { key: 'nope' })).toEqual(resources);
    });

    it('keeps children attached across a clear-then-retype of the key', () => {
        // Select-all + Delete then typing is how a key actually gets changed, and it
        // arrives as two patches with '' in between. Children have to survive both
        // hops: refusing to follow them into '' strands them on the way back out,
        // because the second patch would then rename from a key nothing holds.
        const resources = [category('arrivals'), channel('welcome', 'arrivals')];

        const cleared = applyResourcePatch(resources, 0, { key: '' });

        // Mid-edit the child tracks the empty key — visible as an `Invalid key` chip on
        // the category, not as a silently detached child.
        expect(cleared[1]?.parentKey).toBe('');

        const retyped = applyResourcePatch(cleared, 0, { key: 'entry' });

        expect(retyped[1]?.parentKey).toBe('entry');
        expect(danglingParentKeys(retyped)).toEqual([]);
    });

    it('leaves another resource’s children alone when two keys are empty at once', () => {
        // Clearing one key and then another before retyping either is ordinary
        // editing, and it puts two resources on the same key. Matching references by
        // value alone would hand *both* categories' channels to whichever one is
        // retyped first — a silently mis-parented channel that every later check
        // accepts, because the key it names does exist.
        const resources = [
            category('arrivals'),
            category('approvals'),
            channel('welcome', 'arrivals'),
            channel('vetting', 'approvals'),
        ];

        const bothCleared = applyResourcePatch(
            applyResourcePatch(resources, 0, { key: '' }),
            1,
            { key: '' }
        );

        const retyped = applyResourcePatch(bothCleared, 0, { key: 'entry' });

        expect(retyped[0]?.key).toBe('entry');

        // The point of the guard: `vetting` belongs to the *other* category and must
        // not follow this rename. Without it both children land on `entry`, one of
        // them silently, and nothing downstream can tell.
        expect(retyped[3]?.parentKey).not.toBe('entry');
        expect(retyped[2]?.parentKey).not.toBe('entry');

        // Neither child was carried, so both still name the key the second category
        // still holds — an honest mid-edit state the operator can see and finish,
        // rather than a channel quietly re-homed under a category it never had.
        expect(retyped[2]?.parentKey).toBe('');
        expect(retyped[3]?.parentKey).toBe('');
    });

    it('leaves another role’s permission rules alone when two role keys are empty', () => {
        const resources: ResourceDeclaration[] = [
            role('greeter'),
            role('vetter'),
            {
                key: 'lounge',
                kind: 'textChannel',
                defaultName: 'lounge',
                permissions: [
                    {
                        audience: 'roles',
                        access: 'readWrite',
                        roleIds: [declaredRoleOptionValue('vetter')],
                    },
                ],
            },
        ];

        const bothCleared = applyResourcePatch(
            applyResourcePatch(resources, 0, { key: '' }),
            1,
            { key: '' }
        );

        const retyped = applyResourcePatch(bothCleared, 0, { key: 'welcomer' });

        // The rule named `vetter`, not the role being retyped. Repointing it at
        // `welcomer` would grant a different set of people access to the channel.
        expect(retyped[2]?.permissions?.[0]?.roleIds).not.toContain(
            declaredRoleOptionValue('welcomer')
        );
    });

    it('still renames when the old key is unique, empty or not', () => {
        // The guard must not disarm the ordinary single-clear round trip that the
        // previous test pins — only the genuinely ambiguous case.
        const resources = [category('arrivals'), channel('welcome', 'arrivals')];

        const cleared = applyResourcePatch(resources, 0, { key: '' });
        const retyped = applyResourcePatch(cleared, 0, { key: 'entry' });

        expect(retyped[1]?.parentKey).toBe('entry');
    });

    it('frees children when their category is deleted', () => {
        const resources = [category('arrivals'), channel('welcome', 'arrivals')];

        const removed = removeResourceAtIndex(resources, 0);

        // Removed outright rather than blanked: `parentKey: ''` is a dangling
        // reference, whereas an absent one is a top-level channel.
        expect('parentKey' in (removed[0] ?? {})).toBe(false);
        expect(danglingParentKeys(removed)).toEqual([]);
    });

    it('drops references to a deleted role, keeping the rest of the rule', () => {
        const resources = [
            role('in-approval'),
            {
                ...channel('vetting'),
                permissions: [
                    {
                        audience: 'roles' as const,
                        access: 'readWrite' as const,
                        roleIds: [declaredRoleOptionValue('in-approval'), '8472910'],
                    },
                ],
            },
        ];

        const removed = removeResourceAtIndex(resources, 0);

        expect(removed[0]?.permissions?.[0]?.roleIds).toEqual(['8472910']);
        expect(danglingRoleReferences(removed)).toEqual([]);
    });

    it('drops a rule that named only the deleted role, rather than leaving it empty', () => {
        // The server refuses a `roles` intent with no ids, so keeping the husk would
        // make the list unsaveable in order to delete one role.
        const resources = [
            role('in-approval'),
            {
                ...channel('vetting'),
                permissions: [
                    {
                        audience: 'roles' as const,
                        access: 'readWrite' as const,
                        roleIds: [declaredRoleOptionValue('in-approval')],
                    },
                ],
            },
        ];

        const removed = removeResourceAtIndex(resources, 0);

        expect(removed[0]?.permissions).toEqual([]);
    });

    it('reports an empty parentKey as dangling rather than reading it as no parent', () => {
        // Truthiness here would call `parentKey: ''` "no parent" and pronounce the list
        // clean, which is a check blind to a state the server refuses.
        const stranded = [category('arrivals'), { ...channel('welcome'), parentKey: '' }];

        expect(danglingParentKeys(stranded)).toEqual(['']);
    });
});
