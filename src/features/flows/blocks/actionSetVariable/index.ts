import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import type { FlowVariableValue } from '../types';
import { VARIABLE_NAME_MAX_LENGTH, VARIABLE_NAME_MESSAGE, VARIABLE_NAME_SHAPE } from '../variableName';

export const ACTION_SET_VARIABLE = 'action.setVariable';

/** What a Set Variable can write. `time` is always now — there is no offset (PRD §8). */
export const SET_VARIABLE_VALUE_TYPES = ['text', 'number', 'boolean', 'time'] as const;

export type SetVariableValueType = (typeof SET_VARIABLE_VALUE_TYPES)[number];

/**
 * A number as an author would type one: optional sign, digits, at most one decimal point.
 *
 * `Number()` alone reads far more than that — `0x10`, `0b101`, `0o7` and `1e3` are all
 * numbers to it — and a value the author did not recognise as the number they typed is
 * the silent surprise this block refuses.
 */
const DECIMAL_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

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
 * An authored number, or undefined when the text is not one.
 *
 * Blank is **not** a number. `Number('')` and `Number('  ')` are both `0`, which is
 * exactly the silent zero a cleared box must never become — so emptiness is refused
 * before `Number` ever sees it. So is anything outside plain decimal notation
 * ({@link DECIMAL_NUMBER}): hex, binary, octal and exponents are numbers to `Number`, not
 * to an author. A run of digits too long to be finite is refused too: a variable holding
 * `Infinity` would print as a word in copy.
 */
export function parseAuthoredNumber(raw: string | undefined): number | undefined {
    const trimmed = raw?.trim();
    if (!trimmed || !DECIMAL_NUMBER.test(trimmed)) {
        return undefined;
    }

    const value = Number(trimmed);
    return Number.isFinite(value) ? value : undefined;
}

/**
 * Refuse a picked type with nothing (or nothing usable) to write, naming the field.
 *
 * Only the picked type's field is judged: the others are hidden, and the executor and
 * save-time validation leave hidden fields out before this runs.
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
            if (parseAuthoredNumber(config.numberValue) === undefined) {
                context.addIssue({
                    code: 'custom',
                    path: ['numberValue'],
                    message: config.numberValue?.trim()
                        ? `"${config.numberValue}" is not a number. Digits, please — 3, -2, 0.5.`
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

/**
 * The value to write, as the type the author picked: a JS number, a JS boolean, the
 * rendered text, or now as an ISO-8601 UTC string — the `time` value kind's spelling.
 *
 * Undefined only when the picked type's field is absent, which the schema refuses at
 * save and the executor refuses again when it parses the node before every run — so only
 * a caller bypassing the schema gets here; reported by `run` rather than assumed away.
 *
 * Text is written **as rendered, `''` included.** The schema judges the text the author
 * typed, before its tokens are filled in, so `{{var.x}}` passes it; when `x` was recorded
 * as `''` or `null` the rendered value is empty, and that is the value the author asked
 * for, not a broken block.
 */
function valueFor(config: SetVariableConfig): FlowVariableValue | undefined {
    switch (config.valueType) {
        case 'text':
            return config.textValue;
        case 'number':
            return parseAuthoredNumber(config.numberValue);
        case 'boolean':
            return config.booleanValue === undefined ? undefined : config.booleanValue === 'true';
        case 'time':
            return new Date().toISOString();
        default: {
            const illegal: never = config.valueType;
            throw new Error(`Unknown value type ${JSON.stringify(illegal)}.`);
        }
    }
}

/**
 * Put a value in the run's variable bag under a name the author chose.
 *
 * The general way to record something for later blocks: they read it back as
 * `{{var.<name>}}`, and a time — "Current time" — is offered to Time Since by name.
 * A variable lasts **one run**; other runs, flows and journeys never see it, and
 * nothing is kept per member between runs. Writing a name that already holds a value
 * overwrites it, the bag's ordinary last-writer-wins.
 */
export const block: BlockManifest<SetVariableConfig> = {
    type: ACTION_SET_VARIABLE,
    kind: 'action',
    label: 'Set Variable',
    description: "Scribble something on the run's notepad — text, a number, yes or no, or right now. Wiped when the run ends.",
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
            description: 'Current time stamps the moment the run gets here, so Time Since can tell how long ago that was.',
            control: 'select',
            defaultValue: 'text',
            options: [
                { value: 'text', label: 'Text' },
                { value: 'number', label: 'Number' },
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
            description: 'A plain number. Leave it blank and it will not save — blank is not zero.',
            control: 'text',
            // Clearing removes the key rather than writing '', so a cleared box reads
            // as "no number" to the refine, never as a zero.
            optional: true,
            placeholder: '69',
            visibleWhen: { field: 'valueType', equals: ['number'] },
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
    // nothing, so only one of the last three ever shows.
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
     * picked: a time is a `time`, so Time Since offers it; text, numbers and booleans
     * have no kind, so they are readable in copy only.
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
    // Reads nothing off the run beyond the copy the executor renders for it.
    requires: [],
    capabilities: [],
    canSuspend: false,
    run(config, context) {
        const value = valueFor(config);
        if (value === undefined) {
            return {
                kind: 'fail',
                error: `Set Variable has nothing to write into "${config.variableName}" — its ${config.valueType} value is missing.`,
            };
        }

        context.setOutput(config.variableName, value);
        return { kind: 'continue' };
    },
};
