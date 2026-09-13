import { z, type ZodType } from 'zod';
import { FLOW_STEP_OUTCOME_KINDS } from '../engine/stepOutcome';
import {
    BLOCK_CAPABILITIES,
    BLOCK_CONTROL_TYPES,
    BLOCK_HANDLE_TONES,
    BLOCK_KINDS,
    BLOCK_PALETTE_GROUPS,
    FLOW_CONTEXT_REQUIREMENTS,
    type BlockConfigField,
    type BlockConfigOption,
    type BlockControlType,
    type BlockManifest,
    type BlockOutputHandle,
} from './manifest';
import { FLOW_RESUME_REASONS, type FlowRunContext } from './types';

/**
 * Does a block actually satisfy the contract it claims to?
 *
 * This is what makes a later contract change affordable: extend the manifest and
 * every block that has not caught up fails here by name, instead of failing in
 * production on the one graph that used it. It is also why a manifest can be
 * trusted by the builder — a declared field with no schema behind it, or a
 * default the schema would reject, is a test failure rather than a form that
 * saves garbage.
 *
 * {@link checkBlockConformance} runs over every registered block, so a manifest
 * that drifts from its own schema fails in one place for the whole registry.
 *
 * Deliberately split in two. {@link checkBlockConformance} needs nothing but the
 * manifest and so can run over every registered block. {@link checkBlockOutcome}
 * has to actually run the block, which needs a config and a context only the
 * block's own test can supply.
 */

/** Names of every manifest member that must be present, with the shape expected. */
const REQUIRED_PRIMITIVES = {
    type: 'string',
    kind: 'string',
    label: 'string',
    description: 'string',
    group: 'string',
    icon: 'string',
    canSuspend: 'boolean',
    run: 'function',
} as const satisfies Record<string, 'string' | 'boolean' | 'function'>;

const REQUIRED_ARRAYS = [
    'configFields',
    'handles',
    'outputs',
    'requires',
    'capabilities',
] as const;

/**
 * Check everything about a block that can be checked from its declaration alone.
 *
 * Takes `unknown` rather than a `BlockManifest` on purpose: the interesting
 * inputs are the ones that do not satisfy the type, and a suite that could only
 * be handed well-formed manifests would prove nothing.
 *
 * Returns one message per problem, most specific first, or an empty array.
 */
export function checkBlockConformance(candidate: unknown): readonly string[] {
    if (!candidate || typeof candidate !== 'object') {
        return ['A block must be an object declaring a manifest.'];
    }

    const block = candidate as Partial<Record<string, unknown>>;
    const label = typeof block.type === 'string' && block.type ? block.type : '<no type>';
    const issues: string[] = [];
    const missing = (field: string, detail: string): void => {
        issues.push(`${label}: ${field} ${detail}`);
    };

    for (const [field, expected] of Object.entries(REQUIRED_PRIMITIVES)) {
        const value = block[field];
        if (typeof value !== expected || (expected === 'string' && !value)) {
            const wanted = expected === 'string' ? 'a non-empty string' : `a ${expected}`;
            missing(field, `must be ${wanted}, found ${JSON.stringify(value) ?? typeof value}`);
        }
    }

    for (const field of REQUIRED_ARRAYS) {
        if (!Array.isArray(block[field])) {
            missing(field, 'must be an array, even when empty');
        }
    }

    if (!isZodType(block.configSchema)) {
        missing('configSchema', 'must be a Zod schema — it is the authority on node data');
    }

    issues.push(...checkOptionalProse(label, 'note', block.note));
    issues.push(...checkVocabulary(label, block));
    issues.push(...checkHandles(label, block.handles));
    issues.push(...checkConfigFields(label, block.configFields, block.configSchema));

    return issues;
}

/**
 * An optional string member is either absent or says something.
 *
 * Present-but-empty is the failure worth naming: it reads as "declared" to every
 * reader and renders as a blank line in the builder, which is the one outcome
 * neither omitting it nor writing it would have produced.
 */
function checkOptionalProse(label: string, field: string, value: unknown): readonly string[] {
    if (value === undefined) {
        return [];
    }

    if (typeof value !== 'string' || !value.trim()) {
        return [
            `${label}: ${field} must be a non-empty string when declared, found ` +
                `${JSON.stringify(value)}. Omit it rather than declaring it empty.`,
        ];
    }

    return [];
}

/** Every closed vocabulary the manifest draws on, checked in one pass. */
function checkVocabulary(label: string, block: Partial<Record<string, unknown>>): readonly string[] {
    const issues: string[] = [];
    const member = (field: string, value: unknown, allowed: readonly string[]): void => {
        if (typeof value === 'string' && !allowed.includes(value)) {
            issues.push(
                `${label}: ${field} "${value}" is not in the vocabulary (${allowed.join(', ')}). ` +
                    'Extend the vocabulary for everyone rather than special-casing this block.'
            );
        }
    };

    member('kind', block.kind, BLOCK_KINDS);
    member('group', block.group, BLOCK_PALETTE_GROUPS);

    for (const requirement of asArray(block.requires)) {
        member('requires', requirement, FLOW_CONTEXT_REQUIREMENTS);
    }
    for (const capability of asArray(block.capabilities)) {
        member('capabilities', capability, BLOCK_CAPABILITIES);
    }
    for (const field of asArray(block.configFields)) {
        member('configFields.control', readProperty(field, 'control'), BLOCK_CONTROL_TYPES);
    }
    for (const handle of asArray(block.handles)) {
        member('handles.tone', readProperty(handle, 'tone'), BLOCK_HANDLE_TONES);
    }

    return issues;
}

/**
 * A block must declare how a run leaves it, exactly once per exit.
 *
 * The default (unnamed) handle is the one the persisted graph stores as an edge
 * with no `sourceHandle`, so two of those would be two edges the executor could
 * not tell apart — the silent first-match this milestone exists to remove.
 */
function checkHandles(label: string, handles: unknown): readonly string[] {
    if (!Array.isArray(handles)) {
        return [];
    }

    const issues: string[] = [];
    if (handles.length === 0) {
        issues.push(
            `${label}: declares no output handles, so a run could never leave it. ` +
                'A block that ends a path still declares its exit — the author ends the path by wiring nothing to it.'
        );
    }

    const seen = new Set<string>();
    for (const handle of handles as readonly Partial<BlockOutputHandle>[]) {
        const id = handle.id ?? '';
        if (seen.has(id)) {
            issues.push(
                id
                    ? `${label}: declares the output handle "${id}" twice.`
                    : `${label}: declares more than one default output handle, which no edge could distinguish.`
            );
        }
        seen.add(id);

        if (typeof handle.label !== 'string' || !handle.label) {
            issues.push(`${label}: output handle ${id || '<default>'} needs a label the builder can draw.`);
        }
    }

    return issues;
}

/**
 * The declared form and the validating schema must describe the same config.
 *
 * Checked in both directions. A declared field with no schema key means the form
 * writes data nothing validates; a schema key with no declared field means a
 * required value the form gives no way to set, which is a block that can only
 * ever be saved broken.
 */
function checkConfigFields(label: string, configFields: unknown, configSchema: unknown): readonly string[] {
    if (!Array.isArray(configFields) || !isZodType(configSchema)) {
        return [];
    }

    const shape = objectShape(configSchema);
    if (!shape) {
        return [
            `${label}: configSchema must be an object schema, because node data is a record of fields.`,
        ];
    }

    const issues: string[] = [];
    const fields = configFields as readonly Partial<BlockConfigField>[];
    const declared = new Set<string>();

    for (const field of fields) {
        const { key } = field;
        if (typeof key !== 'string' || !key) {
            issues.push(`${label}: a config field has no key.`);
            continue;
        }
        if (declared.has(key)) {
            issues.push(`${label}: declares the config field "${key}" twice.`);
        }
        declared.add(key);

        const fieldSchema = shape[key];
        if (!fieldSchema) {
            issues.push(
                `${label}: declares the config field "${key}", which its configSchema does not validate.`
            );
            continue;
        }

        issues.push(...checkFieldDefault(label, key, field.defaultValue, fieldSchema));
        issues.push(...checkFieldChoices(label, key, field, fieldSchema));
        issues.push(...checkFieldMaxLength(label, key, field, fieldSchema));
    }

    for (const key of Object.keys(shape)) {
        if (!declared.has(key)) {
            issues.push(
                `${label}: its configSchema validates "${key}", but no config field lets an author set it.`
            );
        }
    }

    return issues;
}

/**
 * The controls whose whole purpose is to offer a fixed set of choices.
 *
 * Constrained to the control vocabulary so renaming a control there fails here
 * rather than silently leaving this check looking for a name nothing uses.
 */
const CHOICE_CONTROLS = ['segmented', 'select'] as const satisfies readonly BlockControlType[];

/**
 * A control that offers choices must offer some, and every one must be a value
 * the schema will accept.
 *
 * The type already requires `options` on these controls, but conformance takes
 * `unknown` — which is the point, since the manifests worth checking are the ones
 * that do not satisfy the type. Both halves have a failure the builder cannot
 * show: no options renders an empty dropdown, so a required key can never be set;
 * an option the schema rejects is worse, because the author picks a value the form
 * offered and the save fails server-side naming it.
 *
 * A chosen value is always a string, because the builder reads it from a form
 * control. A choice field over a numeric schema is therefore reported as a
 * mismatched schema rather than as eight rejected options, since coercion is the
 * fix and the options are not what is wrong.
 */
function checkFieldChoices(
    label: string,
    key: string,
    field: Partial<BlockConfigField>,
    fieldSchema: ZodType
): readonly string[] {
    const choiceControls: readonly string[] = CHOICE_CONTROLS;
    if (typeof field.control !== 'string' || !choiceControls.includes(field.control)) {
        return [];
    }

    const options = 'options' in field ? field.options : undefined;
    if (!Array.isArray(options) || options.length === 0) {
        return [
            `${label}: the ${field.control} field "${key}" offers no options, so the builder would ` +
                'draw an empty control and an author could never set the key.',
        ];
    }

    const issues: string[] = [];
    const declaredValues: string[] = [];

    for (const option of options as readonly Partial<BlockConfigOption>[]) {
        if (typeof option?.value !== 'string' || !option.value) {
            issues.push(`${label}: an option on the field "${key}" has no value.`);
            continue;
        }
        if (!option.label) {
            issues.push(`${label}: the option "${option.value}" on "${key}" needs a label.`);
        }
        declaredValues.push(option.value);
    }

    const rejected = declaredValues.filter((value) => !fieldSchema.safeParse(value).success);

    // A schema that rejects every option *and* rejects strings on principle is a
    // schema-shape problem, not eight bad options: reporting it per option would
    // send an author editing correct lines. Probed with a sentinel no sane
    // vocabulary contains, so an enum that simply lacks these options still gets
    // the per-option message below.
    if (rejected.length === declaredValues.length && !acceptsAnyString(fieldSchema)) {
        return [
            ...issues,
            `${label}: the ${field.control} field "${key}" offers string values but its configSchema ` +
                'does not accept strings at all. A choice control reads its value from a form, so the ' +
                'schema has to take one — use z.enum([...]) for a fixed set, or z.coerce.number() for a ' +
                'numeric one.',
        ];
    }

    for (const value of rejected) {
        const parsed = fieldSchema.safeParse(value);
        issues.push(
            `${label}: the field "${key}" offers ${JSON.stringify(value)}, which its ` +
                'configSchema rejects, so choosing it in the builder would fail to save: ' +
                (parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join(', '))
        );
    }

    return issues;
}

/**
 * A declared `maxLength` must be the limit the schema actually enforces.
 *
 * These are two statements of one number: the browser stops typing at
 * `maxLength`, and the schema rejects the save past `.max()`. Drift either way is
 * a bad experience the author cannot diagnose — a form that refuses a length the
 * server would have taken, or one that invites a length the server then rejects
 * with a validation error naming a limit the control never showed.
 *
 * Probed at the boundary rather than by reading Zod's internals, which keeps this
 * working across `.min()`/`.trim()`/`.optional()` wrappers: a string of exactly
 * `maxLength` must pass, and one character more must not. The probe character is
 * load-bearing — `'a'` is non-whitespace, so a `.trim()` in the chain cannot
 * shorten the probe out from under the comparison the way `' '` would.
 *
 * Only asked of schemas that take arbitrary strings. A schema constraining
 * *format* rejects the probe on its pattern rather than its length, and an enum
 * accepts only its own members, so in both cases the boundary says nothing about
 * a length limit and would report a correct `maxLength` as wrong.
 */
function checkFieldMaxLength(
    label: string,
    key: string,
    field: Partial<BlockConfigField>,
    fieldSchema: ZodType
): readonly string[] {
    const maxLength = 'maxLength' in field ? field.maxLength : undefined;
    if (maxLength === undefined) {
        return [];
    }

    // Reported rather than thrown: `String.repeat` rejects a negative or
    // non-finite count, and this suite takes `unknown` precisely so a manifest
    // that does not satisfy the type reaches it. Throwing here would abort the
    // whole registry sweep inside `String.repeat`, losing every other block's
    // issues to a stack trace instead of naming this one.
    if (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength < 1) {
        return [
            `${label}: the field "${key}" declares maxLength ${JSON.stringify(maxLength)}, which is not ` +
                'a positive whole number of characters.',
        ];
    }

    // A format or enum constraint makes the boundary meaningless — see above.
    // `acceptsAnyString` is the wrong probe here: it unwraps to the base type, so
    // a `.regex()`-constrained string still reports as string-bearing. What
    // matters is whether *this* probe shape is acceptable at all, which a single
    // short run of the probe character answers.
    if (!fieldSchema.safeParse('a').success) {
        return [];
    }

    const issues: string[] = [];

    if (!fieldSchema.safeParse('a'.repeat(maxLength)).success) {
        issues.push(
            `${label}: the field "${key}" declares maxLength ${maxLength}, but its configSchema rejects ` +
                'a value of exactly that length. The control would allow a length the save then refuses.'
        );
    }

    if (fieldSchema.safeParse('a'.repeat(maxLength + 1)).success) {
        issues.push(
            `${label}: the field "${key}" declares maxLength ${maxLength}, but its configSchema accepts ` +
                'a longer value. The control would stop an author short of what the schema allows.'
        );
    }

    return issues;
}

/**
 * A field's starting value must be one the schema accepts — and must agree with
 * the schema's own default where it has one.
 *
 * Two declarations of one default that disagree is the drift this contract
 * exists to prevent: the form would seed one value and the server would store
 * another.
 */
function checkFieldDefault(
    label: string,
    key: string,
    declaredDefault: unknown,
    fieldSchema: ZodType
): readonly string[] {
    const issues: string[] = [];

    if (declaredDefault !== undefined) {
        const parsed = fieldSchema.safeParse(declaredDefault);
        if (!parsed.success) {
            issues.push(
                `${label}: the default for "${key}" (${JSON.stringify(declaredDefault)}) is not valid: ` +
                    parsed.error.issues.map((issue) => issue.message).join(', ')
            );
        }
    }

    // Parsing `undefined` is how a schema reveals its own default without
    // reaching into Zod's internals. It cannot distinguish "no default" from an
    // explicit `.default(undefined)`, which is a distinction without a
    // consequence here: both leave the builder with no value to seed.
    const withoutValue = fieldSchema.safeParse(undefined);
    const schemaDefault = withoutValue.success ? withoutValue.data : undefined;
    if (schemaDefault === undefined) {
        return issues;
    }

    if (declaredDefault === undefined) {
        issues.push(
            `${label}: its configSchema defaults "${key}" to ${JSON.stringify(schemaDefault)}, but the ` +
                'config field declares no default, so the builder would leave the key unset.'
        );
        // Compared structurally: Zod hands back a fresh object for an array or
        // object default, so reference equality would report two identical
        // values as disagreeing while printing the same JSON for both.
    } else if (JSON.stringify(declaredDefault) !== JSON.stringify(schemaDefault)) {
        issues.push(
            `${label}: the default for "${key}" disagrees with its configSchema — field says ` +
                `${JSON.stringify(declaredDefault)}, schema says ${JSON.stringify(schemaDefault)}.`
        );
    }

    return issues;
}

/**
 * Drive a block through its entry point and check what it hands back.
 *
 * Separate from {@link checkBlockConformance} because it needs a config and a
 * context: what a block does with them is its own test's business, but *that it
 * returns a declared outcome, leaving by a handle it declared* is the contract's.
 */
export async function checkBlockOutcome(
    block: BlockManifest,
    config: unknown,
    context: FlowRunContext
): Promise<readonly string[]> {
    const outcome: unknown = await block.run(config, context);

    if (!outcome || typeof outcome !== 'object') {
        return [`${block.type}: run returned ${JSON.stringify(outcome)}, not a step outcome.`];
    }

    const { kind } = outcome as { kind?: unknown };
    const outcomeKinds: readonly string[] = FLOW_STEP_OUTCOME_KINDS;
    if (typeof kind !== 'string' || !outcomeKinds.includes(kind)) {
        return [
            `${block.type}: run returned the outcome kind ${JSON.stringify(kind)}, which is not one of ` +
                `${FLOW_STEP_OUTCOME_KINDS.join(', ')}.`,
        ];
    }

    const issues: string[] = [];

    if (kind === 'suspend' && !block.canSuspend) {
        issues.push(`${block.type}: parked a run while declaring canSuspend: false.`);
    }

    if (kind === 'continue') {
        const { handle } = outcome as { handle?: unknown };
        if (!block.handles.some((declared) => declared.id === handle)) {
            issues.push(
                `${block.type}: continued by the handle ${JSON.stringify(handle)}, which it never declared. ` +
                    'The builder draws only declared handles, so that edge could not exist on the canvas.'
            );
        }
    }

    issues.push(...(await checkResumeTerminates(block, config, context)));

    return issues;
}

/**
 * A block that parks must come back when it is woken.
 *
 * The one way to write a suspending block that is catastrophically wrong and
 * silent about it: forget to check `context.resume`, and every run that reaches
 * the block parks, wakes, parks again, forever. Nothing downstream notices,
 * because parking is exactly what the block is supposed to do.
 *
 * So drive it: park it, then hand it back each resume reason and require it
 * stop asking. Only asked of blocks that declare `canSuspend`.
 */
async function checkResumeTerminates(
    block: BlockManifest,
    config: unknown,
    context: FlowRunContext
): Promise<readonly string[]> {
    if (!block.canSuspend) {
        return [];
    }

    const issues: string[] = [];

    for (const reason of FLOW_RESUME_REASONS) {
        const resumed: unknown = await block.run(config, { ...context, resume: reason });
        const kind = (resumed as { kind?: unknown } | null)?.kind;

        if (kind === 'suspend') {
            issues.push(
                `${block.type}: parked again when resumed with reason "${reason}" instead of carrying on. ` +
                    'A suspending block must check `context.resume` before returning a suspension, or every ' +
                    'run that reaches it parks forever.'
            );
        }
    }

    return issues;
}

function isZodType(value: unknown): value is ZodType {
    return value instanceof z.ZodType;
}

/**
 * Could a string ever satisfy this schema?
 *
 * Separates "your dropdown offers a value outside the enum" — an options problem —
 * from "this schema is numeric, so no dropdown value could satisfy it", a schema
 * problem fixed in a different line of the file. Both get accurate messages either
 * way; this only decides which hint is worth printing.
 *
 * An enum rejects every arbitrary string while accepting its own members, so
 * sampling values cannot answer this. Unwrapping to the base type can: only the
 * string-bearing base types are ever satisfiable from a form control. `z.coerce`
 * is the exception — it reports a numeric base but accepts numeric strings — so a
 * successful parse is treated as authoritative first.
 */
function acceptsAnyString(schema: ZodType): boolean {
    // Coercing schemas look numeric but take strings; trust a real parse over the
    // declared type.
    if (schema.safeParse('1').success) {
        return true;
    }

    return STRING_BEARING_TYPES.includes(baseTypeName(schema));
}

/** Base types whose accepted values are strings. */
const STRING_BEARING_TYPES: readonly string[] = ['string', 'enum', 'literal', 'template_literal'];

/**
 * Name of the type underneath any `.optional()` / `.default()` / `.nullable()`
 * wrappers, which each carry their own type tag.
 */
function baseTypeName(schema: ZodType): string {
    let current: unknown = schema;

    // Bounded by the wrapper depth an author could plausibly write, so a
    // hypothetical self-referential def cannot spin here.
    for (let depth = 0; depth < 10; depth += 1) {
        const def = readProperty(readProperty(current, '_zod'), 'def');
        const inner = readProperty(def, 'innerType');
        if (!inner) {
            const type = readProperty(def, 'type');
            return typeof type === 'string' ? type : 'unknown';
        }
        current = inner;
    }

    return 'unknown';
}

/** A Zod object schema's field map, or null when the schema is not an object. */
function objectShape(schema: ZodType): Record<string, ZodType> | null {
    return schema instanceof z.ZodObject ? (schema.shape as Record<string, ZodType>) : null;
}

function asArray(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
}

function readProperty(value: unknown, key: string): unknown {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
