/**
 * A flash chat timer as a person picks it — an amount and a unit — and as the server
 * stores it, in seconds. Its bounds are the server's (`zSaveFlashChatChannelBody`), not
 * restated here.
 */

export const TIMER_UNITS = [
    { value: 'seconds', label: 'seconds', singular: 'second', seconds: 1 },
    { value: 'minutes', label: 'minutes', singular: 'minute', seconds: 60 },
    { value: 'hours', label: 'hours', singular: 'hour', seconds: 3_600 },
    { value: 'days', label: 'days', singular: 'day', seconds: 86_400 },
] as const;

export type TimerUnit = (typeof TIMER_UNITS)[number]['value'];

export interface TimerDraft {
    readonly amount: number;
    readonly unit: TimerUnit;
}

/** Whether a picked unit is one of {@link TIMER_UNITS}, as a `Select` hands back a plain string. */
export function isTimerUnit(value: string | null): value is TimerUnit {
    return TIMER_UNITS.some((unit) => unit.value === value);
}

export function timerToSeconds({ amount, unit }: TimerDraft): number {
    return amount * unitSeconds(unit);
}

/** A stored timer in the largest unit it divides into evenly: `7200` → 2 hours, `90` → 90 seconds. */
export function timerFromSeconds(seconds: number): TimerDraft {
    const unit = [...TIMER_UNITS].reverse().find((candidate) => seconds % candidate.seconds === 0) ?? TIMER_UNITS[0];
    return { amount: seconds / unit.seconds, unit: unit.value };
}

/** A timer for reading: `5400` → `1 hour 30 minutes`. Zero parts are left out. */
export function describeTimer(totalSeconds: number): string {
    let remaining = totalSeconds;
    const parts: string[] = [];
    for (const unit of [...TIMER_UNITS].reverse()) {
        const count = Math.floor(remaining / unit.seconds);
        remaining -= count * unit.seconds;
        if (count > 0) parts.push(`${count} ${count === 1 ? unit.singular : unit.label}`);
    }
    return parts.join(' ') || '0 seconds';
}

function unitSeconds(unit: TimerUnit): number {
    const found = TIMER_UNITS.find((candidate) => candidate.value === unit);
    if (!found) throw new Error(`Unknown timer unit: ${unit}`);
    return found.seconds;
}
