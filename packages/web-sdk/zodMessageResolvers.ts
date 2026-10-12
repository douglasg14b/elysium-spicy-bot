import type { Plugins } from '@hey-api/openapi-ts';

/*
 * Gives each generated zod rule the server's own sentence as its message, so the browser
 * refuses a field with the words the server would — `z.string().min(1, 'Pick a channel. …')`
 * rather than zod's "Too small: expected string to have >=1 characters".
 *
 * The sentences arrive in the spec as `x-messages` beside the keyword they explain,
 * written by `src/web/api/requestMessages.ts` from the route's zod. hey-api copies every
 * `x-` key of a spec schema onto its parsed schema, so each resolver below reads them
 * there, swaps in a version of the matching rule node that passes the sentence as the
 * message argument, and returns `undefined` so hey-api's own resolver builds the chain
 * with it. A rule with no sentence is left to hey-api's node untouched.
 *
 * The pattern node is hey-api's own, which already takes a message (`x-pattern-message`).
 * The length and bound nodes have no such hook, so theirs repeat hey-api's call for the
 * rule (`min`, `length`, `gte` …) with one argument more. The whole-number rule is the one
 * written differently from hey-api — `z.number().int(message)` for its `z.int()` — and
 * says why where it does it. The zod v4 plugin's nodes are in
 * `@hey-api/openapi-ts/dist/init-*.mjs`, region `src/plugins/zod/v4/toAst/`. An upgrade
 * that changes them shows up in `zodMessageResolvers.test.ts`, which holds every worded
 * line to hey-api's unworded one, as a stale SDK (`generatedSdkIsCurrent.test.ts`), and as
 * a sentence missing from `zod.gen.ts` (`requestMessagesInSdk.test.ts`).
 */

/*
 * The extension and keywords `requestMessages.ts` writes. Mirrored, not imported: the SDK
 * does not compile the bot. `requestMessageVocabulary.test.ts` holds the two copies equal.
 */
export const REQUEST_MESSAGES_EXTENSION = 'x-messages';

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

const KNOWN_KEYWORDS: ReadonlySet<string> = new Set(REQUEST_MESSAGE_KEYWORDS);

type RequestMessages = Partial<Record<RequestMessageKeyword, string>>;

type ZodResolvers = Plugins.Zod.Resolvers;
type StringContext = Parameters<NonNullable<ZodResolvers['string']>>[0];
type ArrayContext = Parameters<NonNullable<ZodResolvers['array']>>[0];
type NumberContext = Parameters<NonNullable<ZodResolvers['number']>>[0];

/** What every resolver context offers that finding a schema's sentences needs. */
type MessageSource = Pick<StringContext | ArrayContext | NumberContext, 'schema' | 'plugin'>;

/**
 * The zod plugin's `$resolvers`: string, array and number rules carry the server's
 * sentence when the spec has one for them.
 */
export const ZOD_MESSAGE_RESOLVERS: ZodResolvers = {
    string: (ctx) => {
        const messages = requestMessagesFor(ctx);
        if (!Object.keys(messages).length) {
            return undefined;
        }
        const { length, minLength, maxLength, pattern } = ctx.nodes;
        const { $ } = ctx;

        ctx.nodes.length = (node) => {
            const { minLength: size, maxLength: sameSize } = node.schema;
            const { minLength: minMessage, maxLength: maxMessage } = messages;
            if (size === undefined || size !== sameSize || (minMessage === undefined && maxMessage === undefined)) {
                return length(node);
            }
            // `.length(n)` has one message for both bounds. Anything else — one bound worded,
            // or two different sentences — needs `.min` and `.max`, each with its own.
            if (minMessage === undefined || minMessage !== maxMessage) {
                return undefined;
            }
            return node.chain.current.attr('length').call($.literal(size), $.literal(minMessage));
        };
        ctx.nodes.minLength = (node) => {
            const { minLength: bound } = node.schema;
            const message = messages.minLength;
            return bound === undefined || message === undefined
                ? minLength(node)
                : node.chain.current.attr('min').call($.literal(bound), $.literal(message));
        };
        ctx.nodes.maxLength = (node) => {
            const { maxLength: bound } = node.schema;
            const message = messages.maxLength;
            return bound === undefined || message === undefined
                ? maxLength(node)
                : node.chain.current.attr('max').call($.literal(bound), $.literal(message));
        };
        // hey-api's own pattern node takes a message from `x-pattern-message`; hand it ours.
        // Only on the copy it is given — the spec on the wire keeps `x-messages` alone.
        ctx.nodes.pattern = (node) =>
            messages.pattern === undefined
                ? pattern(node)
                : pattern({ ...node, schema: { ...node.schema, 'x-pattern-message': messages.pattern } });
        return undefined;
    },

    array: (ctx) => {
        const messages = requestMessagesFor(ctx);
        if (!Object.keys(messages).length) {
            return undefined;
        }
        const { length, minLength, maxLength } = ctx.nodes;
        const { $ } = ctx;

        ctx.nodes.length = (node) => {
            const { minItems: size, maxItems: sameSize } = node.schema;
            const { minItems: minMessage, maxItems: maxMessage } = messages;
            if (size === undefined || size !== sameSize || (minMessage === undefined && maxMessage === undefined)) {
                return length(node);
            }
            // As for strings: one `.length(n, message)` only when both bounds share the sentence.
            if (minMessage === undefined || minMessage !== maxMessage) {
                return undefined;
            }
            return node.chain.current.attr('length').call($.fromValue(size), $.literal(minMessage));
        };
        ctx.nodes.minLength = (node) => {
            const { minItems: bound } = node.schema;
            const message = messages.minItems;
            return bound === undefined || message === undefined
                ? minLength(node)
                : node.chain.current.attr('min').call($.fromValue(bound), $.literal(message));
        };
        ctx.nodes.maxLength = (node) => {
            const { maxItems: bound } = node.schema;
            const message = messages.maxItems;
            return bound === undefined || message === undefined
                ? maxLength(node)
                : node.chain.current.attr('max').call($.fromValue(bound), $.literal(message));
        };
        return undefined;
    },

    number: (ctx) => {
        const messages = requestMessagesFor(ctx);
        if (!Object.keys(messages).length) {
            return undefined;
        }
        const { base, min, max } = ctx.nodes;
        const { $ } = ctx;

        // hey-api writes `type: 'integer'` as `z.int()`, whose message would also word a
        // value that is not a number at all. The server's `.int('…')` words only a fraction,
        // so the sentence goes on an `.int()` after a plain number, as the server wrote it.
        ctx.nodes.base = (node) => {
            const message = messages.integer;
            if (message === undefined || node.schema.type !== 'integer' || node.utils.shouldCoerceToBigInt(node.schema.format)) {
                return base(node);
            }
            return $(node.symbols.z).attr('number').call().attr('int').call($.literal(message));
        };
        // The keyword hey-api's node picks decides which sentence goes with it: exclusive first.
        ctx.nodes.min = (node) => {
            const { exclusiveMinimum, minimum, format } = node.schema;
            const [method, bound, message] =
                exclusiveMinimum !== undefined
                    ? (['gt', exclusiveMinimum, messages.exclusiveMinimum] as const)
                    : (['gte', minimum, messages.minimum] as const);
            return bound === undefined || message === undefined
                ? min(node)
                : node.chain.current.attr(method).call(node.utils.maybeBigInt(bound, format), $.literal(message));
        };
        ctx.nodes.max = (node) => {
            const { exclusiveMaximum, maximum, format } = node.schema;
            const [method, bound, message] =
                exclusiveMaximum !== undefined
                    ? (['lt', exclusiveMaximum, messages.exclusiveMaximum] as const)
                    : (['lte', maximum, messages.maximum] as const);
            return bound === undefined || message === undefined
                ? max(node)
                : node.chain.current.attr(method).call(node.utils.maybeBigInt(bound, format), $.literal(message));
        };
        return undefined;
    },
};

/**
 * The sentences for the schema a resolver is building.
 *
 * Usually they sit on the schema itself. A nullable one is the exception: hey-api parses
 * `type: ['string', 'null']` into a union whose two parts get none of the `x-` keys —
 * those stay on the union. So a part of such a pair takes the union's sentences, found
 * through {@link nullablePartMessages}.
 */
function requestMessagesFor(ctx: MessageSource): RequestMessages {
    const own = ctx.schema[REQUEST_MESSAGES_EXTENSION];
    if (own !== undefined) {
        return parseRequestMessages(own);
    }
    return nullablePartMessages(ctx.plugin.context.ir).get(ctx.schema) ?? {};
}

/** One index per parsed spec, built on first use. */
const nullablePartIndexes = new WeakMap<object, WeakMap<object, RequestMessages>>();

/**
 * The sentences each nullable pair's non-null part inherits, keyed by that part's parsed
 * schema object.
 *
 * Keyed by identity, not by path: hey-api walks a union's parts as the very objects in its
 * parsed spec — under `components`, and inline in an operation, whose body and parameter
 * schemas are those same objects — while its walk paths follow a layout of their own
 * (array elements, union branches and operation parts all differ from the spec's).
 *
 * Built by visiting the whole parsed spec once. A union carrying `x-messages` must be a
 * nullable pair — exactly one `null` part and one other — since that is the only shape
 * zod-to-openapi gives a worded rule a union of; any other shape fails the generation
 * rather than leaving its sentences unattributed.
 */
function nullablePartMessages(ir: unknown): WeakMap<object, RequestMessages> {
    if (typeof ir !== 'object' || ir === null) {
        throw new Error('The zod plugin ran without a parsed spec; there is nothing to find sentences in.');
    }
    const cached = nullablePartIndexes.get(ir);
    if (cached) {
        return cached;
    }

    const index = new WeakMap<object, RequestMessages>();
    const visited = new Set<object>();
    const visit = (node: unknown): void => {
        // Plain data only: the parsed spec may already hold generator symbols, which are not schemas.
        if (typeof node !== 'object' || node === null || visited.has(node) || !isPlainData(node)) {
            return;
        }
        visited.add(node);
        const values: unknown[] = Object.values(node);
        values.forEach(visit);

        const inherited: unknown = Reflect.get(node, REQUEST_MESSAGES_EXTENSION);
        const items: unknown = Reflect.get(node, 'items');
        if (inherited === undefined || Reflect.get(node, 'logicalOperator') !== 'or' || !Array.isArray(items)) {
            return;
        }
        const parts: unknown[] = items;
        const nullParts = parts.filter((part) => typeof part === 'object' && part !== null && Reflect.get(part, 'type') === 'null');
        const otherParts = parts.filter((part) => !nullParts.includes(part));
        const [part] = otherParts;
        if (nullParts.length !== 1 || otherParts.length !== 1 || typeof part !== 'object' || part === null) {
            throw new Error(
                `A union carries ${REQUEST_MESSAGES_EXTENSION} (${JSON.stringify(inherited)}) but is not a nullable pair, ` +
                    'so its sentences belong to no one part. See zodMessageResolvers.ts.'
            );
        }
        index.set(part, parseRequestMessages(inherited));
    };
    visit(ir);

    nullablePartIndexes.set(ir, index);
    return index;
}

function isPlainData(node: object): boolean {
    const prototype: unknown = Object.getPrototypeOf(node);
    return Array.isArray(node) || prototype === Object.prototype || prototype === null;
}

/**
 * An `x-messages` value read back from the spec. `requestMessages.ts` writes only known
 * keywords and strings, so anything else is a bug in one side or the other and fails the
 * generation rather than dropping a sentence.
 */
function parseRequestMessages(value: unknown): RequestMessages {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${REQUEST_MESSAGES_EXTENSION} must be an object of sentences, not ${JSON.stringify(value)}.`);
    }
    const messages: RequestMessages = {};
    const entries: [string, unknown][] = Object.entries(value);
    for (const [keyword, sentence] of entries) {
        if (!isRequestMessageKeyword(keyword) || typeof sentence !== 'string') {
            throw new Error(
                `${REQUEST_MESSAGES_EXTENSION} holds ${JSON.stringify(keyword)}: ${JSON.stringify(sentence)}; ` +
                    'expected a known keyword and a sentence.'
            );
        }
        messages[keyword] = sentence;
    }
    return messages;
}

function isRequestMessageKeyword(keyword: string): keyword is RequestMessageKeyword {
    return KNOWN_KEYWORDS.has(keyword);
}
