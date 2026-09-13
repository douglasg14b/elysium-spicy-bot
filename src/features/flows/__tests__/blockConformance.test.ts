import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkBlockConformance, checkBlockOutcome } from '../blocks/conformance';
import type { BlockManifest } from '../blocks/manifest';
import { discoverBlocks, ensureBlocksDiscovered, listBlockDefinitions } from '../blocks/registry';
import type { FlowRunContext } from '../blocks/types';
import { block as fixtureBlock, FIXTURE_BLOCK_TYPE } from './fixtures/blocks/conforming/fixtureBlock';

const FIXTURE_ROOT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'blocks',
    'conforming'
);

/** Enough context to call a block. No block under test here touches Discord. */
const context = {
    client: {} as FlowRunContext['client'],
    guild: { id: 'guild-1' } as FlowRunContext['guild'],
    member: {} as FlowRunContext['member'],
    user: {} as FlowRunContext['user'],
} satisfies FlowRunContext;

/**
 * A conforming manifest, as a plain record so a case can drop or corrupt any
 * member. The suite takes `unknown` precisely so these can exist.
 */
function validManifest(): Record<string, unknown> {
    return {
        type: 'fixture.underTest',
        kind: 'action',
        label: 'Under Test',
        description: 'A manifest built to be broken.',
        group: 'actions',
        icon: '🔬',
        configSchema: z.object({ roleId: z.string().min(1) }),
        configFields: [{ key: 'roleId', label: 'Role', control: 'rolePicker' }],
        handles: [{ label: 'Next', tone: 'neutral' }],
        outputs: [],
        requires: [],
        capabilities: [],
        canSuspend: false,
        run: () => ({ kind: 'continue' }),
    };
}

function manifestWithout(field: string): Record<string, unknown> {
    const manifest = validManifest();
    delete manifest[field];
    return manifest;
}

/** A manifest with one member replaced, for the cases that corrupt rather than drop. */
function manifestWith(patch: Record<string, unknown>): Record<string, unknown> {
    return { ...validManifest(), ...patch };
}

/** Cast for a driven case: these manifests are deliberately not type-correct. */
function asManifest(manifest: Record<string, unknown>): BlockManifest {
    return manifest as unknown as BlockManifest;
}

describe('the conformance suite itself', () => {
    it('passes a block that satisfies the contract', () => {
        // The positive control. Without it, every case below could be passing
        // because the suite rejects everything.
        expect(checkBlockConformance(validManifest())).toEqual([]);
    });

    it('passes the permanent fixture block, discovered from its own directory', async () => {
        const discovered = await discoverBlocks<BlockManifest>(FIXTURE_ROOT);
        const block = discovered.get(FIXTURE_BLOCK_TYPE);

        expect(block).toBeDefined();
        expect(checkBlockConformance(block)).toEqual([]);
    });
});

describe('a manifest omitting a required field', () => {
    it('is caught for every member the contract requires', () => {
        for (const field of [
            'type',
            'kind',
            'label',
            'description',
            'group',
            'icon',
            'canSuspend',
            'run',
            'configSchema',
            'configFields',
            'handles',
            'outputs',
            'requires',
            'capabilities',
        ]) {
            const issues = checkBlockConformance(manifestWithout(field));

            expect(issues.some((issue) => issue.includes(field))).toBe(true);
        }
    });

    it('is caught when the block is not even an object', () => {
        expect(checkBlockConformance(undefined)).toHaveLength(1);
        expect(checkBlockConformance('action.sendDM')).toHaveLength(1);
    });
});

describe('a manifest using a word that is not in the vocabulary', () => {
    it('names the vocabulary and says to extend it rather than work around it', () => {
        const issues = checkBlockConformance(
            manifestWith({
                configFields: [{ key: 'roleId', label: 'Role', control: 'starRating' }],
            })
        );

        expect(issues.join('\n')).toMatch(/starRating.*not in the vocabulary.*rolePicker/s);
        expect(issues.join('\n')).toMatch(/Extend the vocabulary/);
    });

    it('checks kind, group, requirements, capabilities and handle tones too', () => {
        expect(checkBlockConformance(manifestWith({ kind: 'sideEffect' })).join()).toMatch(/kind "sideEffect"/);
        expect(checkBlockConformance(manifestWith({ group: 'utilities' })).join()).toMatch(/group "utilities"/);
        expect(checkBlockConformance(manifestWith({ requires: ['ticket'] })).join()).toMatch(/requires "ticket"/);
        expect(checkBlockConformance(manifestWith({ capabilities: ['banMembers'] })).join()).toMatch(
            /capabilities "banMembers"/
        );
        expect(
            checkBlockConformance(manifestWith({ handles: [{ label: 'Next', tone: 'spicy' }] })).join()
        ).toMatch(/tone "spicy"/);
    });
});

describe('a declared field and its schema disagreeing', () => {
    it('catches a declared field the schema does not validate', () => {
        const issues = checkBlockConformance(
            manifestWith({
                configFields: [
                    { key: 'roleId', label: 'Role', control: 'rolePicker' },
                    { key: 'mystery', label: 'Mystery', control: 'text' },
                ],
            })
        );

        expect(issues.join('\n')).toMatch(/"mystery", which its configSchema does not validate/);
    });

    it('catches a schema key no field lets an author set', () => {
        // The form would offer no way to fill a required value, so the block
        // could only ever be saved broken.
        const issues = checkBlockConformance(
            manifestWith({
                configSchema: z.object({ roleId: z.string().min(1), reason: z.string().min(1) }),
            })
        );

        expect(issues.join('\n')).toMatch(/validates "reason", but no config field/);
    });

    it('catches the same field declared twice', () => {
        const issues = checkBlockConformance(
            manifestWith({
                configFields: [
                    { key: 'roleId', label: 'Role', control: 'rolePicker' },
                    { key: 'roleId', label: 'Role again', control: 'rolePicker' },
                ],
            })
        );

        expect(issues.join('\n')).toMatch(/declares the config field "roleId" twice/);
    });
});

describe('a default the schema would reject', () => {
    it('catches a default of the wrong type or outside the schema', () => {
        const issues = checkBlockConformance(
            manifestWith({
                configSchema: z.object({ durationMs: z.number().int().positive().max(1000) }),
                configFields: [
                    { key: 'durationMs', label: 'Wait for', control: 'duration', defaultValue: 5000 },
                ],
            })
        );

        expect(issues.join('\n')).toMatch(/default for "durationMs" \(5000\) is not valid/);
    });

    it('catches a default that disagrees with the schema default', () => {
        // Two declarations of one fact. The form would seed one value and the
        // server would store the other.
        const issues = checkBlockConformance(
            manifestWith({
                configSchema: z.object({ style: z.enum(['Primary', 'Danger']).default('Primary') }),
                configFields: [
                    {
                        key: 'style',
                        label: 'Style',
                        control: 'segmented',
                        defaultValue: 'Danger',
                        options: [
                            { value: 'Primary', label: 'Primary' },
                            { value: 'Danger', label: 'Danger' },
                        ],
                    },
                ],
            })
        );

        expect(issues.join('\n')).toMatch(/field says "Danger", schema says "Primary"/);
    });

    it('catches a schema default the field forgot to mirror', () => {
        const issues = checkBlockConformance(
            manifestWith({
                configSchema: z.object({ style: z.enum(['Primary', 'Danger']).default('Primary') }),
                configFields: [
                    {
                        key: 'style',
                        label: 'Style',
                        control: 'segmented',
                        options: [
                            { value: 'Primary', label: 'Primary' },
                            { value: 'Danger', label: 'Danger' },
                        ],
                    },
                ],
            })
        );

        expect(issues.join('\n')).toMatch(/defaults "style" to "Primary", but the config field declares no default/);
    });

    it('compares object defaults by value, not by identity', () => {
        // Zod hands back a fresh array for an array default, so comparing by
        // reference would fail a block whose defaults agree — and print the same
        // JSON on both sides of the message while doing it.
        const issues = checkBlockConformance(
            manifestWith({
                configSchema: z.object({ swatches: z.array(z.string()).default([]) }),
                configFields: [
                    { key: 'swatches', label: 'Swatches', control: 'text', defaultValue: [] },
                ],
            })
        );

        expect(issues).toEqual([]);
    });
});

describe('a choice control that offers nothing an author can pick', () => {
    /** A `select` over a two-member enum, patched per case. */
    function choiceManifest(field: Record<string, unknown>): Record<string, unknown> {
        return manifestWith({
            configSchema: z.object({ style: z.enum(['Primary', 'Secondary']) }),
            configFields: [{ key: 'style', label: 'Style', control: 'select', ...field }],
        });
    }

    it('catches a select declaring no options at all', () => {
        // The type requires `options`, but the suite takes `unknown`, so this is
        // the shape that actually reaches it from a JS caller or a bad cast.
        expect(checkBlockConformance(choiceManifest({})).join('\n')).toMatch(
            /select field "style" offers no options/
        );
    });

    it('catches a segmented control whose options list is empty', () => {
        const issues = checkBlockConformance(
            manifestWith({
                configSchema: z.object({ style: z.enum(['Primary', 'Secondary']) }),
                configFields: [
                    { key: 'style', label: 'Style', control: 'segmented', options: [] },
                ],
            })
        );

        expect(issues.join('\n')).toMatch(/segmented field "style" offers no options/);
    });

    it('catches an option the schema would reject at save time', () => {
        // The worst version of this failure: the builder offers the choice, the
        // author picks it, and the save fails naming a value the form presented.
        const issues = checkBlockConformance(
            choiceManifest({ options: [{ value: 'Tertiary', label: 'Tertiary' }] })
        );

        expect(issues.join('\n')).toMatch(/offers "Tertiary", which its configSchema rejects/);
    });

    it('blames the schema, not the options, when the schema takes no strings at all', () => {
        // Every option failing is one fact about the schema. Reporting it per
        // option would send an author editing eight correct lines.
        const issues = checkBlockConformance(
            manifestWith({
                configSchema: z.object({ count: z.number() }),
                configFields: [
                    {
                        key: 'count',
                        label: 'Count',
                        control: 'select',
                        options: [
                            { value: '1', label: 'One' },
                            { value: '2', label: 'Two' },
                        ],
                    },
                ],
            })
        );

        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatch(/does not accept strings at all.*z\.coerce\.number\(\)/s);
    });

    it('accepts a numeric choice whose schema coerces', () => {
        expect(
            checkBlockConformance(
                manifestWith({
                    configSchema: z.object({ count: z.coerce.number() }),
                    configFields: [
                        {
                            key: 'count',
                            label: 'Count',
                            control: 'select',
                            options: [{ value: '1', label: 'One' }],
                        },
                    ],
                })
            )
        ).toEqual([]);
    });

    it('accepts options the schema accepts, and catches one missing its label', () => {
        expect(
            checkBlockConformance(
                choiceManifest({
                    options: [
                        { value: 'Primary', label: 'Primary' },
                        { value: 'Secondary', label: 'Secondary' },
                    ],
                })
            )
        ).toEqual([]);

        expect(
            checkBlockConformance(
                choiceManifest({ options: [{ value: 'Primary' }] })
            ).join('\n')
        ).toMatch(/option "Primary" on "style" needs a label/);
    });
});

describe('an optional note that says nothing', () => {
    it('accepts a note with something in it, and a manifest with none at all', () => {
        expect(checkBlockConformance(manifestWith({ note: 'Max 30 days.' }))).toEqual([]);
        expect(checkBlockConformance(validManifest())).toEqual([]);
    });

    it('catches a note that is present but empty, rather than simply omitted', () => {
        // The one outcome neither omitting it nor writing it would produce: it
        // reads as "declared" to every reader and renders as a blank line.
        const issues = checkBlockConformance(manifestWith({ note: '' }));

        expect(issues.join('\n')).toMatch(/note must be a non-empty string when declared/);
        expect(issues.join('\n')).toMatch(/Omit it rather than declaring it empty/);
    });

    it('catches a note that is only whitespace, which renders the same blank line', () => {
        expect(checkBlockConformance(manifestWith({ note: '   ' })).join('\n')).toMatch(
            /note must be a non-empty string when declared/
        );
    });

    it('catches a note that is not a string at all', () => {
        expect(checkBlockConformance(manifestWith({ note: 42 })).join('\n')).toMatch(
            /note must be a non-empty string when declared/
        );
    });
});

describe('a declared maxLength that is not the limit the schema enforces', () => {
    /** A single text field over a `.max(100)` string, patched per case. */
    function lengthManifest(maxLength: number): Record<string, unknown> {
        return manifestWith({
            configSchema: z.object({ message: z.string().min(1).max(100) }),
            configFields: [{ key: 'message', label: 'Message', control: 'text', maxLength }],
        });
    }

    it('accepts a maxLength that matches the schema exactly', () => {
        expect(checkBlockConformance(lengthManifest(100))).toEqual([]);
    });

    it('catches a control that would allow a length the save then refuses', () => {
        expect(checkBlockConformance(lengthManifest(200)).join('\n')).toMatch(
            /declares maxLength 200, but its configSchema rejects a value of exactly that length/
        );
    });

    it('catches a control that would stop an author short of what the schema allows', () => {
        expect(checkBlockConformance(lengthManifest(50)).join('\n')).toMatch(
            /declares maxLength 50, but its configSchema accepts a longer value/
        );
    });

    it('says nothing about a field that declares no maxLength', () => {
        expect(
            checkBlockConformance(
                manifestWith({
                    configSchema: z.object({ message: z.string().min(1).max(100) }),
                    configFields: [{ key: 'message', label: 'Message', control: 'text' }],
                })
            )
        ).toEqual([]);
    });

    it('reports a maxLength no probe could be built from, rather than throwing', () => {
        // `String.repeat` rejects these outright. A throw would abort the whole
        // registry sweep inside a string builtin, losing every other block's
        // issues — so each must come back as a named contract violation.
        for (const maxLength of [-1, 0, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            const issues = checkBlockConformance(lengthManifest(maxLength));

            expect(issues.join('\n'), `maxLength ${maxLength}`).toMatch(
                /which is not a positive whole number of characters/
            );
        }
    });

    it('reports a non-numeric maxLength the same way', () => {
        expect(
            checkBlockConformance(
                manifestWith({
                    configSchema: z.object({ message: z.string().min(1).max(100) }),
                    configFields: [
                        { key: 'message', label: 'Message', control: 'text', maxLength: '100' },
                    ],
                })
            ).join('\n')
        ).toMatch(/declares maxLength "100", which is not a positive whole number/);
    });

    it('stays quiet when the schema constrains format rather than length', () => {
        // The probe would fail on the pattern, not the limit, and report a
        // correct maxLength as wrong.
        expect(
            checkBlockConformance(
                manifestWith({
                    configSchema: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/).max(7) }),
                    configFields: [{ key: 'color', label: 'Colour', control: 'text', maxLength: 7 }],
                })
            )
        ).toEqual([]);
    });
});

describe('a malformed set of output handles', () => {
    it('catches a block a run could never leave', () => {
        expect(checkBlockConformance(manifestWith({ handles: [] })).join('\n')).toMatch(
            /declares no output handles/
        );
    });

    it('catches two default handles, which no edge could tell apart', () => {
        const issues = checkBlockConformance(
            manifestWith({
                handles: [
                    { label: 'Next', tone: 'neutral' },
                    { label: 'Also next', tone: 'neutral' },
                ],
            })
        );

        expect(issues.join('\n')).toMatch(/more than one default output handle/);
    });

    it('catches a named handle declared twice, and one with no label', () => {
        const issues = checkBlockConformance(
            manifestWith({
                handles: [
                    { id: 'timeout', label: 'Timeout', tone: 'caution' },
                    { id: 'timeout', label: '', tone: 'caution' },
                ],
            })
        );

        expect(issues.join('\n')).toMatch(/declares the output handle "timeout" twice/);
        expect(issues.join('\n')).toMatch(/handle timeout needs a label/);
    });
});

describe('driving a block through its entry point', () => {
    it('accepts the fixture block, whose outcome is a declared member', async () => {
        const issues = await checkBlockOutcome(
            fixtureBlock as BlockManifest,
            { roleId: 'role-1', mood: 'mean' },
            context
        );

        expect(issues).toEqual([]);
    });

    it('catches a block returning something that is not a step outcome', async () => {
        const returnedNothing = await checkBlockOutcome(
            asManifest(manifestWith({ run: () => undefined })),
            {},
            context
        );
        const returnedNonsense = await checkBlockOutcome(
            asManifest(manifestWith({ run: () => ({ kind: 'finished' }) })),
            {},
            context
        );

        expect(returnedNothing.join()).toMatch(/not a step outcome/);
        expect(returnedNonsense.join()).toMatch(/"finished", which is not one of continue, suspend, fail/);
    });

    it('catches a block continuing by a handle it never declared', async () => {
        // The builder draws only declared handles, so this edge could not exist
        // on the canvas — the run would stop dead at a node that looked fine.
        const issues = await checkBlockOutcome(
            asManifest(manifestWith({ run: () => ({ kind: 'continue', handle: 'maybe' }) })),
            {},
            context
        );

        expect(issues.join()).toMatch(/continued by the handle "maybe", which it never declared/);
    });

    it('catches a block parking a run it said it would not park', async () => {
        const issues = await checkBlockOutcome(
            asManifest(
                manifestWith({
                    canSuspend: false,
                    run: () => ({ kind: 'suspend', suspension: { wakeAt: new Date() } }),
                })
            ),
            {},
            context
        );

        expect(issues.join()).toMatch(/parked a run while declaring canSuspend: false/);
    });
});

describe('every block that ships', () => {
    let shipped: readonly BlockManifest[] = [];

    beforeAll(async () => {
        await ensureBlocksDiscovered();
        shipped = listBlockDefinitions();
    });

    // The point of the suite. Up to now it was proven against fixtures while the
    // real blocks still wore the legacy shape; from here it governs them, so a
    // manifest that drifts from its own schema fails by name in this one place.
    it('conforms to the contract', () => {
        const offenders = shipped.flatMap((block) => checkBlockConformance(block));

        expect(offenders).toEqual([]);
    });

    it('declares a suspending block honestly', () => {
        // `canSuspend` is documentation the executor never reads, so nothing else
        // would notice a block that lies about it. The two that park say so.
        const suspending = shipped.filter((block) => block.canSuspend).map((block) => block.type);

        expect(suspending.toSorted()).toEqual(['action.delay', 'action.waitForEvent']);
    });

    it('comes back when a suspending block is woken, rather than parking forever', async () => {
        // The guard that matters most, run against what actually ships rather
        // than only the fixture: a block that forgets to check `context.resume`
        // parks, wakes, parks again, and nothing downstream ever notices.
        const configs: Readonly<Record<string, unknown>> = {
            'action.delay': { durationMs: 1000 },
            'action.waitForEvent': { eventKind: 'memberJoin' },
        };

        const suspending = shipped.filter((block) => block.canSuspend);
        expect(suspending.length).toBeGreaterThan(0);

        for (const block of suspending) {
            const config = configs[block.type];
            expect(config, `no probe config for the suspending block ${block.type}`).toBeDefined();
            expect(await checkBlockOutcome(block, config, context)).toEqual([]);
        }
    });

    it('gives every trigger a source, and no other block one', () => {
        for (const block of shipped) {
            if (block.kind === 'trigger') {
                expect(block.startedBy, `${block.type} is a trigger with no source`).toBeDefined();
            } else {
                expect(block.startedBy, `${block.type} is not a trigger but names a source`).toBeUndefined();
            }
        }
    });
});

describe('what the suite cannot prove in M1', () => {
    let fixtureIssues: readonly string[] = [];

    beforeAll(async () => {
        fixtureIssues = await checkBlockOutcome(fixtureBlock as BlockManifest, { roleId: 'r' }, context);
    });

    it('checks that returned handles are declared, not that declared handles are reachable', () => {
        // Recorded rather than quietly softened: proving a declared handle is
        // reachable means driving a block down every path, which needs a config
        // and a context per path that only the block knows. The direction that
        // actually breaks a canvas — a block leaving by an edge the builder never
        // drew — is checked above.
        const unreachable = checkBlockConformance(
            manifestWith({
                handles: [
                    { label: 'Next', tone: 'neutral' },
                    { id: 'never', label: 'Never taken', tone: 'caution' },
                ],
            })
        );

        expect(unreachable).toEqual([]);
        expect(fixtureIssues).toEqual([]);
    });
});
