import { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { listBlockDefinitions } from '../../../features/flows/blocks/registry';
import { VARIABLE_NAME_MESSAGE } from '../../../features/flows/blocks/variableName';
import type { BlockSchemaSource } from '../../../features/flows/logic/blockFieldRules';
import { blockWith } from '../../../features/flows/logic/__tests__/support/blockWith';
import { FLOW_BLOCK_FIELD_RULES, flowBlockFieldRulesSchema } from '../flowBlockFieldRules';
import { buildOpenApiDocument, type OpenApiDocument } from '../openApiDocument';
import { attachRequestMessages } from '../requestMessages';

/**
 * The Flow Builder's field rules as the spec carries them, and the failures that keep a
 * rule from reaching the browser unfaithfully. That the generated zod then agrees with the
 * server, value by value, is `features/flows/logic/__tests__/blockFieldRules.test.ts`.
 */

type Block = BlockSchemaSource;

let document: OpenApiDocument;

beforeAll(async () => {
    // Discovers the blocks too, which `listBlockDefinitions` below needs.
    document = await buildOpenApiDocument();
});

/** The component's schema for one block, or one field of it. */
function ruleSchema(type: string, field?: string): Readonly<Record<string, unknown>> | undefined {
    const component = document.components?.schemas?.[FLOW_BLOCK_FIELD_RULES] as
        | { properties?: Record<string, { properties?: Record<string, Readonly<Record<string, unknown>>> }> }
        | undefined;
    const block = component?.properties?.[type];
    return field === undefined ? block : block?.properties?.[field];
}

/** The message `attachRequestMessages` throws over a component built from `blocks`. */
function emitFailureFor(...blocks: Block[]): string | undefined {
    const app = new OpenAPIHono();
    app.openAPIRegistry.register(FLOW_BLOCK_FIELD_RULES, flowBlockFieldRulesSchema(blocks));
    try {
        attachRequestMessages(app.openAPIRegistry.definitions);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

describe('the FlowBlockFieldRules component', () => {
    it('holds every registered block, and every field each one draws', () => {
        const missing = listBlockDefinitions().flatMap((definition) =>
            definition.configFields
                .filter((field) => !ruleSchema(definition.type, field.key))
                .map((field) => `${definition.type} › ${field.key}`)
        );

        expect(listBlockDefinitions().every((definition) => ruleSchema(definition.type))).toBe(true);
        expect(missing).toEqual([]);
    });

    it('carries each rule with the server’s sentence, and a pattern with its block’s own', () => {
        expect(ruleSchema('action.sendDM', 'message')).toEqual({
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            'x-messages': { minLength: 'Fill this in.', maxLength: 'No more than 2000 characters.' },
        });
        expect(ruleSchema('action.pickRandom', 'outputKey')).toMatchObject({
            pattern: '^[A-Za-z][A-Za-z0-9_]*$',
            'x-messages': { pattern: VARIABLE_NAME_MESSAGE },
        });
        expect(ruleSchema('action.delay', 'durationMs')).toMatchObject({
            type: 'integer',
            'x-messages': { integer: 'Whole numbers only.', exclusiveMinimum: 'Must be more than 0.' },
        });
    });

    it('leaves a coerced number unchecked, and requires nothing', () => {
        expect(ruleSchema('trigger.levelReached', 'level')).toEqual({});
        expect(ruleSchema('action.sendDM')).not.toHaveProperty('required');
    });
});

describe('a block rule that cannot reach the browser faithfully fails the emit, naming the field', () => {
    it('a pattern whose message reads the issue', () => {
        const failure = emitFailureFor(
            blockWith('name', z.string().regex(/^[a-z]+$/, { error: (issue) => `Not ${String(issue.input)}.` }))
        );

        // The block type quoted whole, so its dots do not read as field segments.
        expect(failure).toContain('components.schemas ["test.block"].name');
        expect(failure).toContain('is a function of the issue');
    });

    it('a pattern with flags', () => {
        const failure = emitFailureFor(blockWith('name', z.string().regex(/^[a-z]+$/i, 'Letters only.')));

        expect(failure).toContain('components.schemas ["test.block"].name');
        expect(failure).toContain('has flags');
    });
});
