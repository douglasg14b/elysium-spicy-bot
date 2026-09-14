import type { BlockConfigField } from '../blocks/manifest';
import type { FlowRunSeed, FlowVariableValue } from '../blocks/types';

/**
 * Expanding `{{…}}` tokens in authored copy, in one place.
 *
 * **One renderer, used everywhere copy is emitted.** The alternative — each block
 * substituting its own fields — puts the token vocabulary in as many places as
 * there are blocks with a message body, and the third one silently supports a
 * different set from the first two. Here a block declares which of its fields
 * carry copy (`rendersTokens`) and the executor renders them before `run` ever
 * sees them, so a block's own code never knows tokens exist.
 *
 * The vocabulary is deliberately small and closed. An author writes
 * `{{subject.mention}}`, not an expression language: a flow builder is not a
 * template engine, and every construct added here is one that save-time
 * validation, the inspector, and every future surface have to agree about.
 */

/**
 * A token's leading segment — what the token is *about*.
 *
 * `var` is open-ended on its second segment (an author names their own outputs);
 * the other three are closed sets, enumerated in {@link RESOLVERS}.
 */
const VARIABLE_NAMESPACE = 'var';

/**
 * Everything `{{…}}` could contain, matched permissively on purpose.
 *
 * Deliberately **not** narrowed to the tokens that resolve: an unknown token has
 * to be *seen* in order to be rejected by name. A pattern matching only valid
 * tokens would leave `{{subject.foo}}` as ordinary text, which would then be sent
 * to a member with its braces intact — the one outcome this module exists to
 * prevent.
 *
 * Inner whitespace is tolerated (`{{ subject.mention }}`) because an author will
 * type it and a renderer that silently ignored such a token would be reported as
 * a bug in the feature rather than in the copy.
 */
const TOKEN_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** How a resolvable non-variable token reads its value off the run. */
type TokenResolver = (context: FlowRunSeed) => string | undefined;

/**
 * Every non-variable token an author may write.
 *
 * Declared as the literal list rather than derived from {@link RESOLVERS}' keys,
 * so the union survives into the type system: a resolver added without a name
 * here — or a name without a resolver — is a compile error rather than a token
 * that silently never resolves.
 */
export const RENDERABLE_TOKENS = [
    'subject.mention',
    'subject.username',
    'actor.mention',
    'guild.name',
] as const;

export type RenderableToken = (typeof RENDERABLE_TOKENS)[number];

/**
 * The closed part of the vocabulary: token name to the value it stands for.
 *
 * Flat rather than nested by namespace so the whole vocabulary is one readable
 * list and save-time validation can check membership with a single lookup. A
 * resolver returning `undefined` means "this run has nobody/nothing here", which
 * is a *runtime* absence (a resumed run has no actor) rather than an authoring
 * mistake, and is reported differently from an unknown token.
 */
const RESOLVERS: Readonly<Record<RenderableToken, TokenResolver>> = {
    'subject.mention': (context) => context.subject.toString(),
    'subject.username': (context) => context.subject.user.username,
    'actor.mention': (context) => context.actor?.toString(),
    'guild.name': (context) => context.guild.name,
};

/**
 * Whether a string is one of the tokens above.
 *
 * `Object.hasOwn`, never `in` or a bare lookup: `in` walks the prototype chain,
 * so `{{toString}}` and `{{constructor}}` would both be "recognised" — passing
 * save-time validation and then rendering `[object Object]` into a Discord
 * message, or throwing a raw TypeError. Garbage that looks deliberate is worse
 * than the leaked braces this module exists to prevent, because nobody reading
 * the channel would recognise it as a bug.
 */
function isDeclaredToken(token: string): token is RenderableToken {
    return Object.hasOwn(RESOLVERS, token);
}

/**
 * Why a render could not produce copy safe to send.
 *
 * A discriminated result rather than a thrown error or a best-effort string: the
 * executor turns each of these into a `fail` outcome naming the node, and a
 * partially-substituted string is never a thing a caller can accidentally use.
 */
export type CopyRenderResult =
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly error: string };

export interface RenderCopyOptions {
    /** The run the tokens are resolved against. */
    readonly context: FlowRunSeed;
    /**
     * The field's declared `maxLength`, when it has one.
     *
     * Checked against the **rendered** string, which is the only length Discord
     * ever sees: `{{subject.mention}}` is 19 characters of authored copy and
     * around 22 once expanded, so copy that validated at save can still overflow
     * here. Absent simply means the field declared no limit.
     */
    readonly maxLength?: number;
    /** Field and node names, so a failure says where to go and fix it. */
    readonly fieldLabel: string;
}

/**
 * Expand every token in one authored string.
 *
 * Fails rather than degrades, in all three ways a render can go wrong — an
 * unknown token, a token whose value this run does not have, and a result too
 * long for the field. **An unmatched token never reaches a member**: leaking
 * `{{subject.mention}}` into a channel is worse than a run that stops, because
 * the braces are visible to everyone and the flow looks broken to people who
 * cannot fix it.
 */
export function renderCopy(template: string, options: RenderCopyOptions): CopyRenderResult {
    const { context, maxLength, fieldLabel } = options;
    let failure: string | undefined;

    const text = template.replace(TOKEN_PATTERN, (whole, rawToken: string) => {
        // The first failure wins: reporting four unknown tokens in one field
        // buries the one an author would have fixed first.
        if (failure !== undefined) {
            return whole;
        }

        const token = rawToken.trim();
        const variableName = variableNameOf(token);

        if (variableName !== undefined) {
            // `hasOwn` before the read, for the same reason as `isDeclaredToken`:
            // a bare lookup finds `toString` on the prototype of an empty bag and
            // posts the source of a native function into a channel.
            const value = Object.hasOwn(context.variables, variableName)
                ? context.variables[variableName]
                : undefined;
            if (value === undefined) {
                failure =
                    `${fieldLabel} uses {{var.${variableName}}}, but nothing has recorded a value called ` +
                    `"${variableName}" by the time this block runs. Check the block that produces it ` +
                    'actually runs first on this path.';
                return whole;
            }
            return renderVariableValue(value);
        }

        if (!isDeclaredToken(token)) {
            failure = `${fieldLabel} uses {{${token}}}, which is not something a flow can fill in. ${describeVocabulary()}`;
            return whole;
        }

        const resolved = RESOLVERS[token](context);
        if (resolved === undefined) {
            failure =
                `${fieldLabel} uses {{${token}}}, but this run has no ${token.split('.')[0]} — ` +
                'a run woken by the clock was not caused by anybody. Move this block before the wait.';
            return whole;
        }

        return resolved;
    });

    if (failure !== undefined) {
        return { ok: false, error: failure };
    }

    // Checked after substitution, never before: the authored template is not what
    // gets sent. Truncating instead would cut a member's mention in half or drop
    // the end of a sentence, and do it silently every time the copy is long.
    if (maxLength !== undefined && text.length > maxLength) {
        return {
            ok: false,
            error:
                `${fieldLabel} is ${text.length} characters once its tokens are filled in, but the limit is ` +
                `${maxLength}. Shorten the text — the values a flow fills in are longer than the tokens you typed.`,
        };
    }

    return { ok: true, text };
}

/**
 * The `<name>` of a `{{var.<name>}}` token, or undefined for any other token.
 *
 * A single dotted segment only: `var.a.b` is not a nested lookup, because the bag
 * is flat and scalar. Returning undefined for it lets the caller report it as the
 * unknown token it is rather than silently reading `a`.
 */
function variableNameOf(token: string): string | undefined {
    const [namespace, name, ...rest] = token.split('.');
    if (namespace !== VARIABLE_NAMESPACE || !name || rest.length > 0) {
        return undefined;
    }
    return name;
}

/**
 * A stored scalar as it appears in copy.
 *
 * `null` renders as empty rather than the word "null": a variable explicitly set
 * to nothing is an author saying "there is no value here", and printing the
 * JavaScript spelling of that into a Discord message is a leak of the
 * implementation, not information.
 */
function renderVariableValue(value: FlowVariableValue): string {
    return value === null ? '' : String(value);
}

/**
 * What an author may write, as a sentence to append to a rejection.
 *
 * Exported so save-time validation says exactly what the renderer says. The two
 * messages were briefly identical strings assembled in two files, which is the
 * kind of duplication that stays true right up until somebody adds a token.
 */
export function describeVocabulary(): string {
    return `You can use ${RENDERABLE_TOKENS.map((token) => `{{${token}}}`).join(', ')}, or {{var.name}} for a value an earlier block recorded.`;
}

/**
 * Whether a field's value is authored copy whose tokens get expanded.
 *
 * Lives here rather than in the executor because the validator asks the same
 * question at save time, and two copies of it would eventually disagree — the
 * dangerous direction being a validator that fails *open*, letting copy through
 * unchecked to fail in front of a member. A type guard, so callers keep the
 * narrowed arm and can read `maxLength` off it.
 */
export function isCopyField(
    field: BlockConfigField
): field is Extract<BlockConfigField, { control: 'text' | 'longText' }> {
    return (field.control === 'text' || field.control === 'longText') && field.rendersTokens === true;
}

/**
 * Whether a token an author typed is one this engine could ever fill in.
 *
 * Save-time validation's half of the vocabulary, kept here so the renderer and
 * the validator cannot come to disagree about what a valid token is.
 *
 * **`{{var.<name>}}` is accepted by name alone.** Blocks do not declare typed
 * outputs yet, so there is nothing to check a variable name against — accepting
 * any of them is the honest answer rather than a guess. Once outputs are real,
 * this is the place that tightens: a variable no reachable upstream block
 * produces becomes a save-time error naming the node, exactly as an unknown
 * token is now.
 */
export function isRenderableToken(token: string): boolean {
    return variableNameOf(token) !== undefined || isDeclaredToken(token);
}

/**
 * Every token appearing in one authored string, in the order written.
 *
 * Shared with save-time validation so that what the validator inspects is
 * literally what the renderer will later try to expand — two separate scanners
 * would eventually disagree about whitespace or nesting, and the validator would
 * then pass copy that fails at runtime in front of a member.
 */
export function tokensIn(template: string): string[] {
    return [...template.matchAll(TOKEN_PATTERN)].map((match) => (match[1] ?? '').trim());
}
