import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { BlockManifest } from '../../blocks/manifest';
import { ensureBlocksDiscovered, getBlockDefinition, listBlockDefinitions } from '../../blocks/registry';
import { VARIABLE_NAME_MESSAGE } from '../../blocks/variableName';
import { FLOW_GRAPH_VERSION } from '../../data/flowGraph';
import { browserFieldRules, fieldJsonSchemas, type BlockSchemaSource } from '../blockFieldRules';
import { flowReadinessIssues } from '../flowReadiness';
import { toDescriptor } from '../../../../web/api/nodeRoutes';
import type { NodeDescriptor as BrowserNodeDescriptor } from '../../../../../web/src/api/types';
import { resourceKeyFieldFor } from '../../../../../web/src/flows/controls/types';
import { fieldIssue } from '../../../../../web/src/flows/liveFieldIssues';
import { zFlowBlockFieldRules } from '../../../../../packages/web-sdk/src/gen/zod.gen';

/**
 * The gates that let a new block be checked in the browser with nothing wired for it.
 *
 * Every case runs over **every registered block**, so a block added tomorrow is held to
 * them the moment it is discovered — there is no list here to remember to extend.
 *
 *  1. **Every rule is decided.** A schema reaching for a JSON Schema keyword nobody has
 *     classified fails the derivation the spec emit runs, naming the block and field.
 *  2. **The browser never invents a complaint.** For a spread of values around every
 *     limit, every pattern and every coercion, anything the browser flags — through the
 *     very functions the builder runs, against the generated zod the SDK ships — the
 *     server reports too, about the same field, in the same words.
 */

type Block = BlockSchemaSource;

beforeAll(async () => {
    await ensureBlocksDiscovered();
});

/** What the server says about one node's `data`, through the path a save takes. */
function serverMessages(
    type: string,
    data: Record<string, unknown>,
    field: string,
    declaredKeys: ReadonlySet<string> = new Set()
): string[] {
    const issues = flowReadinessIssues(
        { version: FLOW_GRAPH_VERSION, nodes: [{ id: 'probe', type, position: { x: 0, y: 0 }, data }], edges: [] },
        declaredKeys
    );
    return issues.filter((issue) => issue.nodeId === 'probe' && issue.field === field).map((issue) => issue.message);
}

/**
 * What the builder says about one field: its own function, against the rules the
 * committed SDK ships — the same object `useFlowIssues` hands it.
 */
function browserSays(
    descriptor: BrowserNodeDescriptor,
    field: BrowserNodeDescriptor['configFields'][number],
    config: Record<string, unknown>
): string | undefined {
    return fieldIssue(descriptor, field, config, zFlowBlockFieldRules.shape);
}

/** A lone node holding `value` at `field`, and nothing else. */
const dataWith = (field: string, value: unknown): Record<string, unknown> =>
    value === undefined ? {} : { [field]: value };

/**
 * A lone node holding `value` at `field`, with the sibling that shows the field set — a
 * field hidden by default would otherwise be skipped by both sides and agree vacuously.
 */
function probeData(field: BrowserNodeDescriptor['configFields'][number], value: unknown): Record<string, unknown> {
    const data = dataWith(field.key, value);
    if (field.visibleWhen) data[field.visibleWhen.field] = field.visibleWhen.equals[0];
    return data;
}

/** zod's own sentence for a value of the wrong type — said by both sides, but no rule of a block's. */
const isTypeSentence = (sentence: string): boolean => sentence.startsWith('Invalid input: expected');

/** The descriptor as the browser receives it: through JSON. */
function servedDescriptor(definition: BlockManifest): BrowserNodeDescriptor {
    return JSON.parse(JSON.stringify(toDescriptor(definition))) as BrowserNodeDescriptor;
}

/** Strings the three pattern fields accept and refuse, edge cases included. */
const PATTERN_PROBES = ['abc_1', 'Ab9', '1abc', 'a b', '_x', 'a-b', 'a\\b', 'é', '#00A2FF', '#00a2fG', '#00A2FF0', 'a\n'];

/** Values either side of every limit the field's export states, plus the awkward ones. */
function probesFor(property: Readonly<Record<string, unknown>> | undefined): unknown[] {
    const probes: unknown[] = [undefined, '', 'a', 0, 1, 1.5, -1, [], ['a'], '0', '5', '1.5', ...PATTERN_PROBES];
    for (const limit of Object.values(property ?? {})) {
        if (typeof limit !== 'number') continue;
        for (const size of [limit - 1, limit, limit + 1].filter((candidate) => candidate >= 0 && candidate < 10_000)) {
            probes.push('a'.repeat(size), Array.from({ length: size }, () => 'a'));
        }
        probes.push(limit - 1, limit, limit + 1, limit + 0.5);
    }
    return probes;
}

describe('field rules derived from every block', () => {
    it('derives the browser’s rules for every registered block', () => {
        // Throws, naming the block and field, on anything undecided — as the emit would.
        for (const definition of listBlockDefinitions()) {
            expect(() => browserFieldRules(definition), definition.type).not.toThrow();
        }
    });

    it('ships a rule set for every registered block in the SDK', () => {
        // The parity case below runs the generated zod; a block missing from it would be
        // checked by nothing and pass for no reason.
        expect(
            Object.keys(zFlowBlockFieldRules.shape).sort(),
            'The SDK does not carry every block. Run `pnpm sdk:generate`.'
        ).toEqual(listBlockDefinitions().map((definition) => definition.type).sort());
    });

    it('never flags a value the server accepts, and words it the way the server does', () => {
        const disagreements: string[] = [];
        const neverFlagged: string[] = [];

        for (const definition of listBlockDefinitions()) {
            const descriptor = servedDescriptor(definition);
            const { properties } = fieldJsonSchemas(definition);
            const rules = browserFieldRules(definition);
            for (const field of descriptor.configFields) {
                let flaggedByARule = false;
                for (const value of probesFor(properties.get(field.key))) {
                    const data = probeData(field, value);
                    const said = browserSays(descriptor, field, data);
                    if (!said) continue;
                    if (!isTypeSentence(said)) flaggedByARule = true;
                    const server = serverMessages(definition.type, data, field.key);
                    if (!server.includes(said)) {
                        disagreements.push(
                            `${definition.type} › ${field.key} = ${JSON.stringify(value)}: browser says ` +
                                `"${said}", server says ${JSON.stringify(server)}`
                        );
                    }
                }
                // A field the browser has rules for that no probe tripped proves nothing.
                if (rules.get(field.key)?.kind !== 'unchecked' && !flaggedByARule) {
                    neverFlagged.push(`${definition.type} › ${field.key}`);
                }
            }
        }

        expect(disagreements).toEqual([]);
        expect(neverFlagged, 'Fields with browser rules that no probe tripped.').toEqual([]);
    });

    it('agrees with the server on every pattern, both ways', () => {
        // The standing "never refuses what the server accepts" table, and its converse: a
        // pattern that travelled looser than the server's would pass the case above.
        const disagreements: string[] = [];
        let patternFields = 0;

        for (const definition of listBlockDefinitions()) {
            const descriptor = servedDescriptor(definition);
            for (const [key, rules] of browserFieldRules(definition)) {
                if (rules.kind !== 'string' || !rules.pattern) continue;
                patternFields += 1;
                const field = descriptor.configFields.find((candidate) => candidate.key === key);
                if (!field) throw new Error(`${definition.type} › ${key} is not drawn.`);

                // The pattern's own sentence, as the block's check words it. Compared by
                // sentence, since the server may also say things about the field that are
                // not the pattern's (a variable name no block records, say).
                const refusal = z.string().check(rules.pattern).safeParse('!');
                const sentence = refusal.success ? undefined : refusal.error.issues[0]?.message;
                if (!sentence) throw new Error(`${definition.type} › ${key}: its pattern accepts "!".`);

                for (const sample of PATTERN_PROBES) {
                    const data = probeData(field, sample);
                    const said = browserSays(descriptor, field, data);
                    const server = serverMessages(definition.type, data, key);
                    if ((said === sentence) !== server.includes(sentence) || (said && !server.includes(said))) {
                        disagreements.push(
                            `${definition.type} › ${key} = ${JSON.stringify(sample)}: browser ${JSON.stringify(said)}, ` +
                                `server ${JSON.stringify(server)}`
                        );
                    }
                }
            }
        }

        expect(patternFields, 'No block has a pattern, so this proves nothing.').toBeGreaterThan(0);
        expect(disagreements).toEqual([]);
    });

    it('leaves an empty picker naming a declared resource alone, as the server does', () => {
        // Picking a resource the flow declares but has not installed writes an empty id
        // and a sidecar. The server forgives the emptiness — every rule about it — so the
        // browser must say nothing either.
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

                    const said = browserSays(descriptor, field, data);
                    if (said) flagged.push(`${definition.type} › ${field.key} = ${JSON.stringify(value)}: "${said}"`);

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
});

describe('deriving one block’s rules', () => {
    function rulesOf(type: string): ReadonlyMap<string, unknown> {
        const definition = getBlockDefinition(type);
        if (!definition) throw new Error(`No block "${type}" is registered.`);
        return browserFieldRules(definition);
    }

    it('words a required field’s minimum as asking for it, and an optional one’s as not empty', () => {
        expect(rulesOf('action.sendDM').get('message')).toMatchObject({
            kind: 'string',
            limits: [
                { keyword: 'minLength', limit: 1, sentence: 'Fill this in.' },
                { keyword: 'maxLength', limit: 2000, sentence: 'No more than 2000 characters.' },
            ],
            pattern: undefined,
        });
        expect(rulesOf('action.postEmbed').get('authorName')).toMatchObject({
            limits: [{ keyword: 'minLength', sentence: "Can't be empty." }, { keyword: 'maxLength' }],
        });
    });

    it('leaves a coerced number to the server: the control stores what was typed', () => {
        expect(rulesOf('trigger.levelReached').get('level')).toEqual({ kind: 'unchecked' });
        expect(rulesOf('action.awardXp').get('amount')).toEqual({ kind: 'unchecked' });
    });

    it('states a duration’s whole-number rule and its range', () => {
        expect(rulesOf('action.delay').get('durationMs')).toEqual({
            kind: 'number',
            integer: 'Whole numbers only.',
            limits: [
                { keyword: 'maximum', limit: 2_592_000_000, sentence: 'No more than 2592000000.' },
                { keyword: 'exclusiveMinimum', limit: 0, sentence: 'Must be more than 0.' },
            ],
        });
    });

    it('leaves a structured value, and one with no rule but its type, to the server', () => {
        expect(rulesOf('trigger.buttonClick').get('eligibility')).toEqual({ kind: 'unchecked' });
        // An enum: zod's sentence for a wrong type is not the one the server sends.
        expect(rulesOf('trigger.buttonClick').get('style')).toEqual({ kind: 'unchecked' });
    });
});

describe('what the derivation refuses', () => {
    const blockWith = (key: string, schema: z.ZodType): Block => ({
        type: 'test.block',
        configSchema: z.object({ [key]: schema }),
        configFields: [{ key, label: 'Field', control: 'text' }],
    });

    it('a keyword nobody has decided about, naming block, field and keyword', () => {
        expect(() => browserFieldRules(blockWith('count', z.number().multipleOf(5)))).toThrow(
            /test\.block › count: `multipleOf` not classified/
        );
    });

    it('a drawn field the export cannot see', () => {
        const block: Block = { ...blockWith('name', z.string()), configFields: [{ key: 'other', label: 'Other', control: 'text' }] };
        expect(() => browserFieldRules(block)).toThrow(/test\.block › other: drawn, but absent/);
    });

    it('a pattern no `.regex()` of the block’s states', () => {
        expect(() => browserFieldRules(blockWith('prefix', z.string().startsWith('ab')))).toThrow(
            /test\.block › prefix: exports the pattern "\^ab\.\*" with no `\.regex\(\)` check/
        );
    });

    it('two `.regex()` on one field, rather than calling their `allOf` a keyword to classify', () => {
        expect(() => browserFieldRules(blockWith('name', z.string().regex(/^a/, 'First.').regex(/b$/, 'Second.')))).toThrow(
            /test\.block › name: more than one `\.regex\(\)`/
        );
    });
});

describe('how the server words a field rule', () => {
    const messagesFor = (type: string, field: string, value: unknown): string[] =>
        serverMessages(type, dataWith(field, value), field);

    it('asks for a required field left empty or left out', () => {
        expect(messagesFor('action.sendDM', 'message', '')).toEqual(['Fill this in.']);
        expect(messagesFor('action.sendDM', 'message', undefined)).toEqual(['Fill this in.']);
        expect(messagesFor('action.postEmbed', 'authorName', '')).toEqual(["Can't be empty."]);
    });

    it('keeps the block’s own wording for a pattern', () => {
        expect(messagesFor('action.pickRandom', 'outputKey', '1abc')).toEqual([VARIABLE_NAME_MESSAGE]);
    });

    it('states the bound the issue broke', () => {
        expect(messagesFor('action.pickRandom', 'options', [])).toEqual(['Add at least 1 entry.']);
        expect(messagesFor('action.pickRandom', 'options', Array.from({ length: 51 }, () => 'a'))).toEqual([
            'No more than 50 entries.',
        ]);
        expect(messagesFor('action.delay', 'durationMs', 0)).toEqual(['Must be more than 0.']);
        expect(messagesFor('action.delay', 'durationMs', 1.5)).toEqual(['Whole numbers only.']);
    });

    it('words a number typed into a text box like the same number anywhere else', () => {
        // Cleared, the box holds `''`, which zod reads as 0: the author left it empty.
        expect(messagesFor('trigger.levelReached', 'level', '')).toEqual(['Fill this in.']);
        expect(messagesFor('action.awardXp', 'amount', '')).toEqual(['Fill this in.']);
        expect(messagesFor('trigger.levelReached', 'level', '0')).toEqual(['At least 1.']);
        expect(messagesFor('trigger.levelReached', 'level', '1.5')).toEqual(['Whole numbers only.']);
        // Not a number at all: no rule of this file's explains it, so zod's own stands.
        expect(messagesFor('trigger.levelReached', 'level', 'lots')).toEqual([
            'Invalid input: expected number, received NaN',
        ]);
    });
});
