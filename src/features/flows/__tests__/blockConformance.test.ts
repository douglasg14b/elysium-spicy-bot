import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { messageConfigSchema } from '../../../shared/discordMessage';
import { messageButtonsConfigSchema } from '../../provisioning/logic/messageButtonSchema';
import { checkBlockConformance, checkBlockOutcome, checkEmissionTargets } from '../blocks/conformance';
import { buttonClickConfigSchema } from '../blocks/triggerButtonClick';
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

/**
 * A channel that accepts anything and reports only what `send` really returns.
 *
 * Conformance asks what a block *returns*, never what it posted, so a shipped
 * block that talks to Discord needs somewhere for that to land and little more.
 *
 * It does have to hand back a message, though. `TextBasedChannel.send` resolves to
 * a `Message` in every case — there is no branch of discord.js where it yields
 * nothing — so a stub resolving `undefined` was modelling a state that cannot
 * occur, and a block reading the id of what it posted crashed against the harness
 * rather than against any real defect. Only `id` is filled in, because that is all
 * a park has a use for.
 */
function sink(): FlowRunContext['channel'] {
    return {
        send: () => Promise.resolve({ id: 'message-1' }),
    } as unknown as FlowRunContext['channel'];
}

/** Enough context to call a block. */
const context = {
    client: {} as FlowRunContext['client'],
    guild: { id: 'guild-1' } as FlowRunContext['guild'],
    subject: {} as FlowRunContext['subject'],
    runId: 'run-1',
    flowId: 'flow-1',
    nodeId: 'node-1',
    chainDepth: 1,
    variables: {},
    // Conformance drives `run` for real, so it supplies a real write channel. It
    // discards what it is given because no case here asserts on a recorded value —
    // what matters is that a block *may* write without the harness exploding.
    setOutput: () => {},
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
        emits: [],
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
            'emits',
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

    it("checks a choice's own requirements against the same vocabulary", () => {
        // An option's `requires` joins the node's requirements when picked, so a word
        // outside the vocabulary would be a requirement nothing ever checks.
        const withOption = (requires: readonly string[]) =>
            manifestWith({
                configSchema: z.object({ mode: z.enum(['plain', 'member']).default('plain') }),
                configFields: [
                    {
                        key: 'mode',
                        label: 'Mode',
                        control: 'select',
                        defaultValue: 'plain',
                        options: [
                            { value: 'plain', label: 'Plain' },
                            { value: 'member', label: 'Member', requires },
                        ],
                    },
                ],
            });

        expect(checkBlockConformance(withOption(['ticket'])).join()).toMatch(
            /configFields\.options\.requires "ticket" is not in the vocabulary/
        );
        expect(checkBlockConformance(withOption(['subject']))).toEqual([]);
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

    it('measures a textList maxLength against one entry, not the list', () => {
        // A bare-string probe fails against any array schema, which would return
        // no issues while the manifest claims the limit is enforced.
        function listManifest(maxLength: number): Record<string, unknown> {
            return manifestWith({
                configSchema: z.object({ choices: z.array(z.string().max(20)) }),
                configFields: [{ key: 'choices', label: 'Choices', control: 'textList', maxLength }],
            });
        }

        expect(checkBlockConformance(listManifest(20))).toEqual([]);
        expect(checkBlockConformance(listManifest(50)).join('\n')).toMatch(
            /declares maxLength 50, but its configSchema rejects a value of exactly that length/
        );
    });
});

describe('list bounds that describe a list no author could build', () => {
    /** A single `textList` over a 2-to-5 entry schema, patched per case. */
    function boundsManifest(field: Record<string, unknown>): Record<string, unknown> {
        return manifestWith({
            configSchema: z.object({ choices: z.array(z.string()).min(2).max(5) }),
            configFields: [{ key: 'choices', label: 'Choices', control: 'textList', ...field }],
        });
    }

    it('accepts bounds that match the schema exactly', () => {
        expect(checkBlockConformance(boundsManifest({ minEntries: 2, maxEntries: 5 }))).toEqual([]);
    });

    it('catches bounds that cross, which would render a control nobody can satisfy', () => {
        expect(
            checkBlockConformance(boundsManifest({ minEntries: 5, maxEntries: 3 })).join('\n')
        ).toMatch(/asks for at least 5 entries but stops offering new ones at 3/);
    });

    it('catches a maxEntries the schema would not accept', () => {
        expect(checkBlockConformance(boundsManifest({ maxEntries: 9 })).join('\n')).toMatch(
            /declares maxEntries 9, but its configSchema rejects a list that long/
        );
    });

    it('catches a maxEntries that stops an author short of what the schema allows', () => {
        expect(checkBlockConformance(boundsManifest({ maxEntries: 3 })).join('\n')).toMatch(
            /declares maxEntries 3, but its configSchema accepts a longer list/
        );
    });

    it('says nothing about a field that declares no bounds', () => {
        expect(checkBlockConformance(boundsManifest({}))).toEqual([]);
    });

    it('stays quiet when the schema constrains the entries rather than the count', () => {
        /*
         * The probe builds entries of 'a', which a schema constraining entry
         * *content* rejects at every length — so every count probe fails and a
         * correct manifest would be reported as wrong. A false finding here is
         * worse than the gap it closed: it blocks a block that is right.
         */
        for (const element of [z.string().min(2), z.enum(['yes', 'no'])]) {
            expect(
                checkBlockConformance(
                    manifestWith({
                        configSchema: z.object({ choices: z.array(element).max(5) }),
                        configFields: [
                            { key: 'choices', label: 'Choices', control: 'textList', minEntries: 1, maxEntries: 5 },
                        ],
                    })
                )
            ).toEqual([]);
        }
    });
});

describe('an objectList whose columns do not describe the entries its schema takes', () => {
    const entry = z.object({
        name: z.string().min(1).max(256),
        value: z.string().min(1).max(1024),
        inline: z.boolean().default(false),
    });

    /** A single `objectList` over a list of `{name, value, inline}`, patched per case. */
    function columnsManifest(field: Record<string, unknown>): Record<string, unknown> {
        return manifestWith({
            configSchema: z.object({ rows: z.array(entry).max(25).default([]) }),
            configFields: [
                {
                    key: 'rows',
                    label: 'Rows',
                    control: 'objectList',
                    defaultValue: [],
                    columns: [
                        { key: 'name', label: 'Heading', control: 'text', maxLength: 256 },
                        { key: 'value', label: 'Text', control: 'longText', maxLength: 1024 },
                        { key: 'inline', label: 'Side by side', control: 'toggle' },
                    ],
                    ...field,
                },
            ],
        });
    }

    it('accepts columns that match the entry schema exactly', () => {
        expect(checkBlockConformance(columnsManifest({}))).toEqual([]);
    });

    it('catches an objectList declaring no columns at all', () => {
        expect(checkBlockConformance(columnsManifest({ columns: [] })).join('\n')).toMatch(
            /declares no columns/
        );
    });

    it('catches a renamed column, which the schema rejects outright', () => {
        expect(
            checkBlockConformance(
                columnsManifest({
                    columns: [
                        { key: 'title', label: 'Heading', control: 'text' },
                        { key: 'value', label: 'Text', control: 'longText' },
                    ],
                })
            ).join('\n')
        ).toMatch(/configSchema rejects a list holding such entries/);
    });

    /**
     * The direction a parse alone cannot see. Zod strips an unknown key rather
     * than refusing it, so this entry validates and the column's every keystroke
     * is discarded — the exact failure `checkFieldColumns` exists to catch.
     */
    it('catches an extra column the schema silently strips', () => {
        expect(
            checkBlockConformance(
                columnsManifest({
                    columns: [
                        { key: 'name', label: 'Heading', control: 'text' },
                        { key: 'value', label: 'Text', control: 'longText' },
                        { key: 'nope', label: 'Typo', control: 'text' },
                    ],
                })
            ).join('\n')
        ).toMatch(/declares the column\(s\) \[nope\], which its configSchema does not validate/);
    });

    it('catches a column asking for a control a column may not use', () => {
        expect(
            checkBlockConformance(
                columnsManifest({
                    columns: [
                        { key: 'name', label: 'Heading', control: 'colour' },
                        { key: 'value', label: 'Text', control: 'longText' },
                    ],
                })
            ).join('\n')
        ).toMatch(/is not one a column may use/);
    });

    it('catches a duplicate column and one with no label', () => {
        const issues = checkBlockConformance(
            columnsManifest({
                columns: [
                    { key: 'name', label: 'Heading', control: 'text' },
                    { key: 'name', control: 'text' },
                ],
            })
        ).join('\n');

        expect(issues).toMatch(/declares the column "name" twice/);
        expect(issues).toMatch(/needs a label/);
    });

    it('catches a toggle declaring members a checkbox cannot honour', () => {
        expect(
            checkBlockConformance(
                columnsManifest({
                    columns: [
                        { key: 'name', label: 'Heading', control: 'text' },
                        { key: 'value', label: 'Text', control: 'longText' },
                        { key: 'inline', label: 'Side by side', control: 'toggle', maxLength: 10 },
                    ],
                })
            ).join('\n')
        ).toMatch(/is a toggle but declares maxLength/);
    });

    it('holds one column’s maxLength to the schema, in both directions', () => {
        expect(
            checkBlockConformance(
                columnsManifest({
                    columns: [
                        { key: 'name', label: 'Heading', control: 'text', maxLength: 500 },
                        { key: 'value', label: 'Text', control: 'longText' },
                    ],
                })
            ).join('\n')
        ).toMatch(/column "name" on "rows" declares maxLength 500.*rejects a value of exactly that length/s);

        expect(
            checkBlockConformance(
                columnsManifest({
                    columns: [
                        { key: 'name', label: 'Heading', control: 'text', maxLength: 10 },
                        { key: 'value', label: 'Text', control: 'longText' },
                    ],
                })
            ).join('\n')
        ).toMatch(/column "name" on "rows" declares maxLength 10.*accepts a longer value/s);
    });

    /**
     * A schema needing two entries before it will judge one.
     *
     * A single-entry probe fails on list *length* here, which would be reported as
     * "the schema rejects your columns" — a false finding against a correct
     * manifest — and would then skip every column's maxLength on the early return.
     */
    /**
     * Declares `minEntries` and **no** `maxEntries`, deliberately.
     *
     * A ceiling read off `maxEntries` alone collapses to 1 for this field, which
     * restores the single-entry probe the sweep exists to replace — and the first
     * version of this case declared both bounds, so the maximum carried it to 2
     * and the gap stayed invisible.
     */
    it('says nothing about correct columns under a schema with a list minimum', () => {
        expect(
            checkBlockConformance(
                manifestWith({
                    configSchema: z.object({ rows: z.array(entry).min(2) }),
                    configFields: [
                        {
                            key: 'rows',
                            label: 'Rows',
                            control: 'objectList',
                            minEntries: 2,
                            columns: [
                                { key: 'name', label: 'Heading', control: 'text', maxLength: 256 },
                                { key: 'value', label: 'Text', control: 'longText', maxLength: 1024 },
                                { key: 'inline', label: 'Side by side', control: 'toggle' },
                            ],
                        },
                    ],
                })
            )
        ).toEqual([]);
    });
});

describe('a card summary that does not describe the fields it claims to', () => {
    it('accepts a manifest with no cardSummary at all', () => {
        expect(checkBlockConformance(validManifest())).toEqual([]);
    });

    it('accepts a well-formed field reference and a well-formed literal', () => {
        expect(
            checkBlockConformance(
                manifestWith({
                    cardSummary: [
                        { key: 'roleId', prefix: 'Assign ', emptyText: 'no role picked' },
                        { text: ' · fixed text' },
                    ],
                })
            )
        ).toEqual([]);
    });

    it('rejects a cardSummary that is not an array', () => {
        expect(checkBlockConformance(manifestWith({ cardSummary: 'Assign @role' })).join('\n')).toMatch(
            /cardSummary must be an array of parts/
        );
    });

    it('catches a part naming a field configFields does not declare', () => {
        const issues = checkBlockConformance(
            manifestWith({ cardSummary: [{ key: 'mystery', prefix: 'Do ' }] })
        );

        expect(issues.join('\n')).toMatch(
            /cardSummary\[0\] references the config field "mystery", which configFields does not declare/
        );
    });

    it('catches a part declaring neither key nor text', () => {
        expect(checkBlockConformance(manifestWith({ cardSummary: [{ prefix: 'Assign ' }] })).join('\n')).toMatch(
            /must set exactly one of "key".*or "text".*found neither/
        );
    });

    it('catches a part declaring both key and text', () => {
        expect(
            checkBlockConformance(
                manifestWith({ cardSummary: [{ key: 'roleId', text: 'Assign a role' }] })
            ).join('\n')
        ).toMatch(/must set exactly one of "key".*or "text".*found both/);
    });

    it('catches a literal part with an empty or non-string text', () => {
        expect(checkBlockConformance(manifestWith({ cardSummary: [{ text: '' }] })).join('\n')).toMatch(
            /cardSummary\[0\]\.text must be a non-empty string/
        );
        expect(checkBlockConformance(manifestWith({ cardSummary: [{ text: 42 }] })).join('\n')).toMatch(
            /cardSummary\[0\]\.text must be a non-empty string/
        );
    });

    it('catches a truncate that is not a positive whole number', () => {
        for (const truncate of [0, -1, 2.5, '20']) {
            const issues = checkBlockConformance(
                manifestWith({ cardSummary: [{ key: 'roleId', truncate }] })
            );

            expect(issues.join('\n'), `truncate ${JSON.stringify(truncate)}`).toMatch(
                /cardSummary\[0\]\.truncate must be a positive whole number of characters/
            );
        }
    });

    it('accepts a valid positive integer truncate', () => {
        expect(
            checkBlockConformance(manifestWith({ cardSummary: [{ key: 'roleId', truncate: 20 }] }))
        ).toEqual([]);
    });

    it('catches a part that sets both hideWhenEmpty and stopIfEmpty', () => {
        const issues = checkBlockConformance(
            manifestWith({
                cardSummary: [{ key: 'roleId', hideWhenEmpty: true, stopIfEmpty: true, emptyText: 'none' }],
            })
        );

        expect(issues.join('\n')).toMatch(/sets both hideWhenEmpty and stopIfEmpty/);
    });

    it('catches a part that stops the summary early with nothing to show in its place', () => {
        const issues = checkBlockConformance(
            manifestWith({ cardSummary: [{ key: 'roleId', stopIfEmpty: true }] })
        );

        expect(issues.join('\n')).toMatch(/sets stopIfEmpty without emptyText/);
    });

    it('accepts stopIfEmpty paired with emptyText', () => {
        expect(
            checkBlockConformance(
                manifestWith({
                    cardSummary: [{ key: 'roleId', stopIfEmpty: true, emptyText: 'nothing picked' }],
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

describe('a declared output nothing could ever resolve', () => {
    it('accepts both ways of naming a variable', () => {
        const fixed = manifestWith({
            outputs: [{ naming: 'fixed', key: 'assignedRole', label: 'The role' }],
        });
        const authored = manifestWith({
            outputs: [{ naming: 'authored', fromField: 'roleId', label: 'The role' }],
        });

        expect(checkBlockConformance(fixed)).toEqual([]);
        expect(checkBlockConformance(authored)).toEqual([]);
    });

    it('catches an authored output reading from a field the block does not have', () => {
        // The rename case, and the reason the discriminator is worth having: this
        // resolves to nothing on every node forever, and says so nowhere at run time.
        const issues = checkBlockConformance(
            manifestWith({
                outputs: [{ naming: 'authored', fromField: 'outputKey', label: 'The pick' }],
            })
        );

        expect(issues.join('\n')).toMatch(/reads its name from "outputKey"/);
        expect(issues.join('\n')).toMatch(/not one of this block's config fields/);
    });

    it('catches a fixed output with no key and an authored one with no field', () => {
        expect(
            checkBlockConformance(manifestWith({ outputs: [{ naming: 'fixed', label: 'Nameless' }] })).join('\n')
        ).toMatch(/must declare the key it writes/);

        expect(
            checkBlockConformance(manifestWith({ outputs: [{ naming: 'authored', label: 'Nameless' }] })).join('\n')
        ).toMatch(/must name the config field holding its variable name/);
    });

    it('catches an output declaring no naming at all, which is the pre-discriminator shape', () => {
        const issues = checkBlockConformance(
            manifestWith({ outputs: [{ key: 'outputKey', label: 'The pick' }] })
        );

        expect(issues.join('\n')).toMatch(/must declare naming as "fixed" or "authored"/);
    });

    it('catches an output scoped to a handle the block does not have', () => {
        // Scoped to an exit no edge can leave by, so the builder would never offer it.
        const issues = checkBlockConformance(
            manifestWith({
                handles: [
                    { id: 'true', label: 'Yes', tone: 'positive' },
                    { id: 'false', label: 'No', tone: 'negative' },
                ],
                outputs: [{ naming: 'fixed', key: 'found', label: 'Found', handle: 'yes' }],
            })
        );

        expect(issues.join('\n')).toMatch(/written on the handle "yes", which is not one of this block's handles/);
    });

    it('catches a value kind outside the vocabulary', () => {
        const issues = checkBlockConformance(
            manifestWith({ outputs: [{ naming: 'fixed', key: 'thing', label: 'Thing', valueKind: 'banana' }] })
        );

        expect(issues.join('\n')).toMatch(/declares the value kind "banana", which is not a value kind/);
    });

    it('catches an output with no label for the builder to show', () => {
        const issues = checkBlockConformance(
            manifestWith({ outputs: [{ naming: 'fixed', key: 'thing', label: '' }] })
        );

        expect(issues.join('\n')).toMatch(/needs a label the builder can show/);
    });
});

/** A `select` the cases below hang visibility and value kinds off. */
const VALUE_TYPE_FIELD = {
    key: 'valueType',
    label: 'Value',
    control: 'select',
    defaultValue: 'text',
    options: [
        { value: 'text', label: 'Text' },
        { value: 'time', label: 'Current time' },
    ],
};

/** A manifest with a `valueType` choice and an optional `note` field it can hide. */
function choiceManifest(overrides: {
    valueType?: Record<string, unknown>;
    note?: Record<string, unknown>;
    schema?: z.ZodObject;
    outputs?: readonly Record<string, unknown>[];
}): Record<string, unknown> {
    return manifestWith({
        configSchema:
            overrides.schema ??
            z.object({ valueType: z.enum(['text', 'time']).default('text'), note: z.string().optional() }),
        configFields: [
            { ...VALUE_TYPE_FIELD, ...overrides.valueType },
            { key: 'note', label: 'Note', control: 'text', visibleWhen: { field: 'valueType', equals: ['text'] }, ...overrides.note },
        ],
        outputs: overrides.outputs ?? [],
    });
}

describe('a field shown only while a sibling holds a value', () => {
    it('accepts a field shown by a defaulted choice, under an optional schema key', () => {
        expect(checkBlockConformance(choiceManifest({}))).toEqual([]);
    });

    it('catches a visibleWhen naming a field that is not a choice', () => {
        const issues = checkBlockConformance(
            choiceManifest({ note: { visibleWhen: { field: 'note', equals: ['x'] } } })
        ).join('\n');

        expect(issues).toMatch(/"note" is shown by "note", which is not a select or segmented field/);
    });

    it('catches a sibling with no default, or one that disagrees with its schema', () => {
        const noDefault = checkBlockConformance(
            choiceManifest({
                valueType: { defaultValue: undefined },
                schema: z.object({ valueType: z.enum(['text', 'time']), note: z.string().optional() }),
            })
        ).join('\n');
        expect(noDefault).toMatch(/needs a declared default matching a schema \.default\(\)/);

        const disagrees = checkBlockConformance(
            choiceManifest({
                schema: z.object({ valueType: z.enum(['text', 'time']), note: z.string().optional() }),
            })
        ).join('\n');
        expect(disagrees).toMatch(/field says "text", schema says undefined/);
    });

    it('catches a chain, where the sibling is conditional itself', () => {
        const issues = checkBlockConformance(
            choiceManifest({ valueType: { visibleWhen: { field: 'valueType', equals: ['text'] } } })
        ).join('\n');

        expect(issues).toMatch(/is shown by "valueType", which is itself conditional/);
    });

    it('catches a value the sibling never offers', () => {
        const issues = checkBlockConformance(
            choiceManifest({ note: { visibleWhen: { field: 'valueType', equals: ['text', 'number'] } } })
        ).join('\n');

        expect(issues).toMatch(/is shown when "valueType" is "number", which it never offers/);
    });

    it('catches a field that can be hidden but that its schema requires', () => {
        const issues = checkBlockConformance(
            choiceManifest({ schema: z.object({ valueType: z.enum(['text', 'time']).default('text'), note: z.string() }) })
        ).join('\n');

        expect(issues).toMatch(/"note" can be hidden, but its configSchema requires it/);
    });

    it('catches a malformed visibleWhen', () => {
        const issues = checkBlockConformance(choiceManifest({ note: { visibleWhen: { field: 'valueType', equals: [] } } }));

        expect(issues.join('\n')).toMatch(/visibleWhen without a field name and a non-empty list/);
    });
});

describe('an output whose kind a field decides', () => {
    const derived = (valueKindFrom: Record<string, unknown>, extra: Record<string, unknown> = {}) => [
        { naming: 'authored', fromField: 'note', label: 'The value', valueKindFrom, ...extra },
    ];

    it('accepts a defaulted choice whose options map to real kinds', () => {
        expect(
            checkBlockConformance(choiceManifest({ outputs: derived({ field: 'valueType', kinds: { time: 'time' } }) }))
        ).toEqual([]);
    });

    it('catches a static kind declared beside it', () => {
        const issues = checkBlockConformance(
            choiceManifest({ outputs: derived({ field: 'valueType', kinds: { time: 'time' } }, { valueKind: 'time' }) })
        ).join('\n');

        expect(issues).toMatch(/declares both valueKind and valueKindFrom/);
    });

    it('catches a field that is not a choice, and one with no default', () => {
        expect(
            checkBlockConformance(choiceManifest({ outputs: derived({ field: 'note', kinds: {} }) })).join('\n')
        ).toMatch(/takes its kind from "note", which is not a select or segmented field/);

        expect(
            checkBlockConformance(
                choiceManifest({
                    valueType: { defaultValue: undefined },
                    schema: z.object({ valueType: z.enum(['text', 'time']), note: z.string().optional() }),
                    outputs: derived({ field: 'valueType', kinds: { time: 'time' } }),
                })
            ).join('\n')
        ).toMatch(/takes its kind from "valueType", which declares no default/);
    });

    it('catches an option the field never offers, and a kind outside the vocabulary', () => {
        const issues = checkBlockConformance(
            choiceManifest({ outputs: derived({ field: 'valueType', kinds: { number: 'time', time: 'banana' } }) })
        ).join('\n');

        expect(issues).toMatch(/maps "number" to a kind, but "valueType" offers no such option/);
        expect(issues).toMatch(/maps "time" to "banana", which is not a value kind/);
    });
});

describe('a field reading a variable by name', () => {
    const variableManifest = (field: Record<string, unknown>, schema: z.ZodType) =>
        manifestWith({
            configSchema: z.object({ seenAt: schema }),
            configFields: [{ key: 'seenAt', label: 'Saved time', control: 'variableSelect', valueKind: 'time', ...field }],
        });

    it('accepts a real kind over a schema in the shared spelling', () => {
        expect(checkBlockConformance(variableManifest({}, z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).optional()))).toEqual([]);
    });

    it('accepts one that can be hidden — the shape Time Since needs', () => {
        const manifest = choiceManifest({
            schema: z.object({
                valueType: z.enum(['text', 'time']).default('text'),
                note: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).optional(),
            }),
            note: { control: 'variableSelect', valueKind: 'time', visibleWhen: { field: 'valueType', equals: ['time'] } },
        });

        expect(checkBlockConformance(manifest)).toEqual([]);
    });

    it('catches a kind outside the vocabulary', () => {
        const issues = checkBlockConformance(
            variableManifest({ valueKind: 'banana' }, z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).optional())
        ).join('\n');

        expect(issues).toMatch(/offers variables of the kind "banana", which is not a value kind/);
    });

    it('accepts one declaring no kind, which takes any variable — the shape Compare needs', () => {
        const manifest = manifestWith({
            configSchema: z.object({ seenAt: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/) }),
            configFields: [{ key: 'seenAt', label: 'Variable', control: 'variableSelect' }],
        });

        expect(checkBlockConformance(manifest)).toEqual([]);
    });

    it('still holds one declaring no kind to the shared spelling', () => {
        const manifest = manifestWith({
            configSchema: z.object({ seenAt: z.string() }),
            configFields: [{ key: 'seenAt', label: 'Variable', control: 'variableSelect' }],
        });

        expect(checkBlockConformance(manifest).join('\n')).toMatch(/must take one in the shared spelling/);
    });

    it('catches a schema that would store a name no token can address', () => {
        const issues = checkBlockConformance(variableManifest({}, z.string().optional())).join('\n');

        expect(issues).toMatch(/must take one in the shared spelling/);
    });
});

describe('a control whose stored shape the control decides', () => {
    const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;
    const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
    const timeManifest = (schema: z.ZodType) =>
        manifestWith({
            configSchema: z.object({ at: schema }),
            configFields: [{ key: 'at', label: 'Time', control: 'timeOfDay', defaultValue: '09:00' }],
        });
    const daysManifest = (schema: z.ZodType) =>
        manifestWith({
            configSchema: z.object({ on: schema }),
            configFields: [{ key: 'on', label: 'Days', control: 'daysOfWeek', defaultValue: ['mon'] }],
        });

    it('accepts a timeOfDay over a 24-hour HH:MM schema', () => {
        expect(checkBlockConformance(timeManifest(z.string().regex(TIME_SHAPE).optional()))).toEqual([]);
    });

    it('catches a timeOfDay schema that is too loose', () => {
        const issues = checkBlockConformance(timeManifest(z.string().regex(/^\d{1,2}:\d\d$/).optional())).join('\n');

        expect(issues).toMatch(/the timeOfDay field "at" stores a 24-hour HH:MM .* accepts "24:00", "9:00"/);
    });

    it('catches a timeOfDay schema that refuses what the control stores', () => {
        const issues = checkBlockConformance(timeManifest(z.string().regex(/^0\d:\d\d$/).optional())).join('\n');

        expect(issues).toMatch(/configSchema refuses "23:59"/);
    });

    it('accepts a daysOfWeek over exactly the seven keys', () => {
        expect(checkBlockConformance(daysManifest(z.array(z.enum(DAYS)).min(1).optional()))).toEqual([]);
    });

    it('catches a daysOfWeek schema that takes any string', () => {
        const issues = checkBlockConformance(daysManifest(z.array(z.string()).optional())).join('\n');

        expect(issues).toMatch(/the daysOfWeek field "on" stores a list of the seven day keys.* accepts \["Mon"\]/);
    });

    it('catches a daysOfWeek schema missing a day', () => {
        const issues = checkBlockConformance(daysManifest(z.array(z.enum(['mon', 'tue'])).optional())).join('\n');

        expect(issues).toMatch(/configSchema refuses \["wed"\]/);
    });

    const messageManifest = (schema: z.ZodType) =>
        manifestWith({
            configSchema: z.object({ message: schema }),
            configFields: [{ key: 'message', label: 'Message', control: 'message' }],
        });

    it('accepts a message over the shared message schema', () => {
        expect(checkBlockConformance(messageManifest(messageConfigSchema))).toEqual([]);
    });

    it('catches a message field over a string schema, which refuses every message the editor builds', () => {
        const issues = checkBlockConformance(messageManifest(z.string())).join('\n');

        expect(issues).toMatch(/the message field "message" stores a message object .* refuses \{"embeds":\[\{"title":"a"\}\]\}/);
        expect(issues).toMatch(/accepts "x"/);
    });

    // A Button Click trigger, the only block a `messageButton` field may sit on.
    const messageButtonManifest = (schema: z.ZodType) =>
        manifestWith({
            kind: 'trigger',
            group: 'triggers',
            startedBy: 'buttonClick',
            configSchema: z.object({ button: schema }),
            configFields: [{ key: 'button', label: 'Button', control: 'messageButton' }],
        });

    it("accepts a messageButton over Button Click's own schema", () => {
        expect(checkBlockConformance(messageButtonManifest(buttonClickConfigSchema.shape.button))).toEqual([]);
    });

    it('catches a messageButton field over a string schema, which refuses every pick the control makes', () => {
        const issues = checkBlockConformance(messageButtonManifest(z.string())).join('\n');

        expect(issues).toMatch(/the messageButton field "button" stores .* refuses \{"messageKey":"a","buttonKey":"b"\}/);
        expect(issues).toMatch(/accepts "x"/);
    });

    it('catches a messageButton field over a schema that takes an empty object', () => {
        const issues = checkBlockConformance(
            messageButtonManifest(z.object({ messageKey: z.string().optional(), buttonKey: z.string().optional() }))
        ).join('\n');

        expect(issues).toMatch(/accepts \{\}/);
    });
});

describe("a message field's buttons, kept in a key it names", () => {
    /** A message field naming `buttonsKey`, over `shape` beside the message itself. */
    const buttonsManifest = (shape: Record<string, z.ZodType>, buttonsKey: unknown = 'buttons') =>
        manifestWith({
            configSchema: z.object({ message: messageConfigSchema, ...shape }),
            configFields: [{ key: 'message', label: 'Message', control: 'message', buttonsKey }],
        });

    it('accepts the shared button list, with no field of its own for the key', () => {
        // The positive control: without it, a check refusing every buttonsKey would pass every case below.
        expect(checkBlockConformance(buttonsManifest({ buttons: messageButtonsConfigSchema.optional() }))).toEqual([]);
    });

    it('catches a buttonsKey naming a key the schema does not validate, which the save would drop', () => {
        const issues = checkBlockConformance(buttonsManifest({}, 'buttons')).join('\n');

        expect(issues).toMatch(/keeps its buttons in "buttons", which its configSchema does not validate/);
    });

    it('catches a buttonsKey over a schema that refuses a button list', () => {
        const issues = checkBlockConformance(buttonsManifest({ buttons: z.string().optional() })).join('\n');

        expect(issues).toMatch(/keeps its buttons in "buttons", but its configSchema refuses \[\], \[\{"key":"a","label":"A","style":"Primary"\}\]/);
        expect(issues).toMatch(/accepts "x"/);
    });

    it('catches a buttonsKey over a schema that takes a nameless button', () => {
        const issues = checkBlockConformance(buttonsManifest({ buttons: z.array(z.unknown()).optional() })).join('\n');

        expect(issues).toMatch(/accepts \[\{\}\], /);
    });

    it('catches a required button list, which every node saved before buttons existed would fail', () => {
        const issues = checkBlockConformance(buttonsManifest({ buttons: messageButtonsConfigSchema })).join('\n');

        expect(issues).toMatch(/configSchema refuses nothing at all there/);
    });

    it('catches a defaulted button list, which posts buttons nobody drew', () => {
        const issues = checkBlockConformance(
            buttonsManifest({ buttons: messageButtonsConfigSchema.default([{ key: 'a', label: 'A', style: 'Primary' }]) })
        ).join('\n');

        expect(issues).toMatch(/defaults it to \[\{"key":"a","label":"A","style":"Primary"\}\]/);
    });

    it('catches a button list that skips the shared rules, letting two buttons share a key', () => {
        const ruleFree = z.array(z.object({ key: z.string().min(1), label: z.string().optional(), style: z.string() })).optional();
        const issues = checkBlockConformance(buttonsManifest({ buttons: ruleFree })).join('\n');

        expect(issues).toMatch(/accepts \[\{"key":"a","label":"A","style":"Primary"\},\{"key":"a","label":"B","style":"Primary"\}\] there/);
    });

    it('catches two message fields keeping their buttons in one key', () => {
        const issues = checkBlockConformance(
            manifestWith({
                configSchema: z.object({
                    message: messageConfigSchema,
                    aftercare: messageConfigSchema,
                    buttons: messageButtonsConfigSchema.optional(),
                }),
                configFields: [
                    { key: 'message', label: 'Message', control: 'message', buttonsKey: 'buttons' },
                    { key: 'aftercare', label: 'Aftercare', control: 'message', buttonsKey: 'buttons' },
                ],
            })
        ).join('\n');

        expect(issues).toMatch(/the message field "aftercare" keeps its buttons in "buttons", which a field already writes/);
    });

    it('catches a buttonsKey naming the message field itself, or a key another field writes', () => {
        const own = checkBlockConformance(buttonsManifest({}, 'message')).join('\n');
        expect(own).toMatch(/keeps its buttons in "message", which a field already writes/);

        const other = checkBlockConformance(
            manifestWith({
                configSchema: z.object({ message: messageConfigSchema, roleId: z.string().min(1) }),
                configFields: [
                    { key: 'message', label: 'Message', control: 'message', buttonsKey: 'roleId' },
                    { key: 'roleId', label: 'Role', control: 'rolePicker' },
                ],
            })
        ).join('\n');
        expect(other).toMatch(/keeps its buttons in "roleId", which a field already writes/);
    });

    it('catches a buttonsKey on a field that is not a message', () => {
        const issues = checkBlockConformance(
            manifestWith({
                configSchema: z.object({ roleId: z.string().min(1), buttons: messageButtonsConfigSchema.optional() }),
                configFields: [{ key: 'roleId', label: 'Role', control: 'rolePicker', buttonsKey: 'buttons' }],
            })
        ).join('\n');

        expect(issues).toMatch(/the rolePicker field "roleId" declares a buttonsKey, which only a message field may/);
    });
});

describe('a card-summary part shown only while a choice holds a value', () => {
    const summaryManifest = (visibleWhen: unknown) =>
        manifestWith({
            ...choiceManifest({}),
            cardSummary: [{ key: 'valueType', visibleWhen }, { key: 'note' }],
        });

    it('accepts a part shown by a defaulted choice it offers', () => {
        expect(checkBlockConformance(summaryManifest({ field: 'valueType', equals: ['text'] }))).toEqual([]);
    });

    it('holds it to the same rules as a field: a choice, offering each value', () => {
        expect(checkBlockConformance(summaryManifest({ field: 'note', equals: ['x'] })).join('\n')).toMatch(
            /cardSummary\[0\] is shown by "note", which is not a select or segmented field/
        );
        expect(checkBlockConformance(summaryManifest({ field: 'valueType', equals: ['number'] })).join('\n')).toMatch(
            /cardSummary\[0\] is shown when "valueType" is "number", which it never offers/
        );
        expect(checkBlockConformance(summaryManifest({ field: 'valueType', equals: [] })).join('\n')).toMatch(
            /cardSummary\[0\] declares visibleWhen without a field name/
        );
    });

    it('catches a part shown by a choice with no default', () => {
        const manifest = manifestWith({
            ...choiceManifest({
                valueType: { defaultValue: undefined },
                schema: z.object({ valueType: z.enum(['text', 'time']), note: z.string().optional() }),
            }),
            cardSummary: [{ key: 'valueType', visibleWhen: { field: 'valueType', equals: ['text'] } }],
        });

        expect(checkBlockConformance(manifest).join('\n')).toMatch(
            /cardSummary\[0\] is shown by "valueType", which needs a declared default/
        );
    });
});

describe('an exit marked worth a warning', () => {
    const handles = (warnIfUnconnected: unknown) => [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'noRecord', label: 'No record', tone: 'caution', warnIfUnconnected },
    ];

    it('accepts true, and catches anything else', () => {
        expect(checkBlockConformance(manifestWith({ handles: handles(true) }))).toEqual([]);
        expect(checkBlockConformance(manifestWith({ handles: handles(false) })).join('\n')).toMatch(
            /output handle noRecord sets warnIfUnconnected to false/
        );
    });

    /** `choiceManifest`'s block — a defaulted `valueType` choice and an optional `note` — with these exits. */
    const withExits = (warnIfUnconnected: unknown): Record<string, unknown> => ({
        ...choiceManifest({}),
        handles: handles(warnIfUnconnected),
    });

    it('accepts a field-set condition naming its own optional field, and catches one naming none or malformed', () => {
        expect(checkBlockConformance(withExits({ whenFieldSet: 'note' }))).toEqual([]);
        expect(checkBlockConformance(withExits({ whenFieldSet: 'timeoutMs' })).join('\n')).toMatch(
            /warns only when the field "timeoutMs" is set, but declares no such field/
        );
        expect(checkBlockConformance(withExits({ whenFieldSet: 3 })).join('\n')).toMatch(
            /sets warnIfUnconnected to \{"whenFieldSet":3\}/
        );
        expect(checkBlockConformance(withExits({ whenFieldSet: 'note', extra: true })).join('\n')).toMatch(
            /sets warnIfUnconnected to/
        );
    });

    it('catches a field-set condition over a field its schema requires, which is set on every node', () => {
        // `roleId` is the one field `manifestWith`'s base block declares, and its schema requires it.
        expect(checkBlockConformance(manifestWith({ handles: handles({ whenFieldSet: 'roleId' }) })).join('\n')).toMatch(
            /warns only when the field "roleId" is set, but its configSchema requires it/
        );
    });

    it('accepts a choice condition over a defaulted choice offering every value', () => {
        expect(checkBlockConformance(withExits({ whenField: 'valueType', equals: ['time'] }))).toEqual([]);
    });

    it('catches a choice condition naming a field that is not a choice, or none', () => {
        expect(checkBlockConformance(withExits({ whenField: 'note', equals: ['x'] })).join('\n')).toMatch(
            /warns only while "note" holds certain values, but that is not a select or segmented field/
        );
        expect(checkBlockConformance(withExits({ whenField: 'mood', equals: ['x'] })).join('\n')).toMatch(
            /warns only while "mood" holds certain values, but that is not a select or segmented field/
        );
    });

    it('catches a choice condition over a choice with no default, or a value it never offers', () => {
        const noDefault = {
            ...choiceManifest({
                valueType: { defaultValue: undefined },
                schema: z.object({ valueType: z.enum(['text', 'time']), note: z.string().optional() }),
            }),
            handles: handles({ whenField: 'valueType', equals: ['time'] }),
        };
        expect(checkBlockConformance(noDefault).join('\n')).toMatch(/"valueType" declares no default/);

        expect(checkBlockConformance(withExits({ whenField: 'valueType', equals: ['time', 'number'] })).join('\n')).toMatch(
            /warns while "valueType" is "number", which it never offers/
        );
    });

    it('catches a malformed choice condition, and one mixing both shapes', () => {
        for (const malformed of [
            { whenField: 'valueType', equals: [] },
            { whenField: 'valueType', equals: 'time' },
            { whenField: 'valueType' },
            { whenField: 'valueType', equals: ['time'], whenFieldSet: 'note' },
        ]) {
            expect(checkBlockConformance(withExits(malformed)).join('\n')).toMatch(/sets warnIfUnconnected to/);
        }
    });

    it('catches a warned default exit on a block that can park, whose run would only stop', () => {
        const parking = (exits: readonly Record<string, unknown>[]) =>
            manifestWith({ canSuspend: true, handles: exits });

        expect(
            checkBlockConformance(parking([{ label: 'Then', tone: 'neutral', warnIfUnconnected: true }])).join('\n')
        ).toMatch(/output handle <default> is warned about on a block that can park, but has no id/);
        expect(
            checkBlockConformance(
                parking([
                    { label: 'Then', tone: 'neutral' },
                    { id: 'timeout', label: 'Timed out', tone: 'caution', warnIfUnconnected: true },
                ])
            )
        ).toEqual([]);
        // Not a parking block, so a default exit simply stops — which is what the builder says.
        expect(
            checkBlockConformance(manifestWith({ handles: [{ label: 'Then', tone: 'neutral', warnIfUnconnected: true }] }))
        ).toEqual([]);
    });
});

describe('what a block says it causes', () => {
    /** An action whose emission carries `carried` under `ticketType`, over the given fields. */
    const emitting = (carried: unknown, fields?: readonly Record<string, unknown>[]) =>
        manifestWith({
            configSchema: z.object({ roleId: z.string().min(1), note: z.string().optional() }),
            configFields: fields ?? [
                { key: 'roleId', label: 'Role', control: 'rolePicker' },
                { key: 'note', label: 'Note', control: 'text', rendersTokens: true },
            ],
            emits: [{ startedBy: 'ticketChanged', carries: { ticketType: carried } }],
        });

    it('passes an action carrying a literal or one of its own plain fields', () => {
        expect(checkBlockConformance(emitting({ value: 'opened' }))).toEqual([]);
        expect(checkBlockConformance(emitting({ fromField: 'roleId' }))).toEqual([]);
        expect(checkBlockConformance(manifestWith({ emits: [{ startedBy: 'memberLeave' }] }))).toEqual([]);
    });

    it('catches a trigger declaring an emission, since a trigger is the event and not an action', () => {
        const issues = checkBlockConformance(
            manifestWith({ kind: 'trigger', group: 'triggers', startedBy: 'memberLeave', emits: [{ startedBy: 'memberLeave' }] })
        );

        expect(issues.join()).toMatch(/is a trigger, but declares what it emits/);
    });

    it('catches a fromField that is not one of its own config fields', () => {
        expect(checkBlockConformance(emitting({ fromField: 'ticketKind' })).join()).toMatch(
            /from "ticketKind", which is not one of its config fields/
        );
    });

    it('catches a fromField naming a field that renders tokens, or a picker that takes a variable', () => {
        expect(checkBlockConformance(emitting({ fromField: 'note' })).join()).toMatch(/from "note", which can hold a \{\{var\}\}/);

        const picker = manifestWith({
            configSchema: z.object({ channelId: z.string().min(1) }),
            configFields: [{ key: 'channelId', label: 'Channel', control: 'channelPicker' }],
            emits: [{ startedBy: 'ticketChanged', carries: { ticketType: { fromField: 'channelId' } } }],
        });
        expect(checkBlockConformance(picker).join()).toMatch(/from "channelId", which can hold a \{\{var\}\}/);
    });

    it('catches a fromField naming a message, every part of which is copy', () => {
        const message = manifestWith({
            configSchema: z.object({ message: messageConfigSchema }),
            configFields: [{ key: 'message', label: 'Message', control: 'message' }],
            emits: [{ startedBy: 'ticketChanged', carries: { ticketType: { fromField: 'message' } } }],
        });

        expect(checkBlockConformance(message).join()).toMatch(/from "message", which can hold a \{\{var\}\}/);
    });

    it('catches a fromField naming a list with a copy column, and passes one without', () => {
        const list = (rendersTokens: boolean) =>
            manifestWith({
                configSchema: z.object({ rows: z.array(z.object({ value: z.string().min(1) })).default([]) }),
                configFields: [
                    {
                        key: 'rows',
                        label: 'Rows',
                        control: 'objectList',
                        defaultValue: [],
                        columns: [{ key: 'value', label: 'Text', control: 'longText', rendersTokens }],
                    },
                ],
                emits: [{ startedBy: 'ticketChanged', carries: { ticketType: { fromField: 'rows' } } }],
            });

        expect(checkBlockConformance(list(true)).join()).toMatch(/from "rows", which can hold a \{\{var\}\}/);
        expect(checkBlockConformance(list(false)).join()).not.toMatch(/from "rows"/);
    });

    it('catches a carried value of neither shape, and a source outside the vocabulary', () => {
        expect(checkBlockConformance(emitting({ value: 'opened', fromField: 'roleId' })).join()).toMatch(
            /Carry \{ value: "<literal>" \}, or \{ fromField: "<field>" \}/
        );
        expect(checkBlockConformance(manifestWith({ emits: [{ startedBy: 'ticketExploded' }] })).join()).toMatch(
            /emits\.startedBy "ticketExploded" is not in the vocabulary/
        );
    });
});

describe('what an emission carries, against the triggers listening for it', () => {
    /** A trigger on `ticketChanged` with a select `event` and a free-text `ticketType`. */
    const listener = asManifest(
        manifestWith({
            type: 'fixture.listener',
            kind: 'trigger',
            group: 'triggers',
            startedBy: 'ticketChanged',
            configSchema: z.object({ event: z.enum(['opened', 'closed']).default('opened'), ticketType: z.string().optional() }),
            configFields: [
                {
                    key: 'event',
                    label: 'Event',
                    control: 'select',
                    defaultValue: 'opened',
                    options: [
                        { value: 'opened', label: 'Opened' },
                        { value: 'closed', label: 'Closed' },
                    ],
                },
                { key: 'ticketType', label: 'Type', control: 'text' },
            ],
        })
    );
    const emitter = (carries: Record<string, unknown>) =>
        asManifest(manifestWith({ emits: [{ startedBy: 'ticketChanged', carries }] }));

    it('passes carried keys the listener declares, and literals among its options', () => {
        expect(checkEmissionTargets([listener, emitter({ event: { value: 'closed' }, ticketType: { fromField: 'roleId' } })])).toEqual(
            []
        );
    });

    it('catches a carried key no trigger on that source declares, which would match every one', () => {
        expect(checkEmissionTargets([listener, emitter({ ticketKind: { value: 'support' } })]).join()).toMatch(
            /carries "ticketKind", but no trigger started by "ticketChanged" has that field/
        );
    });

    it('catches a literal outside the options of the field it is compared with, which would match none', () => {
        expect(checkEmissionTargets([listener, emitter({ event: { value: 'exploded' } })]).join()).toMatch(
            /carries "event" as "exploded", which that field never offers \(opened, closed\)/
        );
    });
});

describe('the contract fixture blocks', () => {
    it('each conform, so what they prove is the contract and not a stub of it', async () => {
        const discovered = await discoverBlocks<BlockManifest>(
            path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'blocks', 'contract')
        );

        expect(discovered.size).toBeGreaterThan(0);
        for (const block of discovered.values()) {
            expect(checkBlockConformance(block), block.type).toEqual([]);
        }
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

    it('catches a trigger offering an eligibility rule nothing would enforce', () => {
        // The worst failure mode a permission control has: it saves, it draws a
        // padlock on the card, and it admits everybody — silent at every layer
        // somebody would think to look. Only the dispatchers named in
        // ELIGIBILITY_ENFORCED_SOURCES actually read a rule, so a trigger on any
        // other source has to fail here instead.
        const issues = checkBlockConformance(
            manifestWith({
                kind: 'trigger',
                startedBy: 'memberJoin',
                configSchema: z.object({ eligibility: z.unknown() }),
                configFields: [{ key: 'eligibility', label: 'Who', control: 'eligibility' }],
            })
        );

        expect(issues.join()).toMatch(/nothing checks one for a "memberJoin" trigger/);
    });

    it('says nothing about a non-trigger, which has no source to judge it by', () => {
        // Pins the early return rather than trusting it, and without this a check
        // that returned `[]` for every input would look identical to the working
        // one above.
        //
        // The exemption is forced, not lax: an action is reached by an edge, so
        // `startedBy` says nothing about it, and the only other way to judge one
        // is a list of block types — which `blockTypeBranching` rejects as a
        // second catalogue. `action.prompt`'s own rule is enforced by the
        // dispatcher routing its answers.
        const issues = checkBlockConformance(
            manifestWith({
                kind: 'action',
                configSchema: z.object({ eligibility: z.unknown() }),
                configFields: [{ key: 'eligibility', label: 'Who', control: 'eligibility' }],
            })
        );

        expect(issues.join()).not.toMatch(/checks one/);
    });

    describe('a messageButton field outside a Button Click trigger', () => {
        const withButtonField = (patch: Record<string, unknown>) =>
            manifestWith({
                configSchema: z.object({ button: buttonClickConfigSchema.shape.button }),
                configFields: [{ key: 'button', label: 'Button', control: 'messageButton' }],
                ...patch,
            });

        it('passes a trigger started by a button click', () => {
            // The positive control: without it, a check refusing every messageButton field
            // would look the same as the one below.
            expect(
                checkBlockConformance(withButtonField({ kind: 'trigger', group: 'triggers', startedBy: 'buttonClick' }))
            ).toEqual([]);
        });

        it('catches one on an action, which no press ever reaches', () => {
            // It would claim the button, keep every other flow off it and be listed as its
            // listener, while the press router answered only Button Click triggers.
            const issues = checkBlockConformance(withButtonField({})).join('\n');

            expect(issues).toMatch(/declares the messageButton field "button", but is of kind "action"\./);
        });

        it('catches one on a trigger started by anything else', () => {
            const issues = checkBlockConformance(
                withButtonField({ kind: 'trigger', group: 'triggers', startedBy: 'memberJoin' })
            ).join('\n');

            expect(issues).toMatch(/declares the messageButton field "button", but is started by "memberJoin"\./);
        });
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

    /**
     * A block can route by *which* option was picked, not merely that one was.
     *
     * `action.prompt` now ships and does exactly this, but the fixture stays: it
     * proves the capability against the smallest block that reads an index and
     * answers with a matching handle, rather than against one block's config, so
     * a change to the prompt's own schema cannot quietly stop testing the
     * engine's delivery of the index. It is what makes `choice` a
     * capability rather than a third word in a type: without it, the variant could
     * carry an index that nothing has ever read, and the first code to try would
     * be the first to find out whether the engine delivered it.
     */
    it('lets a block answer by which choice was taken', async () => {
        const choosy = asManifest(
            manifestWith({
                canSuspend: true,
                handles: [
                    { id: 'first', label: 'First', tone: 'neutral' },
                    { id: 'second', label: 'Second', tone: 'neutral' },
                ],
                run: (_config: unknown, given: FlowRunContext) => {
                    if (!given.resume) {
                        return { kind: 'suspend', suspension: {} };
                    }
                    // The whole point: the index decides the branch.
                    return {
                        kind: 'continue',
                        handle: given.resume.kind === 'choice' && given.resume.index === 1 ? 'second' : 'first',
                    };
                },
            })
        );

        // Conformance drives it with one reason of each shape and must find nothing
        // wrong — including that it stops re-parking when handed a choice.
        expect(await checkBlockOutcome(choosy, {}, context)).toEqual([]);

        const tookSecond = await choosy.run({}, { ...context, resume: { kind: 'choice', index: 1 } });
        expect(tookSecond).toEqual({ kind: 'continue', handle: 'second' });

        const tookFirst = await choosy.run({}, { ...context, resume: { kind: 'choice', index: 0 } });
        expect(tookFirst).toEqual({ kind: 'continue', handle: 'first' });
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

    it('emits only what some trigger listening for it can hold', () => {
        // The one check across blocks: a carried key or literal is only meaningful
        // against the triggers on its source, so it runs over the whole registry.
        expect(checkEmissionTargets(shipped)).toEqual([]);
    });

    it('declares a suspending block honestly', () => {
        // `canSuspend` is documentation the executor never reads, so nothing else
        // would notice a block that lies about it. Every block that parks says so.
        const suspending = shipped.filter((block) => block.canSuspend).map((block) => block.type);

        expect(suspending.toSorted()).toEqual(['action.delay', 'action.prompt', 'action.waitForEvent']);
    });

    it('comes back when a suspending block is woken, rather than parking forever', async () => {
        // The guard that matters most, run against what actually ships rather
        // than only the fixture: a block that forgets to check `context.resume`
        // parks, wakes, parks again, and nothing downstream ever notices.
        const configs: Readonly<Record<string, unknown>> = {
            'action.delay': { durationMs: 1000 },
            'action.waitForEvent': { eventKind: 'memberJoin' },
            'action.prompt': { question: 'Well?', choices: ['Yes', 'No'] },
        };

        const suspending = shipped.filter((block) => block.canSuspend);
        expect(suspending.length).toBeGreaterThan(0);

        for (const block of suspending) {
            const config = configs[block.type];
            expect(config, `no probe config for the suspending block ${block.type}`).toBeDefined();
            // A channel that swallows what it is sent, because `action.prompt`
            // posts its question on the parking leg. Given to every block rather
            // than to that one by name: a probe that knows which block needs a
            // channel is a probe that stops being a census.
            //
            // Parsed first, because `run` is only ever handed validated config: a
            // block reading a key its schema defaults must see the default, as it
            // would from the executor, not the absence of the raw probe.
            const parsed = block.configSchema.parse(config);
            expect(await checkBlockOutcome(block, parsed, { ...context, channel: sink() })).toEqual([]);
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
