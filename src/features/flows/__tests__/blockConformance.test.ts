import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkBlockConformance, checkBlockOutcome } from '../blocks/conformance';
import type { BlockManifest } from '../blocks/manifest';
import { discoverBlocks } from '../blocks/registry';
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
