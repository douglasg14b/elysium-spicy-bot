import { z } from 'zod';
import type { BlockManifest } from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';

/**
 * The rules about a block's config fields that the builder can check as an author types,
 * **derived from each block's `configSchema`**, and the one place they are worded.
 *
 * A block author writes a schema and nothing else. {@link browserFieldRules} reads each
 * drawn field's rules off zod's own JSON Schema export; the emit turns them into the
 * `FlowBlockFieldRules` component of the OpenAPI spec (`src/web/api/flowBlockFieldRules.ts`),
 * each rule carrying its sentence, and the SDK generates the zod the builder parses a
 * node's config with (`web/src/flows/liveFieldIssues.ts`). Nothing is served at runtime:
 * the rules reach the browser when the SDK is generated.
 *
 * The server words its own complaints about the same rules with the same function
 * ({@link fieldRuleIssueMessage}, through {@link fieldRuleSentence}), so a message does not
 * change under the author when Save answers. The schema stays the authority: what the
 * browser cannot be given faithfully is left out of what it checks — it may say less than
 * the server, never more — and the re-check as a field loses focus reports the rest.
 */

/** The limit rules, each a JSON Schema keyword of the same name. */
const STRING_LIMITS = ['minLength', 'maxLength'] as const;
const NUMBER_LIMITS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const;
const ARRAY_LIMITS = ['minItems', 'maxItems'] as const;

type StringLimit = (typeof STRING_LIMITS)[number];
type NumberLimit = (typeof NUMBER_LIMITS)[number];
type ArrayLimit = (typeof ARRAY_LIMITS)[number];
type LimitKeyword = StringLimit | NumberLimit | ArrayLimit;

/** Keywords the browser is given: the value's type, its limits, and a string's pattern. */
const BROWSER_KEYWORDS = ['type', ...STRING_LIMITS, ...NUMBER_LIMITS, ...ARRAY_LIMITS, 'pattern'] as const;

/**
 * Keywords that constrain a value but are deliberately **not** given to the browser, each
 * with why. The server still enforces every one; the builder hears about them from its
 * re-check instead of as the author types.
 *
 * A keyword missing from this list, {@link BROWSER_KEYWORDS} and
 * {@link ANNOTATION_KEYWORDS} fails {@link browserFieldRules} — and so the spec emit —
 * naming the block and field, so a schema reaching for a rule nobody has decided about is
 * caught when the block is added, not when an author meets it.
 */
export const SERVER_ONLY_KEYWORDS = {
    format: 'Formats (e.g. `uri`) are worded by the block and refined further than the format says.',
    enum: '`select` and `segmented` only offer declared values, so there is nothing to type wrong.',
    const: 'Appears only inside structured values the controls build whole.',
    oneOf: '`eligibility`: a structured control that can only emit a valid shape.',
    anyOf: 'A union; no single rule to state about it.',
    items: 'List entries are addressed by dotted path, which the builder places under the list, not live.',
    properties: 'Inside an object value; see `items`.',
    // The keyword inside an object value — not a block's own top-level `required` list.
    required: 'Inside an object value; see `items`.',
    additionalProperties: 'Inside an object value; see `items`.',
} as const satisfies Readonly<Record<string, string>>;

/** Keywords that describe a value without constraining it. */
const ANNOTATION_KEYWORDS = ['default', 'description', 'title', 'examples'] as const satisfies readonly string[];

const KNOWN_FIELD_KEYWORDS: ReadonlySet<string> = new Set<string>([
    ...BROWSER_KEYWORDS,
    ...Object.keys(SERVER_ONLY_KEYWORDS),
    ...ANNOTATION_KEYWORDS,
]);

/** One limit the browser checks, with the sentence the server gives when it fails. */
export interface WordedLimit<Keyword extends LimitKeyword> {
    readonly keyword: Keyword;
    readonly limit: number;
    readonly sentence: string;
}

/**
 * What the browser checks about one drawn field, by the kind of value it holds.
 *
 * `unchecked` is a field the browser leaves to the server entirely: one zod coerces (the
 * control stores a string, the export calls it a number), one with no single type (a
 * union, an object, anything), or one with no rule the browser is given — an enum, a
 * format, a bare string — where checking the type alone would only ever produce zod's
 * sentence about a wrong type, which for an enum is not the one the server sends. Every
 * field is optional to the browser — see {@link browserFieldRules}.
 */
export type FieldBrowserRules =
    | {
          readonly kind: 'string';
          readonly limits: readonly WordedLimit<StringLimit>[];
          /** The block's own `.regex()` check, which carries the block's own sentence. */
          readonly pattern: z.core.$ZodCheck<string> | undefined;
      }
    | {
          readonly kind: 'number';
          /** The whole-number rule's sentence, when the field holds whole numbers only. */
          readonly integer: string | undefined;
          readonly limits: readonly WordedLimit<NumberLimit>[];
      }
    | { readonly kind: 'array'; readonly limits: readonly WordedLimit<ArrayLimit>[] }
    | { readonly kind: 'unchecked' };

/** One property of a block's config, as zod exports it. */
type JsonSchemaProperty = Readonly<Record<string, unknown>>;

interface ExportedConfig {
    readonly properties: ReadonlyMap<string, JsonSchemaProperty>;
    readonly required: ReadonlySet<string>;
}

interface JsonSchemaObject {
    readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
    readonly required?: readonly string[];
}

/** What the rules are derived from: a block's type, its schema, and the fields it draws. */
export type BlockSchemaSource = Pick<BlockManifest, 'type' | 'configSchema' | 'configFields'>;

const exportedByBlock = new WeakMap<object, ExportedConfig>();

/**
 * The JSON Schema of each of a block's config keys, and which keys it requires — once per
 * block, since the registry's definitions live as long as the process.
 *
 * `io: 'input'` because what an author types is the input — a field with a `.default()` is
 * then rightly not required. The one source of "required" for both the emit and the
 * server's wording, so the two cannot disagree about it.
 */
export function fieldJsonSchemas(definition: Pick<BlockManifest, 'configSchema'>): ExportedConfig {
    const cached = exportedByBlock.get(definition);
    if (cached) return cached;

    const exported = z.toJSONSchema(definition.configSchema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaObject;
    const result: ExportedConfig = {
        properties: new Map(Object.entries(exported.properties ?? {})),
        required: new Set(exported.required ?? []),
    };
    exportedByBlock.set(definition, result);
    return result;
}

/**
 * What the browser checks about each drawn field of one block, keyed by field.
 *
 * **Every field is optional to the browser.** A control never removes a key the schema
 * requires — text and pickers write `''`, a duration `0`, a list `[]` — so absence is only
 * ever a field nobody has touched, which the server reports on Save ("Fill this in.").
 *
 * Throws, naming the block and field, when a schema holds a rule nobody has decided how
 * the browser should treat: a JSON Schema keyword outside the lists above, a drawn field
 * missing from the export (a top-level union or `preprocess` exports without
 * `properties`), or a `pattern` with no `.regex()` check behind it. The emit runs this
 * over every block, so `pnpm sdk:generate` stops on it.
 */
export function browserFieldRules(definition: BlockSchemaSource): ReadonlyMap<string, FieldBrowserRules> {
    const { properties, required } = fieldJsonSchemas(definition);
    const shape = configShape(definition);
    const problems: string[] = [];
    const rules = new Map<string, FieldBrowserRules>();

    for (const field of definition.configFields) {
        const at = `${definition.type} › ${field.key}`;
        const property = properties.get(field.key);
        const fieldSchema = shape[field.key];
        if (!property || !fieldSchema) {
            problems.push(
                `${at}: drawn, but absent from the schema's JSON Schema export. Keep \`configSchema\` a plain \`z.object\` at the top level.`
            );
            continue;
        }

        // Two `.regex()` on one field export as an `allOf` of patterns. Not a keyword to
        // classify: listing it as server-only would quietly drop both patterns.
        if ('allOf' in property) {
            problems.push(`${at}: more than one \`.regex()\` (an \`allOf\`). Make it one pattern with one sentence.`);
            continue;
        }

        const undecided = Object.keys(property).filter((keyword) => !KNOWN_FIELD_KEYWORDS.has(keyword));
        if (undecided.length) {
            problems.push(
                `${at}: ${undecided.map((keyword) => `\`${keyword}\``).join(', ')} not classified. Teach the browser the rule, ` +
                    'or add it to SERVER_ONLY_KEYWORDS saying why the re-check is enough.'
            );
            continue;
        }

        const fieldRules = rulesFor(property, baseOf(fieldSchema), required.has(field.key), (problem) =>
            problems.push(`${at}: ${problem}`)
        );
        if (fieldRules) rules.set(field.key, fieldRules);
    }

    if (problems.length) {
        throw new Error(
            'Block config rules the builder cannot be given (see `blockFieldRules.ts`):\n' +
                problems.map((problem) => `  - ${problem}`).join('\n')
        );
    }
    return rules;
}

/**
 * One drawn field's rules, from its exported keywords and its zod schema underneath any
 * wrapper; `undefined` when a problem was reported instead.
 */
function rulesFor(
    property: JsonSchemaProperty,
    base: z.core.$ZodType,
    required: boolean,
    report: (problem: string) => void
): FieldBrowserRules | undefined {
    const def = (base as z.core.$ZodTypes)._zod.def;
    if ('coerce' in def && def.coerce) {
        return { kind: 'unchecked' };
    }

    switch (property.type) {
        case 'string': {
            const pattern = patternCheck(property, def, report);
            if (pattern === null) return undefined;
            const limits = STRING_LIMITS.flatMap((keyword) => wordedLimit(property, keyword, required));
            return limits.length || pattern ? { kind: 'string', limits, pattern } : { kind: 'unchecked' };
        }
        case 'number':
        case 'integer': {
            const integer = property.type === 'integer' ? fieldRuleSentence({ rule: 'integer' }) : undefined;
            const limits = NUMBER_LIMITS.flatMap((keyword) => wordedLimit(property, keyword, required));
            return limits.length || integer ? { kind: 'number', integer, limits } : { kind: 'unchecked' };
        }
        case 'array': {
            const limits = ARRAY_LIMITS.flatMap((keyword) => wordedLimit(property, keyword, required));
            return limits.length ? { kind: 'array', limits } : { kind: 'unchecked' };
        }
        default:
            return { kind: 'unchecked' };
    }
}

/**
 * The block's `.regex()` check behind an exported `pattern`; `undefined` when there is no
 * pattern, and `null` when it was reported instead.
 */
function patternCheck(
    property: JsonSchemaProperty,
    def: z.core.$ZodTypeDef,
    report: (problem: string) => void
): z.core.$ZodCheck<string> | undefined | null {
    const { pattern } = property;
    if (pattern === undefined) {
        return undefined;
    }
    // One at most: two `.regex()` export as an `allOf`, refused before this is reached.
    const check = (def.checks ?? []).find((candidate) => {
        const checkDef = candidate._zod.def as z.core.$ZodChecks['_zod']['def'];
        return checkDef.check === 'string_format' && checkDef.format === 'regex';
    });
    const source = (check?._zod.def as z.core.$ZodCheckRegexDef | undefined)?.pattern.source;
    if (!check || source !== pattern) {
        // A format's own pattern (`z.email()`), or a `.startsWith()`: no sentence of the
        // block's to carry, so the browser would word it with zod's.
        report(`exports the pattern ${JSON.stringify(pattern)} with no \`.regex()\` check of that source behind it.`);
        return null;
    }
    // `def.checks` is typed for any value; a check found on a string schema checks strings.
    return check as z.core.$ZodCheck<string>;
}

/** The limit `keyword` sets on a field, worded, or nothing when it sets none. */
function wordedLimit<Keyword extends LimitKeyword>(
    property: JsonSchemaProperty,
    keyword: Keyword,
    required: boolean
): WordedLimit<Keyword>[] {
    const limit = property[keyword];
    if (typeof limit !== 'number') return [];
    return [{ keyword, limit, sentence: fieldRuleSentence(limitRule(keyword, limit, required)) }];
}

function limitRule(keyword: LimitKeyword, limit: number, required: boolean): FieldRule {
    return keyword === 'minLength' ? { rule: keyword, limit, required } : { rule: keyword, limit };
}

/** A block's config as a zod object's shape. Conformance holds every block to a plain `z.object`. */
function configShape(definition: BlockSchemaSource): Readonly<Record<string, z.core.$ZodType>> {
    const def = (definition.configSchema as unknown as z.core.$ZodTypes)._zod.def;
    if (def.type !== 'object') {
        throw new Error(`${definition.type}: \`configSchema\` must be a \`z.object\`; found a ${def.type}.`);
    }
    return def.shape;
}

/** The schema underneath any optional, default, nullable or similar wrapper, and the input side of a pipe. */
function baseOf(schema: z.core.$ZodType): z.core.$ZodType {
    const def = (schema as z.core.$ZodTypes)._zod.def;
    switch (def.type) {
        case 'optional':
        case 'nullable':
        case 'default':
        case 'prefault':
        case 'nonoptional':
        case 'readonly':
        case 'catch':
            return baseOf(def.innerType);
        case 'pipe':
            return baseOf(def.in);
        default:
            return schema;
    }
}

/** A rule a field's value can fail, as the one wording function takes it. */
export type FieldRule =
    | { readonly rule: 'required' | 'integer' }
    | { readonly rule: 'minLength'; readonly limit: number; readonly required: boolean }
    | { readonly rule: Exclude<LimitKeyword, 'minLength'>; readonly limit: number };

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

/**
 * The one place a field rule is worded — for the sentence the emit puts beside it in the
 * spec, which the builder shows as the author types, and for the issue the server reports
 * about the same value on Save. Both read this, so the message does not change under the
 * author when the server answers.
 *
 * `required` is only ever the server's to say (see {@link browserFieldRules}). A
 * one-character minimum fails only an empty value, so it reads as the field asking to be
 * filled in where the field is required, and as "not empty" where leaving it out is fine.
 */
export function fieldRuleSentence(rule: FieldRule): string {
    switch (rule.rule) {
        case 'required':
            return 'Fill this in.';
        case 'integer':
            return 'Whole numbers only.';
        case 'minLength':
            if (rule.limit === 1) return rule.required ? 'Fill this in.' : "Can't be empty.";
            return `At least ${plural(rule.limit, 'character', 'characters')}.`;
        case 'maxLength':
            return `No more than ${plural(rule.limit, 'character', 'characters')}.`;
        case 'minimum':
            return `At least ${rule.limit}.`;
        case 'maximum':
            return `No more than ${rule.limit}.`;
        case 'exclusiveMinimum':
            return `Must be more than ${rule.limit}.`;
        case 'exclusiveMaximum':
            return `Must be less than ${rule.limit}.`;
        case 'minItems':
            return `Add at least ${plural(rule.limit, 'entry', 'entries')}.`;
        case 'maxItems':
            return `No more than ${plural(rule.limit, 'entry', 'entries')}.`;
    }
}

/**
 * The sentence for one schema complaint about a node, when it is a field rule this file
 * words — for `validateNodeData`'s `issueMessage`.
 *
 * Read off the issue itself — its code, the kind of value, its own bound — rather than by
 * re-checking the value, so a number typed into a text box is worded like the same number
 * in a number box. Anything else — a `.refine()`, a pattern, an entry inside a list — keeps
 * its block's own wording (`undefined`).
 */
export function fieldRuleIssueMessage(
    issue: z.core.$ZodIssue,
    node: { readonly type: string; readonly data: Record<string, unknown> }
): string | undefined {
    if (issue.path.length !== 1) return undefined;
    const definition = getBlockDefinition(node.type);
    if (!definition) return undefined;

    const key = String(issue.path[0]);
    const rule = ruleBehind(issue, node.data[key], fieldJsonSchemas(definition).required.has(key));
    return rule && fieldRuleSentence(rule);
}

/** The field rule a zod issue reports, if it is one this file words. */
function ruleBehind(issue: z.core.$ZodIssue, value: unknown, required: boolean): FieldRule | undefined {
    switch (issue.code) {
        case 'invalid_type':
            // Absent: an optional key never complains about being left out.
            if (value === undefined) return { rule: 'required' };
            // `.int()` reports a fraction as the wrong type, expecting `int`.
            return (issue.expected as string) === 'int' ? { rule: 'integer' } : undefined;
        case 'too_small':
            // A cleared text box over a coerced number: `''` becomes `0` and fails the
            // minimum, but what the author did is leave it empty. Not for a string, whose
            // browser rule words `''` by its minimum alone.
            if (value === '' && required && (issue.origin === 'number' || issue.origin === 'int')) {
                return { rule: 'required' };
            }
            return boundRule(issue, issue.minimum, required, { string: 'minLength', array: 'minItems' }, [
                'minimum',
                'exclusiveMinimum',
            ]);
        case 'too_big':
            return boundRule(issue, issue.maximum, required, { string: 'maxLength', array: 'maxItems' }, [
                'maximum',
                'exclusiveMaximum',
            ]);
        case 'invalid_format':
        case 'not_multiple_of':
        case 'unrecognized_keys':
        case 'invalid_union':
        case 'invalid_key':
        case 'invalid_element':
        case 'invalid_value':
        case 'custom':
            return undefined;
    }
}

/**
 * The limit rule behind a size complaint, by the kind of value it is about — with the
 * issue's own bound, so the sentence states the limit that was actually broken.
 */
function boundRule(
    issue: z.core.$ZodIssueTooSmall | z.core.$ZodIssueTooBig,
    bound: number | bigint,
    required: boolean,
    sized: { readonly string: StringLimit; readonly array: ArrayLimit },
    [inclusive, exclusive]: readonly [NumberLimit, NumberLimit]
): FieldRule | undefined {
    if (typeof bound !== 'number') return undefined;
    switch (issue.origin) {
        case 'string':
            return limitRule(sized.string, bound, required);
        case 'array':
            return limitRule(sized.array, bound, required);
        case 'number':
        case 'int':
            return { rule: issue.inclusive === false ? exclusive : inclusive, limit: bound };
        default:
            return undefined;
    }
}
