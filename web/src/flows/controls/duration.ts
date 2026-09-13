/**
 * The duration control's unit arithmetic, kept apart from its JSX so it can be
 * tested without a DOM — the web workspace has no component test runner, so pure
 * logic that lives in its own module is logic that can be covered at all.
 *
 * See `__tests__/duration.test.ts`.
 */

/** Units offered by the duration editor, largest-first for {@link splitDuration}. */
export const DURATION_UNITS = [
    { ms: 86_400_000, label: 'days' },
    { ms: 3_600_000, label: 'hours' },
    { ms: 60_000, label: 'minutes' },
    { ms: 1_000, label: 'seconds' },
] as const;

/**
 * Pick the largest unit that divides `ms` evenly, so 3600000 shows as "1 hours"
 * rather than "3600 seconds". Defaults to minutes when there is no value.
 */
export function splitDuration(ms: number | null): { value: number | null; unit: number } {
    if (ms === null || ms <= 0) return { value: null, unit: 60_000 };
    for (const { ms: size } of DURATION_UNITS) {
        if (ms % size === 0) return { value: ms / size, unit: size };
    }
    return { value: Math.round(ms / 1000), unit: 1_000 };
}

/**
 * What an emptied duration box should store — the one decision in this control
 * that can reach a saved graph, so it lives here where it can be tested rather
 * than inside a component this workspace has no runner for.
 *
 * An `optional` duration clears to `undefined`, removing the key: absence is a
 * real setting there, and the schema allows it. A required one clears to `0`,
 * which the schema rejects — the intended loud failure at save time, rather than
 * a required key silently vanishing.
 */
export function nextDurationValue(
    amount: number | null,
    unit: number,
    optional: boolean
): number | undefined {
    if (amount === null || Number.isNaN(amount) || amount <= 0) {
        return optional ? undefined : 0;
    }
    return Math.round(amount * unit);
}
