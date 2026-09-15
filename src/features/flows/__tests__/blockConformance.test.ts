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
    nodeId: 'node-1',
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
    it('says nothing about correct columns under a schema with a list minimum', () => {
        expect(
            checkBlockConformance(
                manifestWith({
                    configSchema: z.object({ rows: z.array(entry).min(2).max(5) }),
                    configFields: [
                        {
                            key: 'rows',
                            label: 'Rows',
                            control: 'objectList',
                            minEntries: 2,
                            maxEntries: 5,
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

    it('catches an output with no label for the builder to show', () => {
        const issues = checkBlockConformance(
            manifestWith({ outputs: [{ naming: 'fixed', key: 'thing', label: '' }] })
        );

        expect(issues.join('\n')).toMatch(/needs a label the builder can show/);
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
            expect(await checkBlockOutcome(block, config, { ...context, channel: sink() })).toEqual([]);
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
