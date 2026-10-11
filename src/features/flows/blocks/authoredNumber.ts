import type { FlowVariableValue } from './types';

/**
 * How a number an author typed is read, shared by every block that takes one as text.
 *
 * A fragment, not a block: it lives at the blocks root beside `variableName.ts` and
 * exports no `block`, so discovery never sees it. One reading for every place a number
 * is typed, held or compared, so "5" means the same thing to Set Variable as it does to
 * Compare.
 */

/**
 * A number as an author would type one: optional sign, digits, at most one decimal point.
 *
 * `Number()` alone reads far more than that — `0x10`, `0b101`, `0o7` and `1e3` are all
 * numbers to it — and a value the author did not recognise as the number they typed is
 * the silent surprise these blocks refuse.
 */
const NUMBER_SHAPE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/**
 * Whether a JS number is one these blocks can hold exactly.
 *
 * **A number that can't be held exactly isn't one; snowflake IDs are text.** Past
 * `Number.MAX_SAFE_INTEGER` neighbouring integers collapse onto one value, so two
 * different 18-digit Discord IDs would compare as equal and adding 1 to one would
 * change nothing. Refusing them sends an ID down the text path instead — compared
 * character for character — and makes arithmetic on one fail by name. Also refuses
 * `Infinity`, which would print as a word in copy.
 */
function isExact(value: number): boolean {
    return Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

/**
 * An authored number, or undefined when the text is not one.
 *
 * Blank is **not** a number. `Number('')` and `Number('  ')` are both `0`, which is
 * exactly the silent zero a cleared box must never become — so emptiness is refused
 * before `Number` ever sees it. So is anything outside plain decimal notation
 * ({@link NUMBER_SHAPE}): hex, binary, octal and exponents are numbers to `Number`, not
 * to an author. So is anything too big to hold exactly ({@link isExact}).
 *
 * Use this — never `Number()` — wherever a block reads a number someone typed.
 */
export function parseAuthoredNumber(raw: string | undefined): number | undefined {
    const text = raw?.trim();
    if (!text || !NUMBER_SHAPE.test(text)) {
        return undefined;
    }

    const value = Number(text);
    return isExact(value) ? value : undefined;
}

/**
 * A variable's value as a number, or undefined when it is not one: a JS number is
 * itself when it can be held exactly, and a string an author could have typed as a
 * number — a text answer of "5" — is that number. A boolean is never a number.
 *
 * Takes a value that is there: what unset or `null` means is the reading block's call.
 */
export function readNumber(value: NonNullable<FlowVariableValue>): number | undefined {
    switch (typeof value) {
        case 'number':
            return isExact(value) ? value : undefined;
        case 'string':
            return parseAuthoredNumber(value);
        case 'boolean':
            return undefined;
        default: {
            const illegal: never = value;
            throw new Error(`Unknown variable value ${JSON.stringify(illegal)}.`);
        }
    }
}

/** What a save says about typed text that {@link parseAuthoredNumber} does not read as a number. */
export function notANumberMessage(typed: string): string {
    return `"${typed}" is not a number. Digits, please — 3, -2, 0.5.`;
}
