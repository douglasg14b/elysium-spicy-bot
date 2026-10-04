import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, type OpenApiDocument } from '../openApiDocument';
import { jsonBody } from '../openApi';
import { attachRequestMessages } from '../requestMessages';

/**
 * `attachRequestMessages`, judged by the document generated after it — where zod-to-openapi
 * actually puts `x-messages` — rather than by the metadata it writes, which could be right
 * while the spec is not.
 *
 * Each test builds its own schemas: the metadata is process-wide, so sharing one between
 * tests would let an earlier test's walk answer for a later one.
 */

type RequestParts = NonNullable<Parameters<typeof createRoute>[0]['request']>;

const RESPONSES = { 204: { description: 'Done.' } };

/** A `PUT /things/{thingId}` route taking `request`, as `apiRouter` routes are declared. */
function thingRoute(request: RequestParts) {
    return createRoute({ method: 'put', path: '/things/{thingId}', request, responses: RESPONSES });
}

/** The document for `routes`, generated after the messages are attached. */
function documentFor(...routes: ReturnType<typeof thingRoute>[]): OpenApiDocument {
    const app = new OpenAPIHono();
    for (const route of routes) {
        app.openAPIRegistry.registerPath(route);
    }
    attachRequestMessages(app.openAPIRegistry.definitions);
    return app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'requestMessages', version: '1' } });
}

/** The document for a route whose JSON body is `body`. */
function documentForBody(body: z.ZodType): OpenApiDocument {
    return documentFor(thingRoute({ body: jsonBody(body) }));
}

/** The value at `path` inside `root`, or `undefined` where the path leaves it. */
function valueAt(root: unknown, ...path: (string | number)[]): unknown {
    let node = root;
    for (const key of path) {
        if (typeof node !== 'object' || node === null) {
            return undefined;
        }
        node = Reflect.get(node, key);
    }
    return node;
}

/** The emitted inline JSON body schema of the route `documentFor` builds. */
function bodySchema(document: OpenApiDocument): unknown {
    return valueAt(document, 'paths', '/things/{thingId}', 'put', 'requestBody', 'content', 'application/json', 'schema');
}

/** The emitted schema of one property of the inline body. */
function bodyProperty(document: OpenApiDocument, ...path: (string | number)[]): unknown {
    return valueAt(bodySchema(document), ...path);
}

/** The message `attachRequestMessages` throws for `body`, or `undefined` when it does not throw. */
function failureFor(body: z.ZodType): string | undefined {
    try {
        documentForBody(body);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

describe('attachRequestMessages', () => {
    describe('each keyword', () => {
        it('words a string’s length bounds', () => {
            const document = documentForBody(
                z.object({ name: z.string().min(1, 'Name it.').max(10, 'Ten at most.') })
            );

            expect(bodyProperty(document, 'properties', 'name')).toEqual({
                type: 'string',
                minLength: 1,
                maxLength: 10,
                'x-messages': { minLength: 'Name it.', maxLength: 'Ten at most.' },
            });
        });

        it('words an exact string length as both bounds', () => {
            const document = documentForBody(z.object({ code: z.string().length(4, 'Four exactly.') }));

            expect(valueAt(bodyProperty(document, 'properties', 'code'), 'x-messages')).toEqual({
                minLength: 'Four exactly.',
                maxLength: 'Four exactly.',
            });
        });

        it('words an array’s bounds as item counts', () => {
            const document = documentForBody(
                z.object({ tags: z.array(z.string()).min(1, 'One tag at least.').max(5, 'Five tags at most.') })
            );

            expect(bodyProperty(document, 'properties', 'tags')).toMatchObject({
                minItems: 1,
                maxItems: 5,
                'x-messages': { minItems: 'One tag at least.', maxItems: 'Five tags at most.' },
            });
        });

        it('words inclusive and exclusive number bounds by the keyword each emits', () => {
            const document = documentForBody(
                z.object({
                    inclusive: z.number().gte(1, 'One or more.').lte(9, 'Nine or fewer.'),
                    exclusive: z.number().gt(0, 'Above zero.').lt(10, 'Below ten.'),
                })
            );

            expect(bodyProperty(document, 'properties', 'inclusive')).toMatchObject({
                minimum: 1,
                maximum: 9,
                'x-messages': { minimum: 'One or more.', maximum: 'Nine or fewer.' },
            });
            expect(bodyProperty(document, 'properties', 'exclusive')).toMatchObject({
                exclusiveMinimum: 0,
                exclusiveMaximum: 10,
                'x-messages': { exclusiveMinimum: 'Above zero.', exclusiveMaximum: 'Below ten.' },
            });
        });

        it('words a whole-number rule beside the `integer` type it emits', () => {
            const document = documentForBody(z.object({ count: z.number().int('Whole numbers only.').gte(1, 'One or more.') }));

            expect(bodyProperty(document, 'properties', 'count')).toEqual({
                type: 'integer',
                minimum: 1,
                'x-messages': { integer: 'Whole numbers only.', minimum: 'One or more.' },
            });
        });

        it('words a pattern', () => {
            const document = documentForBody(z.object({ slug: z.string().regex(/^[a-z]+$/, 'Lowercase only.') }));

            expect(bodyProperty(document, 'properties', 'slug')).toMatchObject({
                pattern: '^[a-z]+$',
                'x-messages': { pattern: 'Lowercase only.' },
            });
        });

        it('reads a message given as `{ message }` or as an error function that ignores the issue', () => {
            const document = documentForBody(
                z.object({
                    viaMessage: z.string().min(1, { message: 'Said as a message.' }),
                    viaFunction: z.string().min(1, { error: () => ({ message: 'Said by a function.' }) }),
                })
            );

            expect(valueAt(bodyProperty(document, 'properties', 'viaMessage'), 'x-messages')).toEqual({
                minLength: 'Said as a message.',
            });
            expect(valueAt(bodyProperty(document, 'properties', 'viaFunction'), 'x-messages')).toEqual({
                minLength: 'Said by a function.',
            });
        });
    });

    describe('what it leaves alone', () => {
        it('adds nothing for rules without a custom message, and `.trim()` hides no sentence', () => {
            const document = documentForBody(
                z.object({
                    plain: z.string().min(1),
                    whole: z.number().int(),
                    when: z.iso.datetime(),
                    // A format's own flagged pattern never reaches the spec, so it is no `.regex()` with flags.
                    emoji: z.emoji(),
                    trimmed: z.string().trim().min(1, 'Not just spaces.'),
                })
            );

            expect(valueAt(bodyProperty(document, 'properties', 'plain'), 'x-messages')).toBeUndefined();
            expect(valueAt(bodyProperty(document, 'properties', 'whole'), 'x-messages')).toBeUndefined();
            expect(valueAt(bodyProperty(document, 'properties', 'when'), 'x-messages')).toBeUndefined();
            expect(valueAt(bodyProperty(document, 'properties', 'emoji'), 'x-messages')).toBeUndefined();
            expect(valueAt(bodyProperty(document, 'properties', 'trimmed'), 'x-messages')).toEqual({
                minLength: 'Not just spaces.',
            });
        });

        it('keeps the metadata a node already had', () => {
            const document = documentForBody(
                z.object({ name: z.string().min(1, 'Name it.').meta({ description: 'What it is called.' }) })
            );

            expect(bodyProperty(document, 'properties', 'name')).toMatchObject({
                description: 'What it is called.',
                'x-messages': { minLength: 'Name it.' },
            });
        });
    });

    describe('where it looks', () => {
        it('reaches rules nested in objects, arrays and wrappers', () => {
            const document = documentForBody(
                z.object({
                    groups: z
                        .array(
                            z.object({
                                label: z.string().min(1, 'Label the group.').optional(),
                                members: z.array(z.string().max(32, 'Names cap at 32.')).default([]),
                            })
                        )
                        .readonly(),
                })
            );

            const group = ['properties', 'groups', 'items', 'properties'] as const;
            expect(valueAt(bodyProperty(document, ...group, 'label'), 'x-messages')).toEqual({
                minLength: 'Label the group.',
            });
            expect(valueAt(bodyProperty(document, ...group, 'members', 'items'), 'x-messages')).toEqual({
                maxLength: 'Names cap at 32.',
            });
        });

        it('keeps a nullable field’s sentence beside its rule', () => {
            const document = documentForBody(z.object({ note: z.string().max(50, 'Fifty at most.').nullable() }));

            expect(bodyProperty(document, 'properties', 'note')).toEqual({
                type: ['string', 'null'],
                maxLength: 50,
                'x-messages': { maxLength: 'Fifty at most.' },
            });
        });

        it('gives each union branch its own sentences', () => {
            const document = documentForBody(
                z.object({ either: z.union([z.string().min(3, 'Three letters.'), z.number().max(5, 'Five or fewer.')]) })
            );

            expect(bodyProperty(document, 'properties', 'either', 'anyOf')).toEqual([
                { type: 'string', minLength: 3, 'x-messages': { minLength: 'Three letters.' } },
                { type: 'number', maximum: 5, 'x-messages': { maximum: 'Five or fewer.' } },
            ]);
        });

        it('reaches path parameters and query parameters', () => {
            const document = documentFor(
                thingRoute({
                    params: z.object({ thingId: z.string().regex(/^[a-z0-9_-]+$/, 'Not a thing id.') }),
                    query: z.object({ sort: z.string().max(20, 'Sort keys cap at 20.').optional() }),
                })
            );

            const parameters = valueAt(document, 'paths', '/things/{thingId}', 'put', 'parameters');
            expect(parameters).toEqual([
                expect.objectContaining({
                    in: 'path',
                    name: 'thingId',
                    schema: { type: 'string', pattern: '^[a-z0-9_-]+$', 'x-messages': { pattern: 'Not a thing id.' } },
                }),
                expect.objectContaining({
                    in: 'query',
                    name: 'sort',
                    schema: { type: 'string', maxLength: 20, 'x-messages': { maxLength: 'Sort keys cap at 20.' } },
                }),
            ]);
        });

        it('writes a named component’s sentences into the component, not the route', () => {
            const named = z.object({ title: z.string().min(1, 'Title it.') }).openapi('NamedThing');
            const document = documentForBody(named);

            expect(bodySchema(document)).toEqual({ $ref: '#/components/schemas/NamedThing' });
            expect(valueAt(document, 'components', 'schemas', 'NamedThing', 'properties', 'title')).toEqual({
                type: 'string',
                minLength: 1,
                'x-messages': { minLength: 'Title it.' },
            });
        });
    });

    it('is idempotent: attaching twice gives the same document as once', () => {
        const app = new OpenAPIHono();
        app.openAPIRegistry.registerPath(
            thingRoute({
                body: jsonBody(
                    z.object({ name: z.string().min(1, 'Name it.') }).openapi('IdempotentThing')
                ),
            })
        );
        const generate = () =>
            app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'requestMessages', version: '1' } });

        attachRequestMessages(app.openAPIRegistry.definitions);
        const once = generate();
        attachRequestMessages(app.openAPIRegistry.definitions);

        expect(generate()).toEqual(once);
    });

    it('is idempotent across apps: the real document builds the same twice over shared schemas', async () => {
        // The second build walks schema objects the first already wrote to.
        expect(await buildOpenApiDocument()).toEqual(await buildOpenApiDocument());
    });

    describe('fails loudly, naming the route and field', () => {
        it('on a message that reads the issue', () => {
            const failure = failureFor(
                z.object({ name: z.string().min(2, { error: (issue) => `At least ${String(issue.minimum)}.` }) })
            );

            expect(failure).toContain('PUT /things/{thingId} body.name');
            expect(failure).toContain('reads minimum');
        });

        it('on a `.refine()`', () => {
            const failure = failureFor(
                z.object({ from: z.number(), to: z.number() }).refine((range) => range.from <= range.to, 'Backwards.')
            );

            expect(failure).toContain('PUT /things/{thingId} body:');
            expect(failure).toContain('.refine()');
        });

        it('on a `z.custom()`', () => {
            const failure = failureFor(
                z.object({ even: z.custom<number>((value) => typeof value === 'number' && value % 2 === 0) })
            );

            // Once, as itself — not a second time as a `.refine()`.
            expect(failure?.split('\n').filter((line) => line.includes('body.even'))).toEqual([
                expect.stringContaining('PUT /things/{thingId} body.even: a `z.custom()` schema'),
            ]);
            expect(failure).not.toContain('.refine()');
        });

        it('on a regex with flags', () => {
            const failure = failureFor(z.object({ word: z.string().regex(/^abc$/i, 'Say abc.') }));

            expect(failure).toContain('PUT /things/{thingId} body.word');
            expect(failure).toContain('/^abc$/i has flags');
        });

        it('on a fixed sentence with no keyword to travel beside', () => {
            // `z.int('…')` words a value that is not a number as well; `.int('…')` travels.
            const ruleFailure = failureFor(z.object({ count: z.int('Whole numbers only.') }));
            const typeFailure = failureFor(z.object({ label: z.string('Text, please.') }));
            // zod-to-openapi drops an array's exact length from the spec altogether.
            const arrayLengthFailure = failureFor(z.object({ pair: z.array(z.string()).length(2, 'Two exactly.') }));

            expect(ruleFailure).toContain('PUT /things/{thingId} body.count');
            expect(ruleFailure).toContain('"Whole numbers only."');
            expect(typeFailure).toContain('PUT /things/{thingId} body.label');
            expect(typeFailure).toContain('"Text, please."');
            expect(arrayLengthFailure).toContain('PUT /things/{thingId} body.pair');
            expect(arrayLengthFailure).toContain('"Two exactly."');
        });

        it('on two rules feeding one keyword when only one is worded', () => {
            // The spec emits one `minLength` — 3 — and the sentence would sit beside it.
            const failure = failureFor(z.object({ name: z.string().min(1, 'Name it.').min(3) }));

            expect(failure).toContain('PUT /things/{thingId} body.name');
            expect(failure).toContain('2 rules feed `minLength`');
        });
    });
});
