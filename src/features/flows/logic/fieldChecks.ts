import { z } from 'zod';
import type { BlockManifest } from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';

/**
 * The per-field rules the builder can check as an author types, **derived from each
 * block's `configSchema`** rather than declared beside it.
 *
 * A block author writes a schema and nothing else: these are read off it with zod's own
 * JSON Schema export, so a new block is checked in the browser the moment it exists, and
 * a rule cannot be changed in one place and forgotten in another. The schema stays the
 * authority — a check is a rule the schema already enforces, served so the browser can
 * say so sooner. Anything it cannot express (a `.refine()`, a pattern with its own
 * wording) is simply not served, and the builder's re-check as a field loses focus
 * reports it instead.
 *
 * The limit rules are JSON Schema keywords, copied with their numbers. Two rules are
 * not: `integer` comes from `type: 'integer'`, and `required` is "nothing typed", read
 * off the object's `required` list together with the field's `minLength` (see
 * {@link deriveFieldChecks}). The browser mirrors {@link FIELD_CHECK_RULES} and
 * evaluates them in `web/src/flows/fieldChecks.ts`; the drift test holds the two
 * vocabularies together, and `__tests__/fieldChecks.test.ts` holds the two evaluators to
 * the same answers — and to never flagging a value this server would accept.
 */

/** The rules that carry a number, each a JSON Schema keyword of the same name. */
const LIMIT_RULES = [
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minItems',
    'maxItems',
] as const;

type LimitRule = (typeof LIMIT_RULES)[number];

export const FIELD_CHECK_RULES = ['required', 'integer', ...LIMIT_RULES] as const;

export type FieldCheckRule = (typeof FIELD_CHECK_RULES)[number];

/** One rule a field's value must meet, worded the way the builder shows it. */
export type FieldCheck =
    | { readonly rule: 'required' | 'integer'; readonly message: string }
    | { readonly rule: LimitRule; readonly limit: number; readonly message: string };

/** A block's checks, keyed by the config field they guard. Every drawn field has an entry. */
export type FieldChecksByKey = Readonly<Record<string, readonly FieldCheck[]>>;

/** The keywords a {@link FieldCheck} is derived from. `type` yields `integer`. */
const CHECKED_KEYWORDS = ['type', ...LIMIT_RULES] as const;

/**
 * Keywords that constrain a value but are deliberately **not** checked in the browser,
 * each with why. The server still enforces every one; the builder hears about them from
 * its re-check instead of as the author types.
 *
 * A keyword missing from this list, {@link CHECKED_KEYWORDS} and
 * {@link ANNOTATION_KEYWORDS} fails the conformance gate in
 * `__tests__/fieldChecks.test.ts`, naming the block — so a schema reaching for a rule
 * nobody has decided about is caught when the block is added, not when an author meets
 * it.
 */
export const SERVER_ONLY_KEYWORDS = {
    pattern:
        "A block's own wording for a pattern is not in the JSON Schema, and a generic sentence " +
        'would contradict the one the server reports on blur.',
    format: 'Formats (e.g. `uri`) are worded by the block and refined further than the format says.',
    enum: '`select` and `segmented` only offer declared values, so there is nothing to type wrong.',
    const: 'Appears only inside structured values the controls build whole.',
    oneOf: '`eligibility`: a structured control that can only emit a valid shape.',
    anyOf: 'A union; no single rule to state about it.',
    items: 'List entries are placed by dotted path, which a later step brings to the browser.',
    properties: 'Inside an object value; see `items`.',
    // The keyword inside an object value — not the rule of the same name, which is
    // read off the block's own top-level `required` list.
    required: 'Inside an object value; see `items`.',
    additionalProperties: 'Inside an object value; see `items`.',
} as const satisfies Readonly<Record<string, string>>;

/** Keywords that describe a value without constraining it. */
const ANNOTATION_KEYWORDS = ['default', 'description', 'title', 'examples'] as const satisfies readonly string[];

/** Every keyword a field's schema may use, and nothing else. See {@link SERVER_ONLY_KEYWORDS}. */
export const KNOWN_FIELD_KEYWORDS: ReadonlySet<string> = new Set([
    ...CHECKED_KEYWORDS,
    ...Object.keys(SERVER_ONLY_KEYWORDS),
    ...ANNOTATION_KEYWORDS,
]);

/** One property of a block's config, as zod exports it. */
type JsonSchemaProperty = Readonly<Record<string, unknown>>;

interface JsonSchemaObject {
    readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
    readonly required?: readonly string[];
}

/**
 * The JSON Schema of each drawn field, keyed by field.
 *
 * Exported for the conformance gate, which needs the raw keywords. `io: 'input'` because
 * what an author types is the input — a field with a `.default()` is then rightly not
 * required.
 */
export function fieldJsonSchemas(
    definition: Pick<BlockManifest, 'configSchema' | 'configFields'>
): { readonly properties: ReadonlyMap<string, JsonSchemaProperty>; readonly required: ReadonlySet<string> } {
    const exported = z.toJSONSchema(definition.configSchema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaObject;
    const properties = new Map<string, JsonSchemaProperty>();
    for (const field of definition.configFields) {
        const property = exported.properties?.[field.key];
        if (property) properties.set(field.key, property);
    }
    return { properties, required: new Set(exported.required ?? []) };
}

/** The numeric value of a limit keyword, when the schema sets one. */
function limitOf(property: JsonSchemaProperty, keyword: LimitRule): number | undefined {
    const value = property[keyword];
    return typeof value === 'number' ? value : undefined;
}

/**
 * Every drawn field's checks, in the order they are evaluated: whether it is there at
 * all, then its type, then its limits. The first that fails is the one shown.
 *
 * **`required` means "nothing typed", and is only stated where the schema refuses
 * both** an absent value and, for a string, the empty one. A required string with no
 * minimum accepts `''`, so saying "fill this in" about an empty box there would be a
 * complaint the server never makes.
 */
export function deriveFieldChecks(definition: Pick<BlockManifest, 'configSchema' | 'configFields'>): FieldChecksByKey {
    const { properties, required } = fieldJsonSchemas(definition);
    const byKey: Record<string, readonly FieldCheck[]> = {};

    for (const field of definition.configFields) {
        const property = properties.get(field.key);
        const checks: FieldCheck[] = [];

        if (property) {
            const isString = property.type === 'string';
            if (required.has(field.key) && (!isString || (limitOf(property, 'minLength') ?? 0) >= 1)) {
                checks.push(withMessage({ rule: 'required' }));
            }
            if (property.type === 'integer') {
                checks.push(withMessage({ rule: 'integer' }));
            }
            for (const rule of LIMIT_RULES) {
                const limit = limitOf(property, rule);
                if (limit !== undefined) checks.push(withMessage({ rule, limit }));
            }
        }

        byKey[field.key] = checks;
    }

    return byKey;
}

type UnwordedCheck = { readonly rule: 'required' | 'integer' } | { readonly rule: LimitRule; readonly limit: number };

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

/**
 * The one place a check is worded — for the descriptor the browser shows as the author
 * types, and for the issue the server reports about the same value on save. Both read
 * it, so the message does not change under the author when the server answers.
 */
function withMessage(check: UnwordedCheck): FieldCheck {
    switch (check.rule) {
        case 'required':
            return { ...check, message: 'Fill this in.' };
        case 'integer':
            return { ...check, message: 'Whole numbers only.' };
        case 'minLength':
            return {
                ...check,
                message: check.limit === 1 ? "Can't be empty." : `At least ${plural(check.limit, 'character', 'characters')}.`,
            };
        case 'maxLength':
            return { ...check, message: `No more than ${plural(check.limit, 'character', 'characters')}.` };
        case 'minimum':
            return { ...check, message: `At least ${check.limit}.` };
        case 'maximum':
            return { ...check, message: `No more than ${check.limit}.` };
        case 'exclusiveMinimum':
            return { ...check, message: `Must be more than ${check.limit}.` };
        case 'exclusiveMaximum':
            return { ...check, message: `Must be less than ${check.limit}.` };
        case 'minItems':
            return { ...check, message: `Add at least ${plural(check.limit, 'entry', 'entries')}.` };
        case 'maxItems':
            return { ...check, message: `No more than ${plural(check.limit, 'entry', 'entries')}.` };
    }
}

/**
 * The first of `checks` that `value` fails, if any.
 *
 * Mirrored in the browser by `web/src/flows/fieldChecks.ts`, which must give the same
 * answer for every value; the parity test in `__tests__/fieldChecks.test.ts` asks both.
 * A rule about a kind of value (a length, a range) passes any other kind: the type is
 * the schema's business, and saying "too long" about a number would be wrong twice.
 */
export function failedFieldCheck(checks: readonly FieldCheck[], value: unknown): FieldCheck | undefined {
    return checks.find((check) => !passes(check, value));
}

function passes(check: FieldCheck, value: unknown): boolean {
    switch (check.rule) {
        case 'required':
            return value !== undefined && value !== '';
        case 'integer':
            return typeof value !== 'number' || Number.isInteger(value);
        case 'minLength':
            return typeof value !== 'string' || value.length >= check.limit;
        case 'maxLength':
            return typeof value !== 'string' || value.length <= check.limit;
        case 'minimum':
            return typeof value !== 'number' || value >= check.limit;
        case 'maximum':
            return typeof value !== 'number' || value <= check.limit;
        case 'exclusiveMinimum':
            return typeof value !== 'number' || value > check.limit;
        case 'exclusiveMaximum':
            return typeof value !== 'number' || value < check.limit;
        case 'minItems':
            return !Array.isArray(value) || value.length >= check.limit;
        case 'maxItems':
            return !Array.isArray(value) || value.length <= check.limit;
    }
}

/**
 * The zod issue codes a field check can explain — absence, type, and size — and which
 * rules can raise each. A check outside an issue's set did not raise it, so its message
 * would describe something else.
 */
const RULES_BY_CODE: Partial<Record<z.core.$ZodIssue['code'], ReadonlySet<FieldCheckRule>>> = {
    invalid_type: new Set(['required', 'integer']),
    too_small: new Set(['required', 'minLength', 'minimum', 'exclusiveMinimum', 'minItems']),
    too_big: new Set(['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems']),
};

/**
 * The sentence for one schema complaint about a node, when one of its field's checks
 * explains it — for `validateNodeData`'s `issueMessage`.
 *
 * The builder shows a check's message as the author types, so a complaint the same
 * check explains is worded the same way on the server — otherwise "Fill this in." would
 * turn into zod's "Too small: expected string to have >=1 characters" the moment the
 * server answered. Anything no check states — a `.refine()`, a pattern, an entry inside a
 * list — is left to its block's own wording (`undefined`).
 */
export function fieldCheckIssueMessage(
    issue: z.core.$ZodIssue,
    node: { readonly type: string; readonly data: Record<string, unknown> }
): string | undefined {
    // Only the codes a check can state. A pattern failure on a value that is also too
    // long is two complaints, and rewording both would say "too long" twice.
    const raisedBy = RULES_BY_CODE[issue.code];
    if (issue.path.length !== 1 || !raisedBy) return undefined;
    const definition = getBlockDefinition(node.type);
    if (!definition) return undefined;

    const key = String(issue.path[0]);
    const failed = failedFieldCheck(fieldChecksOf(definition)[key] ?? [], node.data[key]);
    return failed && raisedBy.has(failed.rule) ? failed.message : undefined;
}

const derivedByBlock = new WeakMap<object, FieldChecksByKey>();

/**
 * {@link deriveFieldChecks}, once per block. The registry's definitions live as long as
 * the process, and a save asks about every node on the canvas.
 */
export function fieldChecksOf(definition: Pick<BlockManifest, 'configSchema' | 'configFields'>): FieldChecksByKey {
    let derived = derivedByBlock.get(definition);
    if (!derived) {
        derived = deriveFieldChecks(definition);
        derivedByBlock.set(definition, derived);
    }
    return derived;
}
