import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@hey-api/openapi-ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SDK_GENERATOR_CONFIG } from '../openapi-ts.config';

/**
 * The resolvers in `zodMessageResolvers.ts`, run through the real generator config against
 * a small spec holding each shape a sentence can arrive in — including the ones no route
 * sends yet (nullable fields wherever they nest, numbers, arrays, a pattern, an inline
 * operation body), so the first route that does finds them already working.
 *
 * Asserted on the generated source, one property line at a time: the test cannot import
 * what it generates into a temp directory, which has no `zod` to resolve.
 */

/** A nullable string worded at one bound. */
function nullableString(bound: 'minLength' | 'maxLength', size: number, sentence: string) {
    return { type: ['string', 'null'], [bound]: size, 'x-messages': { [bound]: sentence } };
}

const SPEC = {
    openapi: '3.1.0',
    info: { title: 'resolver fixture', version: '1.0.0' },
    paths: {
        '/things/{thingId}': {
            put: {
                operationId: 'saveThing',
                parameters: [
                    {
                        name: 'thingId',
                        in: 'path',
                        required: true,
                        schema: { type: 'string', pattern: '^[a-z0-9_-]+$', 'x-messages': { pattern: 'Not a thing id.' } },
                    },
                ],
                // Inline, not a `$ref`: hey-api walks it under an operation path of its own.
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: { inlineNote: nullableString('maxLength', 40, 'Inline notes cap at 40.') },
                            },
                        },
                    },
                },
                responses: { 204: { description: 'Saved.' } },
            },
        },
    },
    components: {
        schemas: {
            Sample: {
                type: 'object',
                properties: {
                    nullableName: nullableString('minLength', 1, 'Name it, or null it.'),
                    code: {
                        type: 'string',
                        minLength: 4,
                        maxLength: 4,
                        'x-messages': { minLength: 'Four exactly.', maxLength: 'Four exactly.' },
                    },
                    split: {
                        type: 'string',
                        minLength: 2,
                        maxLength: 2,
                        'x-messages': { minLength: 'Too short.', maxLength: 'Too long.' },
                    },
                    slug: { type: 'string', pattern: '^[a-z]+$', 'x-messages': { pattern: 'Lowercase only.' } },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        minItems: 1,
                        maxItems: 5,
                        'x-messages': { minItems: 'At least one tag.', maxItems: 'Five tags at most.' },
                    },
                    count: {
                        type: 'number',
                        exclusiveMinimum: 0,
                        maximum: 10,
                        'x-messages': { exclusiveMinimum: 'Above zero.', maximum: 'Ten at most.' },
                    },
                    whole: {
                        type: 'integer',
                        minimum: 1,
                        'x-messages': { integer: 'Whole numbers only.', minimum: 'One or more.' },
                    },
                    choice: {
                        anyOf: [
                            { type: 'string', minLength: 1, 'x-messages': { minLength: 'The branch sentence.' } },
                            { type: 'number', minimum: 1 },
                        ],
                    },
                    plain: { type: 'string', minLength: 1 },
                    // Nullable parts deeper in: an array element, a property of an array's
                    // object element, a property inside a union branch, and a nullable array.
                    nullableTags: { type: 'array', items: nullableString('minLength', 1, 'No empty tags.') },
                    rows: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { rowName: nullableString('maxLength', 20, 'Row names cap at 20.') },
                        },
                    },
                    branch: {
                        anyOf: [
                            {
                                type: 'object',
                                properties: { branchName: nullableString('minLength', 2, 'Two letters at least.') },
                            },
                            { type: 'number' },
                        ],
                    },
                    maybeList: {
                        type: ['array', 'null'],
                        items: { type: 'string' },
                        maxItems: 3,
                        'x-messages': { maxItems: 'Three at most.' },
                    },
                },
                required: ['code'],
            },
        },
    },
};

/** `value` with every `x-messages` removed, at any depth: the spec hey-api would see without this pipeline. */
function withoutMessages(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(withoutMessages);
    }
    if (typeof value !== 'object' || value === null) {
        return value;
    }
    const entries: [string, unknown][] = Object.entries(value);
    return Object.fromEntries(
        entries.filter(([key]) => key !== 'x-messages').map(([key, entry]) => [key, withoutMessages(entry)])
    );
}

/** Generates `spec` with the real config into a fresh temp directory and returns its `zod.gen.ts`. */
async function generateZod(spec: unknown, roots: string[]): Promise<string> {
    const outputRoot = mkdtempSync(join(tmpdir(), 'web-sdk-resolvers-'));
    roots.push(outputRoot);
    await createClient({
        ...SDK_GENERATOR_CONFIG,
        input: { path: spec },
        output: { ...SDK_GENERATOR_CONFIG.output, path: outputRoot },
        logs: { level: 'silent', file: false },
    });
    return readFileSync(join(outputRoot, 'zod.gen.ts'), 'utf8');
}

/**
 * Every message in a thrown error and the errors it wraps. hey-api rethrows a job's error
 * as a `JobError` with an empty message, the original under `originalError.error`.
 */
function messageChain(thrown: unknown, seen = new Set<unknown>()): string {
    if (typeof thrown !== 'object' || thrown === null || seen.has(thrown)) {
        return '';
    }
    seen.add(thrown);
    const own: unknown = Reflect.get(thrown, 'message');
    const wrapped = ['originalError', 'error', 'cause'].map((key) => messageChain(Reflect.get(thrown, key), seen));
    return [typeof own === 'string' ? own : '', ...wrapped].filter(Boolean).join(' / ');
}

/** A quoted message argument closing a call: `, 'Too short.')` loses `, 'Too short.'`. */
const MESSAGE_ARGUMENT = /, '(?:[^'\\]|\\.)*'(?=\))/g;

describe('zod message resolvers', () => {
    const outputRoots: string[] = [];
    let zodSource: string;
    let unwordedSource: string;

    beforeAll(async () => {
        zodSource = await generateZod(SPEC, outputRoots);
        unwordedSource = await generateZod(withoutMessages(SPEC), outputRoots);
        // See `generatedSdkIsCurrent.test.ts`: a hook gets 10s, and a cold generator under load is slower.
    }, 30_000);

    afterAll(() => {
        for (const root of outputRoots) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    /** The generated rule for one property, without its trailing comma. */
    function ruleFor(property: string): string | undefined {
        const line = zodSource.split(/\r?\n/).find((candidate) => candidate.trimStart().startsWith(`${property}: `));
        return line?.trim().replace(/,$/, '');
    }

    it('carries a nullable field’s sentence, which hey-api drops from the split parts', () => {
        // `.nullish()` is hey-api's spelling of nullable and optional.
        expect(ruleFor('nullableName')).toBe("nullableName: z.string().min(1, 'Name it, or null it.').nullish()");
    });

    it('carries a nullable part’s sentence wherever it nests', () => {
        expect(ruleFor('nullableTags')).toBe(
            "nullableTags: z.array(z.string().min(1, 'No empty tags.').nullable()).optional()"
        );
        expect(ruleFor('rowName')).toBe("rowName: z.string().max(20, 'Row names cap at 20.').nullish()");
        expect(ruleFor('branchName')).toBe("branchName: z.string().min(2, 'Two letters at least.').nullish()");
        expect(ruleFor('maybeList')).toBe("maybeList: z.array(z.string()).max(3, 'Three at most.').nullish()");
    });

    it('carries the sentences of an inline operation body and a path parameter', () => {
        expect(ruleFor('inlineNote')).toBe("inlineNote: z.string().max(40, 'Inline notes cap at 40.').nullish()");
        expect(ruleFor('thingId')).toBe("thingId: z.string().regex(/^[a-z0-9_-]+$/, 'Not a thing id.')");
    });

    it('words `.length` once when both bounds share a sentence', () => {
        expect(ruleFor('code')).toBe("code: z.string().length(4, 'Four exactly.')");
    });

    it('splits `.length` into `.min` and `.max` when the bounds have different sentences', () => {
        expect(ruleFor('split')).toBe("split: z.string().min(2, 'Too short.').max(2, 'Too long.').optional()");
    });

    it('words a pattern', () => {
        expect(ruleFor('slug')).toBe("slug: z.string().regex(/^[a-z]+$/, 'Lowercase only.').optional()");
    });

    it('words an array’s bounds', () => {
        expect(ruleFor('tags')).toBe(
            "tags: z.array(z.string()).min(1, 'At least one tag.').max(5, 'Five tags at most.').optional()"
        );
    });

    it('words a number’s bounds, exclusive and inclusive', () => {
        expect(ruleFor('count')).toBe("count: z.number().gt(0, 'Above zero.').lte(10, 'Ten at most.').optional()");
    });

    it('words a whole-number rule on a plain number, so a non-number keeps zod’s own sentence', () => {
        expect(ruleFor('whole')).toBe("whole: z.number().int('Whole numbers only.').gte(1, 'One or more.').optional()");
    });

    it('keeps each union branch to its own sentences', () => {
        // The union spans several lines; compared with its whitespace collapsed.
        expect(zodSource.replace(/\s+/g, ' ')).toContain(
            "choice: z.union([ z.string().min(1, 'The branch sentence.'), z.number().gte(1) ]).optional()"
        );
    });

    it('leaves a rule without a sentence to zod’s default', () => {
        expect(ruleFor('plain')).toBe('plain: z.string().min(1).optional()');
    });

    /*
     * The replacement nodes repeat hey-api's calls for the length and bound rules. With the
     * sentences taken back out, every line must be hey-api's own for the same spec — so an
     * upgrade that changes how hey-api writes a rule fails here, not in a browser.
     * Two deliberate differences: `split`, where two sentences need `.min` and `.max` where
     * hey-api writes `.length(2)`, and `whole`, where a worded whole-number rule is
     * `z.number().int(…)` where hey-api writes `z.int()` (see the case above).
     */
    it('writes every rule exactly as hey-api does, but for the sentence', () => {
        const isDeliberate = (line: string): boolean => /^\s*(split|whole): /.test(line);
        const worded = zodSource
            .split(/\r?\n/)
            .filter((line) => !isDeliberate(line))
            .map((line) => line.replace(MESSAGE_ARGUMENT, ''));
        const unworded = unwordedSource.split(/\r?\n/).filter((line) => !isDeliberate(line));

        expect(worded).toEqual(unworded);
        // Everything after the base of `whole` is hey-api's own.
        expect(unwordedSource).toContain('whole: z.int().gte(1).optional()');
    });

    it('fails the generation when a union that is not a nullable pair carries sentences', async () => {
        const spec = {
            ...SPEC,
            paths: {},
            components: {
                schemas: {
                    Odd: {
                        anyOf: [{ type: 'string', minLength: 1 }, { type: 'number' }],
                        'x-messages': { minLength: 'Whose is this?' },
                    },
                },
            },
        };

        const failure: unknown = await generateZod(spec, outputRoots).then(
            () => undefined,
            (error: unknown) => error
        );

        expect(failure, 'The generation succeeded.').toBeDefined();
        expect(messageChain(failure)).toContain('is not a nullable pair');
    }, 20_000);
});
