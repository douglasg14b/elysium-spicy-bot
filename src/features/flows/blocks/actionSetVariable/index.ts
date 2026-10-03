import { z } from 'zod';
import { notANumberMessage, parseAuthoredNumber, readNumber } from '../authoredNumber';
import type { BlockManifest } from '../manifest';
import type { FlowRunContext, FlowVariableValue } from '../types';
import { VARIABLE_NAME_MAX_LENGTH, VARIABLE_NAME_MESSAGE, VARIABLE_NAME_SHAPE } from '../variableName';

export const ACTION_SET_VARIABLE = 'action.setVariable';

/**
 * What a Set Variable can write. `time` is always now — there is no offset (PRD §8).
 * `add` adds the number to whatever the variable already holds.
 */
export const SET_VARIABLE_VALUE_TYPES = ['text', 'number', 'add', 'boolean', 'time'] as const;

export type SetVariableValueType = (typeof SET_VARIABLE_VALUE_TYPES)[number];

/**
 * Longest a text value may be, in characters, **once its tokens are filled in**.
 *
 * The executor holds rendered copy to the field's `maxLength`, so this is what bounds
 * the write. The whole run's bag is capped at `FLOW_MAX_VARIABLES_SIZE` (16 KiB, in
 * bytes), and a thousand characters is at most about 4 KiB even in four-byte UTF-8 —
 * one variable cannot spend the bag on its own, and the result still fits inside a
 * Discord message when a later block posts it.
 */
const TEXT_VALUE_MAX_LENGTH = 1000;

/**
 * Every value field is optional, and only judged while its type is picked.
 *
 * Each is shown by `valueType` (`visibleWhen`), so save-time validation and the
 * executor hand this schema only the one that applies — a stale number left from
 * before the author switched to text is never parsed. "Required when shown" therefore
 * lives in {@link checkValueForType}, not on the keys.
 *
 * The number is a **string** until `run`: there is no number control, a `text` box
 * yields a string, and `z.coerce.number()` would turn a cleared box into `0` — a value
 * the author never typed, written as though they had. The boolean stays `'true' |
 * 'false'` with no `.transform()`, for the reason `actionPostEmbed` gives on
 * `showTimestamp`: conformance reads a default as schema input.
 */
export const setVariableConfigSchema = z
    .object({
        variableName: z.string().min(1).max(VARIABLE_NAME_MAX_LENGTH).regex(VARIABLE_NAME_SHAPE, VARIABLE_NAME_MESSAGE),
        valueType: z.enum(SET_VARIABLE_VALUE_TYPES).default('text'),
        textValue: z.string().max(TEXT_VALUE_MAX_LENGTH).optional(),
        numberValue: z.string().optional(),
        booleanValue: z.enum(['true', 'false']).optional(),
    })
    .superRefine((config, context) => checkValueForType(config, context));

export type SetVariableConfig = z.infer<typeof setVariableConfigSchema>;

/**
 * Refuse a picked type with nothing (or nothing usable) to write, naming the field.
 *
 * Only the picked type's field is judged: the others are hidden, and the executor and
 * save-time validation leave hidden fields out before this runs. Adding shares the
 * number box, so it is held to the same rule: `0` is a number, blank is not.
 */
function checkValueForType(config: SetVariableConfig, context: z.RefinementCtx): void {
    switch (config.valueType) {
        case 'text':
            if (!config.textValue) {
                context.addIssue({
                    code: 'custom',
                    path: ['textValue'],
                    message: 'Give it something to say — or pick a different type.',
                });
            }
            return;
        case 'number':
        case 'add':
            if (parseAuthoredNumber(config.numberValue) === undefined) {
                context.addIssue({
                    code: 'custom',
                    path: ['numberValue'],
                    message: config.numberValue?.trim()
                        ? notANumberMessage(config.numberValue)
                        : 'A number, please. Blank is not zero.',
                });
            }
            return;
        case 'boolean':
            if (config.booleanValue === undefined) {
                context.addIssue({ code: 'custom', path: ['booleanValue'], message: 'Pick true or false.' });
            }
            return;
        case 'time':
            return;
        default: {
            const illegal: never = config.valueType;
            throw new Error(`Unknown value type ${JSON.stringify(illegal)}.`);
        }
    }
}

/** What `run` does: write a value, or fail the run with a reason worth reading. */
type PlannedWrite =
    | { readonly kind: 'write'; readonly value: FlowVariableValue }
    | { readonly kind: 'fail'; readonly error: string };

/**
 * The value to write, as the type the author picked: a JS number, a JS boolean, the
 * rendered text, now as an ISO-8601 UTC string — the `time` value kind's spelling — or
 * the sum of what the variable holds and the number to add.
 *
 * A missing value — the picked type's field absent — fails, though the schema refuses it
 * at save and the executor refuses it again when it parses the node before every run, so
 * only a caller bypassing the schema gets there; reported rather than assumed away.
 *
 * Text is written **as rendered, `''` included.** The schema judges the text the author
 * typed, before its tokens are filled in, so `{{var.x}}` passes it; when `x` was recorded
 * as `''` or `null` the rendered value is empty, and that is the value the author asked
 * for, not a broken block.
 */
function plannedWrite(config: SetVariableConfig, variables: FlowRunContext['variables']): PlannedWrite {
    const missing: PlannedWrite = {
        kind: 'fail',
        error: `Set Variable has nothing to write into "${config.variableName}" — its ${config.valueType} value is missing.`,
    };
    const write = (value: FlowVariableValue | undefined): PlannedWrite =>
        value === undefined ? missing : { kind: 'write', value };

    switch (config.valueType) {
        case 'text':
            return write(config.textValue);
        case 'number':
            return write(parseAuthoredNumber(config.numberValue));
        case 'add': {
            const amount = parseAuthoredNumber(config.numberValue);
            return amount === undefined ? missing : sumWith(config.variableName, amount, variables);
        }
        case 'boolean':
            return write(config.booleanValue === undefined ? undefined : config.booleanValue === 'true');
        case 'time':
            return write(new Date().toISOString());
        default: {
            const illegal: never = config.valueType;
            throw new Error(`Unknown value type ${JSON.stringify(illegal)}.`);
        }
    }
}

/**
 * What `name` holds plus `amount`, written as a JS number.
 *
 * Unset or `null` counts as 0, so a counter needs no Set to zero before its first add.
 * Anything else is read by `readNumber`, so a text answer of "5" is 5. What it does not
 * read as a number — "abc", `true`, a snowflake ID too big to hold exactly — fails the
 * run by name: the bag carries no types, and adding 1 to "abc" has no answer worth
 * guessing at.
 */
function sumWith(name: string, amount: number, variables: FlowRunContext['variables']): PlannedWrite {
    const current = Object.hasOwn(variables, name) ? variables[name] : undefined;
    const start = current === undefined || current === null ? 0 : readNumber(current);

    if (start === undefined) {
        return {
            kind: 'fail',
            error: `"${name}" holds ${JSON.stringify(current)}, which is not a number, so there is nothing to add ${amount} to.`,
        };
    }

    // Two exact numbers can still sum past what can be held exactly — the line
    // `parseAuthoredNumber` draws on the way in, held on the way out too.
    const sum = start + amount;
    if (Math.abs(sum) > Number.MAX_SAFE_INTEGER) {
        return {
            kind: 'fail',
            error: `Adding ${amount} to "${name}" goes past ${Number.MAX_SAFE_INTEGER} — too big to count exactly.`,
        };
    }

    // Binary floats drift: 0.1 + 0.2 is 0.30000000000000004. Neither operand had more
    // decimal places than the larger of the two, so neither should the sum.
    return { kind: 'write', value: Number(sum.toFixed(Math.max(decimalPlaces(start), decimalPlaces(amount)))) };
}

/** How many decimal places a number has, exponent notation ("1e-7") included. */
function decimalPlaces(value: number): number {
    const [mantissa = '', exponent = '0'] = String(value).split('e');
    const fraction = mantissa.split('.')[1] ?? '';
    return Math.max(0, fraction.length - Number(exponent));
}

/**
 * Put a value in the run's variable bag under a name the author chose.
 *
 * The general way to record something for later blocks: they read it back as
 * `{{var.<name>}}`, and a time — "Current time" — is offered to Time Since by name.
 * A variable lasts **one run**; other runs, flows and journeys never see it, and
 * nothing is kept per member between runs. Writing a name that already holds a value
 * overwrites it, the bag's ordinary last-writer-wins — "Add to number" included, which
 * reads the old value first and overwrites it with the sum.
 */
export const block: BlockManifest<SetVariableConfig> = {
    type: ACTION_SET_VARIABLE,
    kind: 'action',
    label: 'Set Variable',
    description:
        "Scribble something on the run's notepad — text, a number, yes or no, or right now — or add to a number to keep count. Wiped when the run ends.",
    group: 'actions',
    icon: '📝',
    configSchema: setVariableConfigSchema,
    configFields: [
        {
            key: 'variableName',
            label: 'Name',
            description: 'Later blocks read it as {{var.name}}. Reuse a name and the newest value wins.',
            control: 'text',
            placeholder: 'seenAt',
            maxLength: VARIABLE_NAME_MAX_LENGTH,
            // Deliberately NOT `rendersTokens`: this is the *name* of a variable, not
            // copy anybody reads — the reason Pick Random's `outputKey` gives.
        },
        {
            key: 'valueType',
            label: 'Value',
            description:
                'Current time stamps the moment the run gets here, so Time Since can tell how long ago that was. ' +
                'Add to number adds to whatever is there — nothing there counts as 0.',
            control: 'select',
            defaultValue: 'text',
            options: [
                { value: 'text', label: 'Text' },
                { value: 'number', label: 'Number' },
                { value: 'add', label: 'Add to number' },
                { value: 'boolean', label: 'True or false' },
                { value: 'time', label: 'Current time' },
            ],
        },
        {
            key: 'textValue',
            label: 'Text',
            description: 'Tokens get filled in when the run gets here, so you can build it out of other variables.',
            control: 'text',
            placeholder: '{{subject.username}} was here',
            maxLength: TEXT_VALUE_MAX_LENGTH,
            rendersTokens: true,
            visibleWhen: { field: 'valueType', equals: ['text'] },
        },
        {
            key: 'numberValue',
            label: 'Number',
            description:
                'A plain number — when adding, a negative one takes away. Leave it blank and it will not save — blank is not zero.',
            control: 'text',
            // Clearing removes the key rather than writing '', so a cleared box reads
            // as "no number" to the refine, never as a zero.
            optional: true,
            placeholder: '69',
            visibleWhen: { field: 'valueType', equals: ['number', 'add'] },
        },
        {
            key: 'booleanValue',
            label: 'True or false',
            control: 'segmented',
            defaultValue: 'true',
            options: [
                { value: 'true', label: 'True' },
                { value: 'false', label: 'False' },
            ],
            visibleWhen: { field: 'valueType', equals: ['boolean'] },
        },
    ],
    // The name, the type, then whichever value applies — a hidden value part renders
    // nothing, so only one of the last three ever shows: "count · Add to number · 1".
    cardSummary: [
        { key: 'variableName', emptyText: 'no name yet', stopIfEmpty: true },
        { key: 'valueType', prefix: ' · ' },
        { key: 'textValue', prefix: ' · ', quote: true, truncate: 20, hideWhenEmpty: true },
        { key: 'numberValue', prefix: ' · ', hideWhenEmpty: true },
        { key: 'booleanValue', prefix: ' · ', hideWhenEmpty: true },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    /*
     * `authored` because the name is the author's, and the kind follows the type they
     * picked: a time is a `time`, so Time Since offers it; text, numbers (added to or
     * not) and booleans have no kind, so they are readable in copy and by Compare.
     */
    outputs: [
        {
            naming: 'authored',
            fromField: 'variableName',
            label: 'The saved value',
            description: 'Whatever this block wrote, under the name it was given. Gone when the run ends.',
            valueKindFrom: { field: 'valueType', kinds: { time: 'time' } },
        },
    ],
    // Reads nothing off the run beyond the copy the executor renders for it and, when
    // adding, the variable it adds to — which every run carries.
    requires: [],
    capabilities: [],
    canSuspend: false,
    run(config, context) {
        const planned = plannedWrite(config, context.variables);
        switch (planned.kind) {
            case 'fail':
                return { kind: 'fail', error: planned.error };
            case 'write':
                context.setOutput(config.variableName, planned.value);
                return { kind: 'continue' };
            default: {
                const illegal: never = planned;
                throw new Error(`Unknown write ${JSON.stringify(illegal)}.`);
            }
        }
    },
};
