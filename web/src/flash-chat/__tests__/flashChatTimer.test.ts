import { describe, expect, it } from 'vitest';
import { describeTimer, timerFromSeconds, timerToSeconds } from '../flashChatTimer';

describe('flash chat timer', () => {
    it.each([
        [45, { amount: 45, unit: 'seconds' }],
        [90, { amount: 90, unit: 'seconds' }],
        [300, { amount: 5, unit: 'minutes' }],
        [7_200, { amount: 2, unit: 'hours' }],
        [1_209_600, { amount: 14, unit: 'days' }],
    ] as const)('opens %i seconds as %o, and saves it back unchanged', (seconds, draft) => {
        expect(timerFromSeconds(seconds)).toEqual(draft);
        expect(timerToSeconds(draft)).toBe(seconds);
    });

    it.each([
        [1, '1 second'],
        [90, '1 minute 30 seconds'],
        [3_600, '1 hour'],
        [86_400 * 2 + 3_600, '2 days 1 hour'],
    ])('reads %i seconds as "%s"', (seconds, words) => {
        expect(describeTimer(seconds)).toBe(words);
    });
});
