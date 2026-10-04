import { z, type OpenAPIHono } from '@hono/zod-openapi';

/**
 * Carries the server's own refusal sentences into the spec, beside the rules they belong
 * to, so the zod the SDK generates for the browser refuses a field with the same words the
 * server would.
 *
 * Each request rule with a fixed message — `z.string().min(1, 'Pick a channel. …')` — is
 * recorded as `x-messages: { minLength: 'Pick a channel. …' }` in the schema node's zod
 * metadata, which zod-to-openapi copies into the emitted schema beside `minLength`. The
 * SDK generator's resolvers (`packages/web-sdk/zodMessageResolvers.ts`) pass it on as the
 * message argument of the generated rule.
 *
 * A rule the browser cannot be given faithfully fails the emit instead of travelling
 * silently wrong — see {@link attachRequestMessages}. A rule with no custom message is left
 * alone: the server's `defaultHook` sends zod's own sentence, and the browser's zod makes
 * the same one.
 */

/**
 * The spec extension that holds a schema node's sentences, keyed by the keyword they
 * explain. `packages/web-sdk/zodMessageResolvers.ts` mirrors it and the keywords below,
 * and `requestMessageVocabulary.test.ts` there holds the two copies equal.
 */
export const REQUEST_MESSAGES_EXTENSION = 'x-messages';

/**
 * The keywords a sentence can travel beside. `integer` is the one named for a value rather
 * than a keyword: zod-to-openapi writes `.int()` as `type: 'integer'`, and its sentence
 * travels beside that.
 */
export const REQUEST_MESSAGE_KEYWORDS = [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'pattern',
    'integer',
] as const;

type RequestMessageKeyword = (typeof REQUEST_MESSAGE_KEYWORDS)[number];

/** One schema node's sentences, as written under {@link REQUEST_MESSAGES_EXTENSION}. */
type RequestMessages = Partial<Record<RequestMessageKeyword, string>>;

/** One entry of the registry a document is generated from. */
type OpenApiDefinition = OpenAPIHono['openAPIRegistry']['definitions'][number];

/** The definition of every built-in check zod can put on a schema, discriminated by `check`. */
type CheckDef = z.core.$ZodChecks['_zod']['def'];

/** What an `error` option turned out to be when probed with a blank issue. */
type MessageProbe =
    | { readonly kind: 'none' }
    | { readonly kind: 'fixed'; readonly sentence: string }
    | { readonly kind: 'dynamic'; readonly evidence: string };

/** What one check feeds into its node's spec schema: the keywords it emits, and its sentence if it has one. */
interface CheckContribution {
    readonly keywords: readonly RequestMessageKeyword[];
    readonly sentence: string | undefined;
}

/** Adds one rule the browser cannot be given faithfully to the walk's list. */
type ReportProblem = (problem: string) => void;

/** State shared by one walk over every route. */
interface WalkState {
    /** Nodes already handled — a node shared by several routes, or reached again through a lazy schema. */
    readonly visited: Set<z.core.$ZodType>;
    readonly report: ReportProblem;
}

/** Where in a route the walk is, for naming it in a failure. */
interface WalkPosition {
    /** `PUT /api/guilds/{guildId}/warnings`. */
    readonly route: string;
    /** `body.graph.nodes[].id`. */
    readonly field: string;
}

/**
 * Records each request rule's fixed sentence as `x-messages` in its zod schema node's
 * metadata, so the document generated next carries it beside the rule's keyword. Call it
 * on a registry's definitions before generating the document from them.
 *
 * Walks every route's path parameters, query and JSON body — what the dashboard sends and
 * checks — and every schema registered as a component of its own (the Flow Builder's
 * `FlowBlockFieldRules`), through every wrapper and container zod has. Throws, naming each
 * route and field, when a request schema holds a rule the browser cannot be given faithfully:
 *  - **a dynamic message**, an `error` function that reads the issue. Nothing fixed can be
 *    written down at build time.
 *  - **a `.refine()` / `.superRefine()` / `z.custom()`**, a rule the browser cannot run
 *    from the spec. Move it into the handler.
 *  - **a `.regex()` with flags.** zod-to-openapi emits `/^abc$/i` as the pattern `^abc$/i`,
 *    so the browser would refuse valid input.
 *  - **a fixed sentence with no keyword to travel beside** — on `z.email()`, `z.int()`
 *    (whose sentence words a wrong type too; `.int('…')` travels), `.startsWith()`, an
 *    array's `.length()`, a schema's own type error (`z.string('…')`), and the like. The
 *    browser would show zod's default sentence where the server sends this one.
 *  - **two rules on one node feeding the same keyword, unless both carry the same
 *    sentence** (`.min(1, '…').min(3)`). The spec holds one bound per keyword and
 *    zod-to-openapi picks which by rules of its own, so the sentence could end up beside a
 *    bound it does not describe.
 * Both sides of a `.pipe()` are walked; only the side zod-to-openapi documents (the input,
 * or the output of a preprocess) reaches the spec, so a sentence on the other side is
 * recorded but never emitted — the browser under-reports that rule, which it may.
 *
 * A normalising step (`.trim()`, `.toLowerCase()`) is not in the spec either, so the
 * browser checks the value as typed where the server checks it normalised. A page checks
 * what it will send, normalised the same way — as `sdk-4-ticket-settings.md` §3 does for
 * the ticket type's trimmed label.
 *
 * **Side effect:** the metadata lives in zod's process-wide `z.globalRegistry`, on schema
 * objects shared by every app built from the same route modules. That is safe because it
 * is idempotent: a node's `x-messages` is recomputed from its own checks and replaced
 * whole, never merged into what an earlier call wrote, and the checks of a zod schema
 * cannot change. Its other metadata is kept — as `z.globalRegistry.get` reports it, which
 * folds in metadata inherited from the schema it was cloned from; reading the node then
 * answers exactly as before. The metadata is per schema object, not per request: a clone
 * of a walked node (`.max(50)` on a shared name rule) inherits its `x-messages`, so if a
 * clone the walk never visits — in a response, say — tightens a worded bound, the spec
 * shows the old sentence beside the new bound.
 */
export function attachRequestMessages(definitions: readonly OpenApiDefinition[]): void {
    const problems: string[] = [];
    const state: WalkState = { visited: new Set(), report: (problem) => problems.push(problem) };

    for (const definition of definitions) {
        if (definition.type === 'schema') {
            // A component registered on its own, reached by no route. The one there is,
            // `FlowBlockFieldRules`, is there for the browser to check against, so it is
            // held to the same rules as a request; a response-only component registered
            // this way would be too. The path names the block and field inside it.
            walkRequestPart(definition.schema, { route: 'components.schemas', field: '' }, state);
            continue;
        }
        if (definition.type !== 'route') {
            continue;
        }
        const { method, path, request } = definition.route;
        const route = `${method.toUpperCase()} ${path}`;
        walkRequestPart(request?.params, { route, field: 'params' }, state);
        walkRequestPart(request?.query, { route, field: 'query' }, state);
        const jsonContent = request?.body?.content['application/json'];
        if (jsonContent && 'schema' in jsonContent) {
            walkRequestPart(jsonContent.schema, { route, field: 'body' }, state);
        }
    }

    if (problems.length) {
        throw new Error(
            'Request rules the browser cannot be given faithfully (see `requestMessages.ts`):\n' +
                problems.map((problem) => `  - ${problem}`).join('\n')
        );
    }
}

/** Walks one part of a request when it is a zod schema; a hand-written spec object has no rules to read. */
function walkRequestPart(part: unknown, position: WalkPosition, state: WalkState): void {
    if (part instanceof z.core.$ZodType) {
        walkSchema(part, position, state);
    }
}

function walkSchema(schema: z.core.$ZodType, position: WalkPosition, state: WalkState): void {
    if (state.visited.has(schema)) {
        return;
    }
    state.visited.add(schema);

    recordMessages(schema, `${position.route} ${position.field}`, state.report);

    // `$ZodTypes` is every schema class zod ships, and `def.type` is the discriminant zod's
    // own JSON Schema generator switches on; the cast is what lets the switch narrow `def`.
    const def = (schema as z.core.$ZodTypes)._zod.def;
    const child = (next: z.core.$ZodType, suffix: string): void =>
        walkSchema(next, { route: position.route, field: `${position.field}${suffix}` }, state);

    switch (def.type) {
        case 'object':
            for (const [key, value] of Object.entries(def.shape)) {
                child(value, `.${key}`);
            }
            if (def.catchall) {
                child(def.catchall, '.*');
            }
            return;
        case 'array':
            child(def.element, '[]');
            return;
        case 'tuple':
            def.items.forEach((item, index) => child(item, `[${index}]`));
            if (def.rest) {
                child(def.rest, '[...]');
            }
            return;
        case 'union':
            def.options.forEach((option, index) => child(option, `(option ${index})`));
            return;
        case 'intersection':
            child(def.left, '(left)');
            child(def.right, '(right)');
            return;
        case 'record':
        case 'map':
            child(def.keyType, '{key}');
            child(def.valueType, '{value}');
            return;
        case 'set':
            child(def.valueType, '{value}');
            return;
        case 'pipe':
            child(def.in, '(in)');
            child(def.out, '(out)');
            return;
        case 'lazy':
            child(def.getter(), '');
            return;
        case 'optional':
        case 'nullable':
        case 'default':
        case 'prefault':
        case 'nonoptional':
        case 'readonly':
        case 'catch':
        case 'success':
        case 'promise':
            child(def.innerType, '');
            return;
        case 'custom':
            state.report(
                `${position.route} ${position.field}: a \`z.custom()\` schema, which the browser cannot run from the spec. Check it in the handler instead.`
            );
            return;
        case 'string':
        case 'number':
        case 'bigint':
        case 'boolean':
        case 'date':
        case 'symbol':
        case 'undefined':
        case 'null':
        case 'any':
        case 'unknown':
        case 'never':
        case 'void':
        case 'enum':
        case 'literal':
        case 'function':
        case 'template_literal':
        case 'transform':
        case 'nan':
        case 'file':
            return;
        default: {
            const unhandled: never = def;
            throw new Error(`requestMessages.ts cannot walk a schema of type ${String(unhandled)}.`);
        }
    }
}

/**
 * Reads one node's rules: records the sentences that can travel in its metadata, and
 * reports each rule that cannot.
 *
 * @param at - The route and field, as a failure names them.
 */
function recordMessages(schema: z.core.$ZodType, at: string, report: ReportProblem): void {
    const def = schema._zod.def;
    if (def.type === 'custom') {
        // A `z.custom()` fails whole, reported once by `walkSchema`; nothing on it can travel.
        return;
    }
    const checkDefs: z.core.$ZodCheckDef[] = (def.checks ?? []).map((check) => check._zod.def);

    // A format schema (`z.iso.datetime()`, `z.email()`, `z.int()`) is its own check, its
    // sentence on the schema — where it also words a value of the wrong type, which no
    // keyword can carry. Any other schema's own `error` words only its type refusal.
    const formatSchema = 'check' in def && typeof def.check === 'string' ? { ...def, check: def.check } : undefined;
    if (formatSchema) {
        checkDefs.push(formatSchema);
    } else {
        const sentence = fixedSentence(def.error, "the schema's own error message", at, report);
        if (sentence !== undefined) {
            report(`${at}: ${noKeywordFor(`the schema's own error ("${sentence}")`)}`);
        }
    }

    const sentencesByKeyword = new Map<RequestMessageKeyword, (string | undefined)[]>();
    for (const checkDef of checkDefs) {
        const contribution = inspectCheck(checkDef, def.type, at, report, checkDef === formatSchema);
        for (const keyword of contribution?.keywords ?? []) {
            sentencesByKeyword.set(keyword, [...(sentencesByKeyword.get(keyword) ?? []), contribution?.sentence]);
        }
    }

    const messages: RequestMessages = {};
    for (const [keyword, sentences] of sentencesByKeyword) {
        if (new Set(sentences).size > 1) {
            report(
                `${at}: ${sentences.length} rules feed \`${keyword}\` and not all with the same sentence; the spec holds one bound per keyword, so a sentence could sit beside a bound it does not describe. Make it one rule.`
            );
            continue;
        }
        const [sentence] = sentences;
        if (sentence !== undefined) {
            messages[keyword] = sentence;
        }
    }

    if (Object.keys(messages).length) {
        z.globalRegistry.add(schema, { ...z.globalRegistry.get(schema), [REQUEST_MESSAGES_EXTENSION]: messages });
    }
}

/**
 * What one check feeds into the spec, judged by its kind and by the type of node it is
 * on; `undefined` for a check that was reported instead.
 *
 * @param isFormatSchema - The check is a format schema itself (`z.int('…')`), whose
 * sentence words a value of the wrong type too; the browser's copy of the rule would not,
 * so the sentence has nowhere faithful to travel.
 */
function inspectCheck(
    checkDef: z.core.$ZodCheckDef,
    ownerType: z.core.$ZodTypeDef['type'],
    at: string,
    report: ReportProblem,
    isFormatSchema: boolean
): CheckContribution | undefined {
    if (checkDef.check === 'custom') {
        report(`${at}: a \`.refine()\`/\`.superRefine()\` rule, which the browser cannot run from the spec. Check it in the handler instead.`);
        return undefined;
    }

    // `check` discriminates zod's built-in checks; `custom` is the one kind outside `$ZodChecks`, handled above.
    const def = checkDef as CheckDef;
    // Only a `.regex()` reaches the spec as `pattern`; a format's own pattern (`z.emoji()`'s `u`) never does.
    if (def.check === 'string_format' && def.format === 'regex' && def.pattern?.flags) {
        report(
            `${at}: the pattern /${def.pattern.source}/${def.pattern.flags} has flags, which the spec cannot express — zod-to-openapi would emit "${def.pattern.source}/${def.pattern.flags}" and the browser would refuse valid input. Write it without flags.`
        );
    }

    const keywords = isFormatSchema ? [] : keywordsFor(def, ownerType);
    const sentence = fixedSentence(def.error, `the \`${describeCheck(def)}\` rule's message`, at, report);
    if (sentence !== undefined && !keywords.length) {
        report(`${at}: ${noKeywordFor(`the \`${describeCheck(def)}\` rule's sentence ("${sentence}")`)}`);
        return undefined;
    }
    return { keywords, sentence };
}

/** The failure for a fixed sentence the spec has no keyword to carry. */
function noKeywordFor(what: string): string {
    return `${what} has no spec keyword to travel beside, so the browser would show zod's default sentence instead. Drop the custom message, or teach requestMessages.ts to carry it.`;
}

/**
 * The fixed sentence an `error` option gives, or `undefined` when it gives none. A
 * dynamic one is reported, and also answers `undefined`.
 *
 * @param label - What the option belongs to, as a failure names it.
 */
function fixedSentence(
    error: z.core.$ZodErrorMap<never> | undefined,
    label: string,
    at: string,
    report: ReportProblem
): string | undefined {
    const probe = probeMessage(error);
    switch (probe.kind) {
        case 'none':
            return undefined;
        case 'dynamic':
            report(
                `${at}: ${label} is a function of the issue (${probe.evidence}), so no fixed sentence can be written into the spec. Give it a fixed sentence, or none.`
            );
            return undefined;
        case 'fixed':
            return probe.sentence;
    }
}

/** The spec keywords zod-to-openapi emits for a check on a node of `ownerType`; empty when none. */
function keywordsFor(def: CheckDef, ownerType: z.core.$ZodTypeDef['type']): readonly RequestMessageKeyword[] {
    switch (def.check) {
        case 'min_length':
            return lengthKeywords(ownerType, 'min');
        case 'max_length':
            return lengthKeywords(ownerType, 'max');
        case 'length_equals':
            // zod-to-openapi emits an exact length for a string only; an array's is dropped from the spec.
            return ownerType === 'string' ? ['minLength', 'maxLength'] : [];
        case 'greater_than':
            if (ownerType !== 'number') {
                return [];
            }
            return [def.inclusive ? 'minimum' : 'exclusiveMinimum'];
        case 'less_than':
            if (ownerType !== 'number') {
                return [];
            }
            return [def.inclusive ? 'maximum' : 'exclusiveMaximum'];
        case 'string_format':
            return def.format === 'regex' ? ['pattern'] : [];
        case 'number_format':
            // `.int()`, which zod-to-openapi writes as `type: 'integer'`. The 32-bit and
            // float formats emit bounds of their own that no sentence was written for.
            return def.format === 'safeint' ? ['integer'] : [];
        case 'multiple_of':
        case 'bigint_format':
        case 'max_size':
        case 'min_size':
        case 'size_equals':
        case 'property':
        case 'mime_type':
        case 'overwrite':
            return [];
        default: {
            const unhandled: never = def;
            throw new Error(`requestMessages.ts does not know the check ${String(unhandled)}.`);
        }
    }
}

function lengthKeywords(ownerType: z.core.$ZodTypeDef['type'], bound: 'min' | 'max'): readonly RequestMessageKeyword[] {
    switch (ownerType) {
        case 'string':
            return [bound === 'min' ? 'minLength' : 'maxLength'];
        case 'array':
            return [bound === 'min' ? 'minItems' : 'maxItems'];
        default:
            return [];
    }
}

/** A check's kind, with its format when it has one (`string_format:email`), for naming it in a failure. */
function describeCheck(def: CheckDef): string {
    return def.check === 'string_format' ? `${def.check}:${def.format}` : def.check;
}

/**
 * Whether an `error` option is a fixed sentence, by calling it with an issue that records
 * every read. zod wraps even a plain string in a function, so the function itself says
 * nothing; what it reads does. One that reads nothing and returns a sentence is fixed. One
 * that reads anything — or throws, which on a blank issue means it reached for something —
 * depends on the issue. One that returns nothing leaves zod's default in place.
 */
function probeMessage(error: z.core.$ZodErrorMap<never> | undefined): MessageProbe {
    if (!error) {
        return { kind: 'none' };
    }

    const reads: string[] = [];
    const blankIssue = new Proxy(
        {},
        {
            get: (_target, property) => {
                reads.push(String(property));
                return undefined;
            },
            has: (_target, property) => {
                reads.push(String(property));
                return false;
            },
            ownKeys: () => {
                reads.push('its keys');
                return [];
            },
        }
    );

    let result: ReturnType<z.core.$ZodErrorMap<never>>;
    try {
        // `never`: the map is typed to take an issue of no particular kind; the blank one stands in for any.
        result = error(blankIssue as never);
    } catch (thrown) {
        const reason = thrown instanceof Error ? thrown.message : String(thrown);
        return { kind: 'dynamic', evidence: `it threw on a blank issue: ${reason}` };
    }

    if (reads.length) {
        return { kind: 'dynamic', evidence: `it reads ${[...new Set(reads)].join(', ')}` };
    }
    if (typeof result === 'string') {
        return { kind: 'fixed', sentence: result };
    }
    if (result) {
        return { kind: 'fixed', sentence: result.message };
    }
    return { kind: 'none' };
}
