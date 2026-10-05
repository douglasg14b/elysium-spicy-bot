import {
    PICKER_VALUE_KINDS,
    isFieldVisible,
    type BlockConfigColumn,
    type BlockConfigField,
    type FlowContextRequirement,
    type VariablePickerControl,
} from '../blocks/manifest';
import type { FlowRunSeed, FlowVariableValue } from '../blocks/types';
import { formatElapsed } from '../../../utils/formatElapsed';

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
    'subject.displayName',
    'subject.id',
    'subject.accountAge',
    'subject.avatarUrl',
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
 * is a *runtime* absence (a resumed run has no actor, a run about nobody has no
 * subject) rather than an authoring mistake, and is reported differently from an
 * unknown token.
 */
const RESOLVERS: Readonly<Record<RenderableToken, TokenResolver>> = {
    'subject.mention': (context) => context.subject?.toString(),
    'subject.username': (context) => context.subject?.user.username,
    // discord.js's own fallback chain: server nickname, then global display
    // name, then username. What the member list shows them as.
    'subject.displayName': (context) => context.subject?.displayName,
    'subject.id': (context) => context.subject?.id,
    // Read at render time, not when the run started: after a three-day wait the
    // account is three days older, and the copy should say so.
    'subject.accountAge': (context) =>
        context.subject ? formatElapsed(Date.now() - context.subject.user.createdTimestamp) : undefined,
    // Their server avatar if they set one, else their account avatar, else
    // Discord's default. Never empty, so it is always safe to send as an image.
    'subject.avatarUrl': (context) => context.subject?.displayAvatarURL(),
    'actor.mention': (context) => context.actor?.toString(),
    'guild.name': (context) => context.guild.name,
};

/**
 * What each token needs the run to carry, or `null` for one every run can fill in.
 *
 * Keyed by {@link RenderableToken}, beside {@link RESOLVERS}, so a token added without
 * deciding its requirement is a compile error rather than one save-time validation and
 * the executor silently treat as free. Declared rather than read off the namespace
 * prefix, because the prefix is spelling: `guild.name` would have to be special-cased.
 *
 * A token's requirement joins the node's effective requirements wherever it is used in
 * visible copy (`engine/nodeRequirements.ts`), so `{{subject.mention}}` on a path about
 * nobody, or `{{actor.mention}}` after a park, is refused at save rather than failing
 * the run that reaches it. Mirrored in `web/src/flows/builtinTokens.ts`.
 */
export const TOKEN_REQUIREMENTS: Readonly<Record<RenderableToken, FlowContextRequirement | null>> = {
    'subject.mention': 'subject',
    'subject.username': 'subject',
    'subject.displayName': 'subject',
    'subject.id': 'subject',
    'subject.accountAge': 'subject',
    'subject.avatarUrl': 'subject',
    'actor.mention': 'actor',
    'guild.name': null,
};

/**
 * The requirement of a built-in token, `null` for one needing nothing, or `undefined`
 * for anything that is not a built-in token — a `{{var.…}}`, or a typo that
 * save-time validation reports separately.
 */
export function tokenRequirement(token: string): FlowContextRequirement | null | undefined {
    return isDeclaredToken(token) ? TOKEN_REQUIREMENTS[token] : undefined;
}

/**
 * Why a built-in token rendered nothing, worded for what the run is missing.
 *
 * One sentence per cause, because the fix differs: an actor lost by waiting means the
 * block moves before the wait, and an actor the trigger never named means the path
 * starts from a trigger where someone acts — `leg` says which; a subject was never
 * there, because the trigger starts runs about nobody, so the token goes or the path
 * starts elsewhere.
 *
 * A backstop inside the executor: its requirement check runs first, over the same
 * visible copy, and fails the step by name before rendering. This is what a caller
 * rendering copy outside the executor sees.
 */
function absentTokenMessage(fieldLabel: string, token: RenderableToken, leg: RunLeg): string {
    const requirement = TOKEN_REQUIREMENTS[token];
    switch (requirement) {
        case 'actor':
            return leg === 'resumed'
                ? `${fieldLabel} uses {{${token}}}, but nobody caused this step — the run was woken after a ` +
                      'wait, with nobody acting on it. Move this block before the wait.'
                : `${fieldLabel} uses {{${token}}}, but nobody caused this step — this run's trigger doesn't ` +
                      'say who caused it. Start this path from a trigger where someone acts.';
        case 'subject':
            return (
                `${fieldLabel} uses {{${token}}}, but this run is about nobody — its trigger supplies no ` +
                'member. Remove the token, or start this path from a trigger about a member.'
            );
        case 'channel':
        case 'interaction':
        case null:
            return `${fieldLabel} uses {{${token}}}, but this run has nothing to fill it in with.`;
        default: {
            const illegal: never = requirement;
            throw new Error(`Unknown token requirement ${JSON.stringify(illegal)}.`);
        }
    }
}

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

/**
 * Where the run being rendered or checked came from: woken from a park on this leg, or
 * started by its trigger. Decides how an absent actor is explained — the two causes send
 * an author to different fixes.
 */
export type RunLeg = 'resumed' | 'started';

export interface RenderCopyOptions {
    /** The run the tokens are resolved against. */
    readonly context: FlowRunSeed;
    /**
     * Which leg of the run this is, so a missing actor is blamed on the right thing.
     * Absent reads as `started`.
     */
    readonly leg?: RunLeg;
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
            failure = absentTokenMessage(fieldLabel, token, options.leg ?? 'started');
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
 * The copy-bearing columns of an `objectList` field, or nothing.
 *
 * The second half of {@link isCopyField}, kept beside it for the same reason it
 * exists at all: a field whose copy lives one level down — inside the entries of
 * a list — is still copy, and the executor and the save-time validator must agree
 * about which strings those are. Returning the columns rather than a boolean lets
 * both callers read each column's own `maxLength` and `label` off what they get.
 *
 * Separate from `isCopyField` rather than folded into it because the two narrow to
 * different things: one says "this key holds a string to expand", the other says
 * "this key holds a list of records, some of whose keys hold strings to expand".
 * A single predicate returning both would leave every caller re-deciding which
 * shape it had been handed.
 */
export function copyColumnsOf(field: BlockConfigField): readonly BlockConfigColumn[] {
    if (field.control !== 'objectList') {
        return [];
    }
    return field.columns.filter((column) => column.rendersTokens === true);
}

/** One authored string a node's tokens are expanded in, and where an author finds it. */
export interface CopyString {
    /** The field holding it — the copy field itself, or the `objectList` it sits inside. */
    readonly field: BlockConfigField;
    /**
     * Where it is, as the author reads it: `"Message"`, or `"Fields" Text on entry 2` —
     * one-based, because the form numbers rows from one.
     */
    readonly where: string;
    readonly value: string;
}

/**
 * Every string on a node whose tokens the engine would expand: its visible copy fields
 * ({@link isCopyField}) and the copy columns ({@link copyColumnsOf}) of its visible lists.
 *
 * The one walk save-time validation reads copy through — for unknown tokens, and for
 * what the tokens a node uses need from the run — so neither reader can skip a hidden
 * field the other honours, or miss the copy one level down that the other finds. Hidden
 * fields are skipped because the executor neither renders nor hands them to `run`.
 */
export function visibleCopyStrings(
    fields: readonly BlockConfigField[],
    nodeData: Readonly<Record<string, unknown>>
): readonly CopyString[] {
    const strings: CopyString[] = [];
    for (const field of fields) {
        if (!isFieldVisible(field, fields, nodeData)) {
            continue;
        }

        if (isCopyField(field)) {
            const value = nodeData[field.key];
            if (typeof value === 'string') {
                strings.push({ field, where: `"${field.label}"`, value });
            }
            continue;
        }

        const columns = copyColumnsOf(field);
        const entries = nodeData[field.key];
        if (columns.length === 0 || !Array.isArray(entries)) {
            continue;
        }
        for (const [index, entry] of entries.entries()) {
            if (entry === null || typeof entry !== 'object') {
                continue;
            }
            const row = entry as Record<string, unknown>;
            for (const column of columns) {
                const value = row[column.key];
                if (typeof value === 'string') {
                    strings.push({
                        field,
                        where: `"${field.label}" ${column.label} on entry ${index + 1}`,
                        value,
                    });
                }
            }
        }
    }
    return strings;
}

/**
 * Whether a field is a picker that may name a value an earlier block recorded in
 * place of a fixed choice.
 *
 * A picker is not copy: it takes **one** `{{var.<name>}}` and nothing around it,
 * because a channel id with a word in front of it is not a channel. Kept beside
 * {@link isCopyField} so the executor and save-time validation ask the same
 * question about the same fields.
 */
export function isVariablePickerField(
    field: BlockConfigField
): field is Extract<BlockConfigField, { control: VariablePickerControl }> {
    return Object.hasOwn(PICKER_VALUE_KINDS, field.control);
}

/**
 * The `<name>` when a picker's value is exactly `{{var.<name>}}`, else undefined.
 *
 * Anchored at both ends, so `#{{var.x}}` or two tokens side by side are refused
 * rather than half-read.
 */
export function pickerVariableOf(value: string): string | undefined {
    const tokens = tokensIn(value);
    // Exactly one token, and nothing but that token once whitespace is set aside.
    if (tokens.length !== 1 || value.replace(TOKEN_PATTERN, '').trim() !== '') {
        return undefined;
    }
    return variableNameOf(tokens[0] ?? '');
}

/**
 * Resolve a picker's `{{var.<name>}}` to the id it stands for.
 *
 * Stricter than {@link renderCopy} in one way that matters: an empty value fails.
 * Copy may render a `null` variable as nothing; a picker handed nothing would ask
 * Discord for channel `''` and fail with an error naming neither the field nor the
 * block that was meant to supply it.
 */
export function resolvePickerVariable(
    value: string,
    options: Pick<RenderCopyOptions, 'context' | 'fieldLabel'>
): CopyRenderResult {
    const { context, fieldLabel } = options;
    const name = pickerVariableOf(value);
    if (name === undefined) {
        return {
            ok: false,
            error: `${fieldLabel} holds "${value}". A picker takes a choice, or one {{var.name}} from an earlier block and nothing else.`,
        };
    }

    // `hasOwn` for the reason `renderCopy` gives: the prototype is not a value.
    // Three failures, told apart because each sends the author somewhere different.
    if (!Object.hasOwn(context.variables, name)) {
        return {
            ok: false,
            error:
                `${fieldLabel} uses {{var.${name}}}, but nothing has recorded it by the time this block runs. ` +
                'Check the block that produces it runs first on this path — a condition only records what it found on the branch where it found it.',
        };
    }

    const variableValue = context.variables[name];
    if (variableValue === null || variableValue === '') {
        return {
            ok: false,
            error:
                `${fieldLabel} uses {{var.${name}}}, which was recorded empty this run — ` +
                'the block that sets it found nothing to point at, such as a ticket whose channel has been deleted.',
        };
    }
    if (typeof variableValue !== 'string') {
        return {
            ok: false,
            error: `${fieldLabel} uses {{var.${name}}}, which holds ${String(variableValue)} — not something this picker can use.`,
        };
    }

    return { ok: true, text: variableValue };
}

/**
 * Whether a token an author typed is one this engine could ever fill in.
 *
 * Save-time validation's half of the vocabulary, kept here so the renderer and
 * the validator cannot come to disagree about what a valid token is.
 *
 * **`{{var.<name>}}` is accepted by name alone**, and this function is the wrong
 * place to tighten that even now that it could be. Declared `outputs` did become
 * a vocabulary of produced names — `resolveOutputName` in `blocks/manifest.ts`
 * resolves either naming against a node — but a name is only produced *relative
 * to a node's ancestry*, and this takes one token and no graph. The check belongs
 * in `graphValidation.ts`'s `checkCopyTokens`, which walks nodes; see the note
 * there for what still has to be decided before it can refuse a save.
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
