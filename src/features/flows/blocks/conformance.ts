import { z, type ZodType } from 'zod';
import { ELIGIBILITY_CONFIG_KEY, ELIGIBILITY_ENFORCED_SOURCES } from '../engine/eligibility';
import { FLOW_STEP_OUTCOME_KINDS } from '../engine/stepOutcome';
import {
    BLOCK_CAPABILITIES,
    BLOCK_COLUMN_CONTROLS,
    BLOCK_CONTROL_TYPES,
    BLOCK_HANDLE_TONES,
    BLOCK_KINDS,
    BLOCK_PALETTE_GROUPS,
    FLOW_CONTEXT_REQUIREMENTS,
    type BlockConfigColumn,
    type BlockConfigField,
    type BlockConfigOption,
    type BlockControlType,
    type BlockManifest,
    type BlockOutputHandle,
} from './manifest';
import type { FlowResumeKind, FlowResumeReason, FlowRunContext } from './types';

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
    issues.push(...checkOutputs(label, block.outputs, block.configFields));
    issues.push(...checkConfigFields(label, block.configFields, block.configSchema));
    issues.push(...checkCardSummary(label, block.cardSummary, block.configFields));
    issues.push(...checkEligibilityEnforced(label, block));

    return issues;
}

/**
 * A block may only offer an eligibility rule where something enforces one.
 *
 * The one check here about a block's relationship to the *engine* rather than to
 * its own schema, and it earns that: a rule is a permission control, and a
 * permission control nothing reads is worse than none at all. It saves, it draws
 * a padlock on the card, and it admits everybody — silent at every layer a person
 * would think to look.
 *
 * **Only triggers are asked**, and the asymmetry is forced rather than lazy. A
 * trigger's enforcement follows from `startedBy`, which is declared data this
 * function already holds. An action's follows from whether some dispatcher reads
 * its rule — a fact about code, in no manifest — so the only way to check one
 * would be a list of block types here, which `blockTypeBranching` rejects as a
 * second copy of the catalogue. See the note beside
 * `ELIGIBILITY_ENFORCED_SOURCES` for what that leaves uncovered.
 */
function checkEligibilityEnforced(
    label: string,
    block: Partial<Record<string, unknown>>
): readonly string[] {
    // Named `offersEligibility`, not `declaresRule`. `rule` stems to `rules`,
    // which is a proven rejection in `engineVocabulary.test.ts` — an onboarding
    // noun — so recognising it would blind that gate to the leak it exists to
    // catch. Renaming is the documented response, not widening the list.
    const offersEligibility = asArray(block.configFields).some(
        (field) => readProperty(field, 'key') === ELIGIBILITY_CONFIG_KEY
    );
    if (!offersEligibility || block.kind !== 'trigger') {
        return [];
    }

    const enforced: readonly string[] = ELIGIBILITY_ENFORCED_SOURCES;
    const startedBy = typeof block.startedBy === 'string' ? block.startedBy : '<none>';
    if (enforced.includes(startedBy)) {
        return [];
    }

    return [
        `${label}: declares an "${ELIGIBILITY_CONFIG_KEY}" field, but nothing checks one for a ` +
            `"${startedBy}" trigger (only ${enforced.join(', ')}). An authored rule would save, show on ` +
            "the card, and admit everybody. Wire that source's dispatcher and add it to " +
            'ELIGIBILITY_ENFORCED_SOURCES, or drop the field.',
    ];
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
 * Every declared output must name something that can actually be resolved.
 *
 * The check the discriminator exists to make possible. An `authored` output whose
 * `fromField` names no config field resolves to nothing on every node forever —
 * the builder would offer the author no variable, silently, and the block would
 * look like it produced none. That is precisely the failure that is invisible at
 * run time, because `setOutput` writes whatever the block passes it regardless of
 * what the manifest claims.
 *
 * It cannot check the other direction — that `run` writes what it declares —
 * without executing the block, which {@link checkBlockOutcome} is for. A name
 * agreeing here and disagreeing there is still possible; this rules out the case
 * a rename causes, which is the one that happens.
 */
function checkOutputs(label: string, outputs: unknown, configFields: unknown): readonly string[] {
    if (!Array.isArray(outputs)) {
        return [];
    }

    const declaredKeys = new Set(
        asArray(configFields)
            .map((field) => readProperty(field, 'key'))
            .filter((key): key is string => typeof key === 'string')
    );

    const issues: string[] = [];
    for (const output of outputs) {
        const naming = readProperty(output, 'naming');
        const name = readProperty(output, 'label');
        const outputLabel = typeof name === 'string' && name ? name : '<unlabelled>';

        if (typeof name !== 'string' || !name) {
            issues.push(`${label}: output ${outputLabel} needs a label the builder can show an author.`);
        }

        if (naming === 'fixed') {
            const key = readProperty(output, 'key');
            if (typeof key !== 'string' || !key) {
                issues.push(`${label}: fixed output ${outputLabel} must declare the key it writes.`);
            }
            continue;
        }

        if (naming === 'authored') {
            const fromField = readProperty(output, 'fromField');
            if (typeof fromField !== 'string' || !fromField) {
                issues.push(
                    `${label}: authored output ${outputLabel} must name the config field holding its variable name.`
                );
            } else if (!declaredKeys.has(fromField)) {
                issues.push(
                    `${label}: authored output ${outputLabel} reads its name from "${fromField}", ` +
                        'which is not one of this block\'s config fields — nothing would ever resolve it.'
                );
            }
            continue;
        }

        issues.push(
            `${label}: output ${outputLabel} must declare naming as "fixed" or "authored", found ${JSON.stringify(naming) ?? typeof naming}.`
        );
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
        issues.push(...checkFieldEntryBounds(label, key, field, fieldSchema));
        issues.push(...checkFieldColumns(label, key, field, fieldSchema));
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
 * The canvas card summary must describe fields that actually exist, and each
 * part must be unambiguously a value reference or a literal — never both, and
 * never neither, or the browser has no way to know what to render.
 *
 * `cardSummary` is optional, so an absent one is not a finding: a block with
 * nothing worth summarising (`trigger.memberJoin` aside, which still summarises
 * with a literal) simply leaves the card to fall back to "Click to configure".
 */
function checkCardSummary(label: string, cardSummary: unknown, configFields: unknown): readonly string[] {
    if (cardSummary === undefined) {
        return [];
    }

    if (!Array.isArray(cardSummary)) {
        return [`${label}: cardSummary must be an array of parts when declared.`];
    }

    const declaredKeys = new Set(
        asArray(configFields)
            .map((field) => readProperty(field, 'key'))
            .filter((key): key is string => typeof key === 'string')
    );

    const issues: string[] = [];

    for (const [index, part] of cardSummary.entries()) {
        const where = `cardSummary[${index}]`;
        const key = readProperty(part, 'key');
        const text = readProperty(part, 'text');
        const hasKey = key !== undefined;
        const hasText = text !== undefined;

        if (hasKey === hasText) {
            issues.push(
                `${label}: ${where} must set exactly one of "key" (a field reference) or "text" ` +
                    `(a literal), found ${hasKey ? 'both' : 'neither'}.`
            );
            continue;
        }

        if (hasText) {
            if (typeof text !== 'string' || !text) {
                issues.push(`${label}: ${where}.text must be a non-empty string.`);
            }
            continue;
        }

        if (typeof key !== 'string' || !key) {
            issues.push(`${label}: ${where}.key must be a non-empty string.`);
            continue;
        }

        if (!declaredKeys.has(key)) {
            issues.push(
                `${label}: ${where} references the config field "${key}", which configFields does not declare.`
            );
        }

        const truncate = readProperty(part, 'truncate');
        if (truncate !== undefined && (typeof truncate !== 'number' || !Number.isInteger(truncate) || truncate < 1)) {
            issues.push(
                `${label}: ${where}.truncate must be a positive whole number of characters, found ` +
                    `${JSON.stringify(truncate)}.`
            );
        }

        if (readProperty(part, 'hideWhenEmpty') === true && readProperty(part, 'stopIfEmpty') === true) {
            issues.push(
                `${label}: ${where} sets both hideWhenEmpty and stopIfEmpty — one drops this part, the ` +
                    'other discards the whole summary, and a part cannot mean both at once.'
            );
        }

        if (readProperty(part, 'stopIfEmpty') === true && readProperty(part, 'emptyText') === undefined) {
            issues.push(
                `${label}: ${where} sets stopIfEmpty without emptyText, so the empty case would render ` +
                    'nothing — the whole point of stopping early is to show emptyText in place of the rest.'
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
 *
 * On `textList` the declared limit is a limit on **one entry**, so the probe is
 * wrapped in a list — see the comment at the probe itself for why that is not
 * optional.
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

    /*
     * On a list control the limit is a limit on **one entry**, so the probe has
     * to be a list or it is measuring the wrong shape entirely.
     *
     * This matters more than it looks. The escape immediately below cannot tell
     * "the schema constrains format, so the boundary is meaningless" from "the
     * schema is an array, so a bare string was never going to parse" — both
     * arrive as one failed parse. Probing a list against an array schema is the
     * difference between this function checking the declaration and silently
     * returning nothing while the manifest claims the limit is enforced.
     */
    const probe = (text: string): unknown => (field.control === 'textList' ? [text] : text);

    // A format or enum constraint makes the boundary meaningless — see above.
    // `acceptsAnyString` is the wrong probe here: it unwraps to the base type, so
    // a `.regex()`-constrained string still reports as string-bearing. What
    // matters is whether *this* probe shape is acceptable at all, which a single
    // short run of the probe character answers.
    if (!fieldSchema.safeParse(probe('a')).success) {
        return [];
    }

    const issues: string[] = [];

    if (!fieldSchema.safeParse(probe('a'.repeat(maxLength))).success) {
        issues.push(
            `${label}: the field "${key}" declares maxLength ${maxLength}, but its configSchema rejects ` +
                'a value of exactly that length. The control would allow a length the save then refuses.'
        );
    }

    if (fieldSchema.safeParse(probe('a'.repeat(maxLength + 1))).success) {
        issues.push(
            `${label}: the field "${key}" declares maxLength ${maxLength}, but its configSchema accepts ` +
                'a longer value. The control would stop an author short of what the schema allows.'
        );
    }

    return issues;
}

/**
 * A list control's declared bounds must describe a list an author can reach.
 *
 * `minEntries` is shown as advice under the control and `maxEntries` is where the
 * "add" button stops being offered, so bounds that cross leave a form that asks
 * for more entries than it will ever let anyone add — a dead control, with no
 * disabled affordance to hover and no message saying why.
 *
 * The bounds are checked against **each other and the schema**, in that order:
 * crossed bounds are wrong however the schema is written, whereas a bound
 * disagreeing with the schema is the same drift `checkFieldMaxLength` exists to
 * catch, one level up — a control that stops short of what the save would take,
 * or invites a list the save then refuses.
 */
function checkFieldEntryBounds(
    label: string,
    key: string,
    field: Partial<BlockConfigField>,
    fieldSchema: ZodType
): readonly string[] {
    const minEntries = 'minEntries' in field ? field.minEntries : undefined;
    const maxEntries = 'maxEntries' in field ? field.maxEntries : undefined;
    if (minEntries === undefined && maxEntries === undefined) {
        return [];
    }

    const issues: string[] = [];

    // Reported rather than thrown, for the reason `checkFieldMaxLength` gives:
    // this suite takes `unknown` so a manifest that does not satisfy the type
    // still reaches it, and `Array.from` on a bad length would abort the sweep.
    for (const [name, bound] of [
        ['minEntries', minEntries],
        ['maxEntries', maxEntries],
    ] as const) {
        if (bound !== undefined && (typeof bound !== 'number' || !Number.isInteger(bound) || bound < 0)) {
            issues.push(
                `${label}: the field "${key}" declares ${name} ${JSON.stringify(bound)}, which is not a ` +
                    'whole number of entries.'
            );
        }
    }
    if (issues.length > 0) {
        return issues;
    }

    if (typeof minEntries === 'number' && typeof maxEntries === 'number' && minEntries > maxEntries) {
        return [
            `${label}: the field "${key}" asks for at least ${minEntries} entries but stops offering new ` +
                `ones at ${maxEntries}, so an author could never satisfy it.`,
        ];
    }

    /*
     * One probe entry, shaped for whichever list control this is.
     *
     * An `objectList`'s schema validates *records*, so a list of `'a'` is rejected
     * at every length — which the sweep below would read as "the schema constrains
     * its entries" and fall silent, leaving the bounds unchecked exactly as the
     * bare-string probe once did for `textList`. The entry is built from the
     * declared columns so it satisfies the schema's required keys; a column whose
     * own constraint rejects `'a'` puts this back in the escape the sweep is for,
     * which is the same correct outcome `textList` already has.
     */
    const probeEntry = (): unknown => {
        if (field.control !== 'objectList') {
            return 'a';
        }
        const columns = 'columns' in field && Array.isArray(field.columns) ? field.columns : [];
        const entry: Record<string, unknown> = {};
        for (const column of columns as readonly Partial<BlockConfigColumn>[]) {
            if (typeof column?.key === 'string' && column.key) {
                entry[column.key] = column.control === 'toggle' ? false : 'a';
            }
        }
        return entry;
    };

    const listOf = (count: number): readonly unknown[] => Array.from({ length: count }, probeEntry);

    /*
     * Everything below is about **how many** entries are allowed, so it is only
     * meaningful against a schema that accepts the probe's entries at all.
     *
     * `z.array(z.string().min(2))` and `z.array(z.enum([...]))` both reject every
     * list of `'a'` whatever its length, and calling that "the schema rejects a
     * list that long" would be a false finding against a correct manifest — the
     * worse outcome of the two, because it blocks a block that is right.
     * `checkFieldMaxLength` escapes for the same reason at line-level.
     *
     * The discriminator is a **sweep**, not a single probe, and neither of the
     * two obvious single probes works: a one-entry list is rejected legitimately
     * by any schema with a list `.min()`, and an empty list is *accepted* by an
     * entry-constrained schema precisely because it holds no entry to object to.
     * What separates the two is that a count constraint accepts a contiguous run
     * of lengths while an entry constraint accepts none — so if no length in
     * range parses, the schema is refusing the entries and this function has
     * nothing to say about it.
     */
    const probedLengths = (maxEntries ?? minEntries ?? 0) + 1;
    const lengthAccepts = Array.from({ length: probedLengths }, (_entry, count) =>
        fieldSchema.safeParse(listOf(count + 1)).success
    ).includes(true);
    if (!lengthAccepts) {
        return issues;
    }

    if (typeof maxEntries === 'number') {
        if (!fieldSchema.safeParse(listOf(maxEntries)).success) {
            issues.push(
                `${label}: the field "${key}" declares maxEntries ${maxEntries}, but its configSchema ` +
                    'rejects a list that long. The control would let an author add entries the save refuses.'
            );
        } else if (fieldSchema.safeParse(listOf(maxEntries + 1)).success) {
            issues.push(
                `${label}: the field "${key}" declares maxEntries ${maxEntries}, but its configSchema ` +
                    'accepts a longer list. The control would stop an author short of what the schema allows.'
            );
        }
    }

    if (typeof minEntries === 'number' && !fieldSchema.safeParse(listOf(minEntries)).success) {
        issues.push(
            `${label}: the field "${key}" declares minEntries ${minEntries}, but its configSchema rejects ` +
                'a list that short, so the control would call a list valid that the save then refuses.'
        );
    }

    return issues;
}

/**
 * An `objectList`'s columns must describe an entry the schema actually validates.
 *
 * Without this the arm is the one place a block could declare a form that saves
 * nothing: an entry's keys live *inside* an array element, so the key-for-key
 * agreement `checkConfigFields` enforces between `configFields` and the schema's
 * top level does not reach them. A column named `title` over a schema expecting
 * `name` renders a row whose every keystroke is discarded at save, with no
 * message naming the column — which is why this checks the direction that bites
 * as well as the obvious one.
 *
 * Probed rather than read off the schema, the way every other check here works:
 * an entry built from the declared columns must parse, and the `maxLength` on
 * each column is held to the schema at its own boundary.
 */
function checkFieldColumns(
    label: string,
    key: string,
    field: Partial<BlockConfigField>,
    fieldSchema: ZodType
): readonly string[] {
    if (field.control !== 'objectList') {
        return [];
    }

    const columns = 'columns' in field ? field.columns : undefined;
    if (!Array.isArray(columns) || columns.length === 0) {
        return [
            `${label}: the objectList field "${key}" declares no columns, so the builder would draw ` +
                'rows with nothing in them and an author could never set the key.',
        ];
    }

    const issues: string[] = [];
    const declared = new Set<string>();
    const entry: Record<string, unknown> = {};

    for (const column of columns as readonly Partial<BlockConfigColumn>[]) {
        if (typeof column?.key !== 'string' || !column.key) {
            issues.push(`${label}: a column on the field "${key}" has no key.`);
            continue;
        }
        if (declared.has(column.key)) {
            issues.push(`${label}: the field "${key}" declares the column "${column.key}" twice.`);
        }
        declared.add(column.key);

        if (!column.label) {
            issues.push(`${label}: the column "${column.key}" on "${key}" needs a label.`);
        }

        // Checked against the vocabulary for the same reason the field's own
        // control is: a manifest reaches this suite as `unknown`, so the literal
        // union binds only the ones that already typechecked. Without this, a
        // column asking for `colour` — the likely mistake, since the two
        // vocabularies share three spellings — renders as a plain text input with
        // no error anywhere.
        const columnControls: readonly string[] = BLOCK_COLUMN_CONTROLS;
        if (typeof column.control !== 'string' || !columnControls.includes(column.control)) {
            issues.push(
                `${label}: the column "${column.key}" on "${key}" asks for the control ` +
                    `${JSON.stringify(column.control)}, which is not one a column may use ` +
                    `(${columnControls.join(', ')}). A column is not a field: it cannot ask for a picker.`
            );
            continue;
        }

        // A toggle has no text to hint at and no tokens to expand in, so either
        // member on one is a declaration the control will silently ignore.
        if (column.control === 'toggle') {
            for (const member of ['placeholder', 'maxLength', 'rendersTokens'] as const) {
                if (column[member] !== undefined) {
                    issues.push(
                        `${label}: the column "${column.key}" on "${key}" is a toggle but declares ` +
                            `${member}, which a checkbox has no way to honour.`
                    );
                }
            }
        }

        entry[column.key] = column.control === 'toggle' ? false : 'a';
    }

    if (issues.length > 0) {
        return issues;
    }

    /*
     * How many entries this schema needs before it will judge the entries at all.
     *
     * Not always one: a schema with `.min(2)` rejects a single-entry probe on its
     * *length*, which would be reported below as "the schema rejects your columns"
     * — a false finding against a correct manifest, and then an early return that
     * silently skips every column's maxLength. Sweeping for the shortest list the
     * schema accepts keeps the probe about the columns, which is what this
     * function is for.
     *
     * The ceiling reads **both** bounds, matching `checkFieldEntryBounds`'
     * `(maxEntries ?? minEntries ?? 0) + 1` one level up. Reading only
     * `maxEntries` looks sufficient and is not: a field declaring `minEntries: 2`
     * and no maximum collapses the ceiling to 1 and restores the single-entry
     * probe this sweep exists to replace. Two sweeps in one file disagreeing about
     * which bounds matter is how the gap reappears.
     */
    const boundsOf = (member: 'minEntries' | 'maxEntries'): number =>
        member in field && typeof field[member] === 'number' ? (field[member] as number) : 0;
    const listOf = (count: number): unknown[] => Array.from({ length: count }, () => ({ ...entry }));
    let probeLength: number | undefined;
    const probeLimit = Math.max(boundsOf('maxEntries'), boundsOf('minEntries'), 1);
    for (let count = 1; count <= probeLimit; count += 1) {
        if (fieldSchema.safeParse(listOf(count)).success) {
            probeLength = count;
            break;
        }
    }

    // The columns as a whole must make an entry the schema takes. A miss here is
    // usually a renamed key, so the message shows what was offered rather than
    // only what was refused.
    if (probeLength === undefined) {
        const parsed = fieldSchema.safeParse([entry]);
        return [
            `${label}: the field "${key}" declares the columns [${[...declared].join(', ')}], but its ` +
                'configSchema rejects a list holding such entries, so every row an author fills in ' +
                'would be discarded at save: ' +
                (parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join(', ')),
        ];
    }

    /*
     * A column the schema *strips* rather than rejects.
     *
     * Zod drops unknown keys by default, so a column whose key nothing validates
     * parses happily and then vanishes — which is the exact failure this function
     * was written to catch, and the one direction the parse above cannot see. The
     * rename case is caught by the parse (a required key goes missing); the
     * extra-key case is only visible by looking at what came back.
     */
    const parsed = fieldSchema.safeParse(listOf(probeLength));
    const validEntry = parsed.success && Array.isArray(parsed.data) ? parsed.data[0] : undefined;
    if (validEntry !== null && typeof validEntry === 'object') {
        const accepts = new Set(Object.keys(validEntry as Record<string, unknown>));
        const missing = [...declared].filter((column) => !accepts.has(column));
        if (missing.length > 0) {
            issues.push(
                `${label}: the field "${key}" declares the column(s) [${missing.join(', ')}], which its ` +
                    'configSchema does not validate — Zod strips an unrecognised key rather than ' +
                    'refusing it, so the control would draw those inputs and the save would silently ' +
                    'discard everything typed into them.'
            );
        }
    }

    for (const column of columns as readonly BlockConfigColumn[]) {
        issues.push(...checkColumnMaxLength(label, key, column, fieldSchema, entry, probeLength));
    }

    return issues;
}

/**
 * One column's `maxLength` against the schema, at the boundary.
 *
 * The same two probes and the same escape as {@link checkFieldMaxLength}, one
 * level down: the value under test varies while every sibling column holds the
 * value already proven acceptable, so a failure can only be about this column.
 */
function checkColumnMaxLength(
    label: string,
    key: string,
    column: BlockConfigColumn,
    fieldSchema: ZodType,
    validEntry: Readonly<Record<string, unknown>>,
    probeLength: number
): readonly string[] {
    const { maxLength } = column;
    if (maxLength === undefined) {
        return [];
    }

    if (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength < 1) {
        return [
            `${label}: the column "${column.key}" on "${key}" declares maxLength ` +
                `${JSON.stringify(maxLength)}, which is not a positive whole number of characters.`,
        ];
    }

    /*
     * The list is as long as the schema needs, with the column under test varying
     * on the first entry and every sibling holding a value already proven
     * acceptable. A single-entry probe would fail on length against a schema with
     * a list `.min()`, reporting the column as wrong for a reason that has nothing
     * to do with it.
     */
    const probe = (length: number): unknown =>
        Array.from({ length: probeLength }, (_entry, index) =>
            index === 0 ? { ...validEntry, [column.key]: 'a'.repeat(length) } : { ...validEntry }
        );

    // A format-constrained column rejects the probe on its pattern rather than its
    // length, so the boundary says nothing — the same escape, and the same reason.
    if (!fieldSchema.safeParse(probe(1)).success) {
        return [];
    }

    const issues: string[] = [];

    if (!fieldSchema.safeParse(probe(maxLength)).success) {
        issues.push(
            `${label}: the column "${column.key}" on "${key}" declares maxLength ${maxLength}, but its ` +
                'configSchema rejects a value of exactly that length. The control would allow a length ' +
                'the save then refuses.'
        );
    }

    if (fieldSchema.safeParse(probe(maxLength + 1)).success) {
        issues.push(
            `${label}: the column "${column.key}" on "${key}" declares maxLength ${maxLength}, but its ` +
                'configSchema accepts a longer value. The control would stop an author short of what ' +
                'the schema allows.'
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
 * Every resume reason a block could be handed, as concrete values to drive it with.
 *
 * `FLOW_RESUME_KINDS` names the kinds but cannot be walked directly any more:
 * `choice` carries an index, so there is no finite list of reasons to enumerate —
 * only a finite list of *shapes*. One representative per shape is what this check
 * needs, because what it is proving is that the block stops re-parking, and a
 * block that answers choice 0 answers choice 7 by the same code path.
 *
 * Two separate guards, because they catch different mistakes and only one of
 * them is the interesting one. `satisfies` below checks each entry really is a
 * resume reason — it would reject `{ kind: 'choice' }` with no index. What stops
 * a *new* kind arriving with no representative, silently shrinking what every
 * suspending block is tested against, is {@link ResumeKindsAllDriven} and the
 * value anchoring it. Do not read `satisfies` as covering that; it does not.
 */
const RESUME_REPRESENTATIVES = [
    { kind: 'event' },
    { kind: 'timeout' },
    { kind: 'choice', index: 0 },
] as const satisfies readonly FlowResumeReason[];

/** Fails to compile if a resume kind has no representative above. */
type ResumeKindsAllDriven = Exclude<
    FlowResumeKind,
    (typeof RESUME_REPRESENTATIVES)[number]['kind']
>;

/** Do not delete as unused: removing it erases the guard above. */
const resumeKindsAllDriven: [ResumeKindsAllDriven] extends [never]
    ? true
    : ['RESUME_REPRESENTATIVES is missing a resume kind', ResumeKindsAllDriven] = true;

void resumeKindsAllDriven;

/**
 * A block that parks must come back when it is woken.
 *
 * The one way to write a suspending block that is catastrophically wrong and
 * silent about it: forget to check `context.resume`, and every run that reaches
 * the block parks, wakes, parks again, forever. Nothing downstream notices,
 * because parking is exactly what the block is supposed to do.
 *
 * So drive it: park it, then hand it back one reason of each shape and require it
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

    for (const reason of RESUME_REPRESENTATIVES) {
        const resumed: unknown = await block.run(config, { ...context, resume: reason });
        const kind = (resumed as { kind?: unknown } | null)?.kind;

        if (kind === 'suspend') {
            issues.push(
                `${block.type}: parked again when resumed because of "${reason.kind}" instead of carrying on. ` +
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
