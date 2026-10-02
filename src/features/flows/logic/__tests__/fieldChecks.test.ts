import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { BlockConfigField, BlockManifest } from '../../blocks/manifest';
import { ensureBlocksDiscovered, getBlockDefinition, listBlockDefinitions } from '../../blocks/registry';
import { FLOW_GRAPH_VERSION } from '../../data/flowGraph';
import {
    deriveFieldChecks,
    failedFieldCheck,
    fieldJsonSchemas,
    KNOWN_FIELD_KEYWORDS,
    type FieldCheck,
} from '../fieldChecks';
import { flowReadinessIssues } from '../flowReadiness';
import { toDescriptor } from '../../../../web/api/nodeRoutes';
import type { NodeDescriptor as BrowserNodeDescriptor } from '../../../../../web/src/api/types';
import * as browserChecks from '../../../../../web/src/flows/fieldChecks';
import { resourceKeyFieldFor } from '../../../../../web/src/flows/controls/types';

/**
 * The gates that let a new block be checked in the browser with nothing wired for it.
 *
 * Every case runs over **every registered block**, so a block added tomorrow is held to
 * them the moment it is discovered — there is no list here to remember to extend.
 *
 *  1. **Every keyword is decided.** A schema reaching for a JSON Schema keyword nobody
 *     has classified (checked in the browser, deliberately server-only, or an
 *     annotation) fails here naming the block, rather than being silently unchecked.
 *  2. **The browser never invents a complaint.** For a spread of values around every
 *     limit, anything the browser's evaluator flags, the server reports too — about the
 *     same field, in the same words.
 *  3. **The two evaluators agree.** The browser's copy (`web/src/flows/fieldChecks.ts`)
 *     is run here, as the browser runs it, against the server's.
 */

type Block = Pick<BlockManifest, 'type' | 'configSchema' | 'configFields'>;

beforeAll(async () => {
    await ensureBlocksDiscovered();
});

/** Keywords a block's field schemas use that no list in `fieldChecks.ts` decides about. */
function undecidedKeywords(block: Block): string[] {
    const { properties } = fieldJsonSchemas(block);
    const undecided: string[] = [];
    for (const [key, property] of properties) {
        for (const keyword of Object.keys(property)) {
            if (!KNOWN_FIELD_KEYWORDS.has(keyword)) undecided.push(`${block.type} › ${key} › ${keyword}`);
        }
    }
    return undecided;
}

/** Values either side of every limit the field's checks state, plus the empty ones. */
function probesFor(checks: readonly FieldCheck[]): unknown[] {
    const probes: unknown[] = [undefined, '', 'a', 0, 1, 1.5, -1, [], ['a']];
    for (const check of checks) {
        if (!('limit' in check)) continue;
        for (const size of [check.limit - 1, check.limit, check.limit + 1].filter((n) => n >= 0 && n < 10_000)) {
            probes.push('a'.repeat(size), Array.from({ length: size }, () => 'a'));
        }
        probes.push(check.limit - 1, check.limit, check.limit + 1, check.limit + 0.5);
    }
    return probes;
}

/**
 * What the server says about one node's `data`, through the path a save takes — so the
 * wording asserted is the wording an author is shown.
 */
function serverMessages(
    type: string,
    data: Record<string, unknown>,
    field?: string,
    declaredKeys: ReadonlySet<string> = new Set()
): string[] {
    const issues = flowReadinessIssues(
        { version: FLOW_GRAPH_VERSION, nodes: [{ id: 'probe', type, position: { x: 0, y: 0 }, data }], edges: [] },
        declaredKeys
    );
    return issues
        .filter((issue) => issue.nodeId === 'probe' && (field === undefined || issue.field === field))
        .map((issue) => issue.message);
}

/** What the server reports about one field of a lone node holding `value` there. */
function serverMessagesAbout(type: string, field: string, value: unknown): string[] {
    return serverMessages(type, value === undefined ? {} : { [field]: value }, field);
}

/** The descriptor as the browser receives it: through JSON. */
function servedDescriptor(definition: BlockManifest): BrowserNodeDescriptor {
    return JSON.parse(JSON.stringify(toDescriptor(definition))) as BrowserNodeDescriptor;
}

describe('field checks derived from every block', () => {
    it('has decided about every keyword every block’s schema uses', () => {
        const undecided = listBlockDefinitions().flatMap(undecidedKeywords);

        expect(
            undecided,
            'These JSON Schema keywords are not classified in `src/features/flows/logic/fieldChecks.ts`. ' +
                'Teach the browser to check them (FIELD_CHECK_RULES, both evaluators, the message), ' +
                'or add them to SERVER_ONLY_KEYWORDS saying why the re-check is enough.'
        ).toEqual([]);
    });

    it('finds every drawn field in its block’s exported schema', () => {
        // A field the export cannot see gets no checks at all, with every gate above
        // green — a top-level union or `preprocess` exports without `properties`.
        const unseen = listBlockDefinitions().flatMap((definition) => {
            const { properties } = fieldJsonSchemas(definition);
            return definition.configFields
                .filter((field) => !properties.has(field.key))
                .map((field) => `${definition.type} › ${field.key}`);
        });

        expect(
            unseen,
            "These fields are drawn but absent from their schema's JSON Schema export, so the " +
                'browser cannot check them. Keep `configSchema` a plain `z.object` at the top level.'
        ).toEqual([]);
    });

    it('catches a keyword nobody has decided about', () => {
        // The gate above passes today; this proves it can fail.
        const block: Block = {
            type: 'test.multipleOf',
            configSchema: z.object({ count: z.number().multipleOf(5) }),
            configFields: [{ key: 'count', label: 'Count', control: 'text' }],
        };

        expect(undecidedKeywords(block)).toEqual(['test.multipleOf › count › multipleOf']);
    });

    it('never flags a value the server accepts, and words it the way the server does', () => {
        const disagreements: string[] = [];

        for (const definition of listBlockDefinitions()) {
            const descriptor = servedDescriptor(definition);
            for (const field of descriptor.configFields) {
                for (const value of probesFor(descriptor.fieldChecks[field.key] ?? [])) {
                    const config: Record<string, unknown> = value === undefined ? {} : { [field.key]: value };
                    const browser = browserChecks.fieldIssue(descriptor, field, config);
                    if (!browser) continue;
                    const server = serverMessagesAbout(definition.type, field.key, value);
                    if (!server.includes(browser)) {
                        disagreements.push(
                            `${definition.type} › ${field.key} = ${JSON.stringify(value)}: browser says ` +
                                `"${browser}", server says ${JSON.stringify(server)}`
                        );
                    }
                }
            }
        }

        expect(disagreements).toEqual([]);
    });

    it('leaves an empty picker naming a declared resource alone, as the server does', () => {
        // Picking a resource the flow declares but has not installed writes an empty id
        // and a sidecar. The server forgives the emptiness — every rule about it, not
        // just "required" — so the browser must say nothing either.
        //
        // Every field, not only pickers: the server finds a sidecar by its name, whatever
        // control wrote it, so the browser cannot be allowed to assume which ones do.
        const flagged: string[] = [];
        let pickers = 0;

        for (const definition of listBlockDefinitions()) {
            const descriptor = servedDescriptor(definition);
            for (const field of descriptor.configFields) {
                for (const value of [undefined, '']) {
                    const data: Record<string, unknown> = { [resourceKeyFieldFor(field.key)]: 'declared-thing' };
                    if (value !== undefined) data[field.key] = value;

                    const browser = browserChecks.fieldIssue(descriptor, field, data);
                    if (browser) flagged.push(`${definition.type} › ${field.key} = ${JSON.stringify(value)}: "${browser}"`);

                    if (field.control === 'rolePicker' || field.control === 'channelPicker') {
                        pickers += 1;
                        expect(serverMessages(definition.type, data, field.key, new Set(['declared-thing']))).toEqual([]);
                    }
                }
            }
        }

        expect(pickers, 'No block has a picker, so the server half proves nothing.').toBeGreaterThan(0);
        expect(flagged).toEqual([]);
    });

    it('evaluates every check the same way in the browser as on the server', () => {
        const disagreements: string[] = [];

        for (const definition of listBlockDefinitions()) {
            for (const [key, checks] of Object.entries(deriveFieldChecks(definition))) {
                for (const value of probesFor(checks)) {
                    const server = failedFieldCheck(checks, value)?.message;
                    const browser = browserChecks.failedFieldCheck(checks, value)?.message;
                    if (server !== browser) {
                        disagreements.push(`${definition.type} › ${key} = ${JSON.stringify(value)}: ${server} vs ${browser}`);
                    }
                }
            }
        }

        expect(disagreements).toEqual([]);
    });
});

describe('deriving one block’s checks', () => {
    function checksOf(type: string): Record<string, readonly FieldCheck[]> {
        const definition = getBlockDefinition(type);
        if (!definition) throw new Error(`No block "${type}" is registered.`);
        return deriveFieldChecks(definition);
    }

    it('states a required message with its limits', () => {
        expect(checksOf('action.sendDM').message?.map((check) => check.rule)).toEqual([
            'required',
            'minLength',
            'maxLength',
        ]);
    });

    it('does not call an optional field required, nor one with a default', () => {
        const embed = checksOf('action.postEmbed');
        expect(embed.authorName?.map((check) => check.rule)).toEqual(['minLength', 'maxLength']);
        expect(checksOf('trigger.buttonClick').style).toEqual([]);
    });

    it('states whole-number and range rules for a duration', () => {
        expect(checksOf('action.delay').durationMs?.map((check) => check.rule)).toEqual([
            'required',
            'integer',
            'maximum',
            'exclusiveMinimum',
        ]);
    });
});

describe('how the server words what a check explains', () => {
    const messagesFor = (type: string, data: Record<string, unknown>): string[] =>
        serverMessages(type, data, type === 'action.pickRandom' ? 'outputKey' : 'message');

    it('says what the builder said as the author typed', () => {
        expect(messagesFor('action.sendDM', { message: '' })).toEqual(['Fill this in.']);
        expect(messagesFor('action.sendDM', {})).toEqual(['Fill this in.']);
    });

    it('keeps the block’s own wording for what no check states', () => {
        // The variable-name pattern is server-only: its message is the block's.
        const field: BlockConfigField | undefined = getBlockDefinition('action.pickRandom')?.configFields.find(
            (candidate) => candidate.key === 'outputKey'
        );
        expect(field).toBeDefined();
        const [message] = messagesFor('action.pickRandom', { options: ['a'], outputKey: '1abc' });
        expect(message).toBeDefined();
        expect(message).not.toBe('Fill this in.');
    });
});
