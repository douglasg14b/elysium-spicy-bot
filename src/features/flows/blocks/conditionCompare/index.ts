import { z } from 'zod';
import type { FlowStepOutcome } from '../../engine/stepOutcome';
import { notANumberMessage, parseAuthoredNumber, readNumber } from '../authoredNumber';
import type { BlockManifest } from '../manifest';
import type { FlowVariableValue } from '../types';
import { VARIABLE_NAME_MAX_LENGTH, VARIABLE_NAME_MESSAGE, VARIABLE_NAME_SHAPE } from '../variableName';

export const CONDITION_COMPARE = 'condition.compare';

/** The exit a run leaves by when the variable holds nothing to compare. */
export const COMPARE_NOT_SET_HANDLE = 'notSet';

/** How the variable is held up against the value. */
export const COMPARE_OPERATORS = ['is', 'isNot', 'moreThan', 'lessThan', 'contains'] as const;

export type CompareOperator = (typeof COMPARE_OPERATORS)[number];

/**
 * Longest the compared-to value may be, in characters, **once its tokens are filled
 * in** — the executor holds rendered copy to the field's `maxLength`. The same bound as
 * Set Variable's text, so any text one block can write, this one can compare against.
 */
const VALUE_MAX_LENGTH = 1000;

/**
 * `value` defaults to empty, which is a real answer for "is" and "is not" — "is empty" —
 * and refused for the operators that cannot use it; see {@link checkValueForOperator}.
 */
export const compareConfigSchema = z
    .object({
        variableName: z.string().min(1).max(VARIABLE_NAME_MAX_LENGTH).regex(VARIABLE_NAME_SHAPE, VARIABLE_NAME_MESSAGE),
        operator: z.enum(COMPARE_OPERATORS).default('is'),
        value: z.string().max(VALUE_MAX_LENGTH).default(''),
    })
    .superRefine((config, context) => checkValueForOperator(config, context));

export type CompareConfig = z.infer<typeof compareConfigSchema>;

/**
 * Refuse a value the picked operator could never answer from, naming the field.
 *
 * Judged as typed, before tokens are filled in: a value holding `{{` is left to the run,
 * which fails by name if what it renders to is not a number. Plain text that is not one
 * is refused here, where the author can still fix it.
 */
function checkValueForOperator(config: CompareConfig, context: z.RefinementCtx): void {
    const typed = config.value.trim();
    switch (config.operator) {
        case 'is':
        case 'isNot':
            return;
        case 'moreThan':
        case 'lessThan':
            if (!typed) {
                context.addIssue({
                    code: 'custom',
                    path: ['value'],
                    message: `${config.operator === 'moreThan' ? 'More' : 'Less'} than what? Give it a number to measure up to.`,
                });
            } else if (!typed.includes('{{') && parseAuthoredNumber(typed) === undefined) {
                context.addIssue({
                    code: 'custom',
                    path: ['value'],
                    message: notANumberMessage(config.value),
                });
            }
            return;
        case 'contains':
            if (!typed) {
                context.addIssue({
                    code: 'custom',
                    path: ['value'],
                    message: 'Contains what? Nothing is in everything — give it some text to look for.',
                });
            }
            return;
        default: {
            const illegal: never = config.operator;
            throw new Error(`Unknown operator ${JSON.stringify(illegal)}.`);
        }
    }
}

/** A Yes or No answer, as the handle it leaves by. */
function answer(yes: boolean): FlowStepOutcome {
    return { kind: 'continue', handle: yes ? 'true' : 'false' };
}

/**
 * Hold a held value up against the rendered value with the picked operator.
 *
 * "Is" and "is not" compare as numbers when both sides read as one, so `5` is `5.0`,
 * and as text ignoring case otherwise — a snowflake ID is too big to be a number
 * (`readNumber`), so two IDs compare character for character. "More than" and "less
 * than" need a number on both sides and fail the run by name rather than guess.
 * "Contains" reads the variable's text, ignoring case.
 *
 * For the text comparisons the value is trimmed and the variable is not, the way Message
 * Sent trims what it looks for and not the message it looks in: a stray space typed
 * after "yes" should not turn every answer into No.
 */
function compareValues(name: string, held: NonNullable<FlowVariableValue>, config: CompareConfig): FlowStepOutcome {
    const heldText = String(held).toLowerCase();
    const valueText = config.value.trim().toLowerCase();
    const heldNumber = readNumber(held);
    const valueNumber = parseAuthoredNumber(config.value);
    const bothNumbers = heldNumber !== undefined && valueNumber !== undefined;

    switch (config.operator) {
        case 'is':
            return answer(bothNumbers ? heldNumber === valueNumber : heldText === valueText);
        case 'isNot':
            return answer(bothNumbers ? heldNumber !== valueNumber : heldText !== valueText);
        case 'moreThan':
        case 'lessThan': {
            const words = config.operator === 'moreThan' ? 'more than' : 'less than';
            if (heldNumber === undefined) {
                return {
                    kind: 'fail',
                    error: `"${name}" holds ${JSON.stringify(held)}, which is not a number, so Compare can't tell if it's ${words} anything.`,
                };
            }
            if (valueNumber === undefined) {
                return {
                    kind: 'fail',
                    error: `Compare can't tell if "${name}" is ${words} ${JSON.stringify(config.value)} — that is not a number.`,
                };
            }
            return answer(config.operator === 'moreThan' ? heldNumber > valueNumber : heldNumber < valueNumber);
        }
        case 'contains':
            return answer(heldText.includes(valueText));
        default: {
            const illegal: never = config.operator;
            throw new Error(`Unknown operator ${JSON.stringify(illegal)}.`);
        }
    }
}

/**
 * Does a variable hold what you think it does?
 *
 * Reads the variable by name — any variable, of any kind — and answers Yes or No, on the
 * spot. Three exits: Yes, No, and **Not set** when the variable is unset or `null`. `''`
 * is a value, not unset: empty text is a fair thing to ask about ("is empty").
 *
 * The compared-to value renders its tokens first, so `{{var.other}}` compares two
 * variables; an unset token there fails the run by name, as it does in all copy — a
 * wiring mistake, not a branch. A value that renders empty is compared as empty, so
 * "contains" a token that rendered to nothing says Yes.
 *
 * Not set is deliberately not warned about when unconnected: the variable is usually a
 * counter set before a loop or a value the trigger always provides, never unset, and a
 * warning on every Compare card would teach authors to ignore amber.
 */
export const block: BlockManifest<CompareConfig> = {
    type: CONDITION_COMPARE,
    kind: 'condition',
    label: 'Compare',
    description: "Check what a variable's packing — is it, isn't it, bigger, smaller, got it in there somewhere? Yes, No, or never set.",
    group: 'conditions',
    icon: '⚖️',
    configSchema: compareConfigSchema,
    configFields: [
        {
            key: 'variableName',
            label: 'Variable',
            description: 'Any variable an earlier block records. Unset when the run gets here means Not set.',
            control: 'variableSelect',
        },
        {
            key: 'operator',
            label: 'Compare',
            description: 'Text ignores case. Numbers compare as numbers, so 5 is 5.0. More and less than need a number on both sides.',
            control: 'select',
            defaultValue: 'is',
            options: [
                { value: 'is', label: 'is' },
                { value: 'isNot', label: 'is not' },
                { value: 'moreThan', label: 'more than' },
                { value: 'lessThan', label: 'less than' },
                { value: 'contains', label: 'contains' },
            ],
        },
        {
            key: 'value',
            label: 'Value',
            description: 'Tokens get filled in when the run gets here, so {{var.other}} compares two variables. Empty means empty.',
            control: 'text',
            placeholder: '3',
            maxLength: VALUE_MAX_LENGTH,
            rendersTokens: true,
            defaultValue: '',
        },
    ],
    // e.g. "count · less than · 3".
    cardSummary: [
        { key: 'variableName', emptyText: 'no variable picked', stopIfEmpty: true },
        { key: 'operator', prefix: ' · ' },
        { key: 'value', prefix: ' · ', truncate: 20, emptyText: 'empty' },
    ],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
        // No `warnIfUnconnected` — see the block's doc comment for why.
        { id: COMPARE_NOT_SET_HANDLE, label: 'Not set', tone: 'caution' },
    ],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
    run(config, context) {
        const name = config.variableName;
        const held: FlowVariableValue | undefined = Object.hasOwn(context.variables, name)
            ? context.variables[name]
            : undefined;
        if (held === undefined || held === null) {
            return { kind: 'continue', handle: COMPARE_NOT_SET_HANDLE };
        }

        return compareValues(name, held, config);
    },
};
