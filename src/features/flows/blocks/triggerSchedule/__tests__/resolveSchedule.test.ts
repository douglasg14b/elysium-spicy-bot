import { describe, expect, it } from 'vitest';
import { resolveSchedule, scheduleConfigSchema } from '..';

describe('resolveSchedule', () => {
    it("narrows a parsed config to exactly what its repeat uses, days in week order", () => {
        expect(resolveSchedule(scheduleConfigSchema.parse({ time: '09:00' }))).toEqual({ repeat: 'daily', time: '09:00' });
        expect(resolveSchedule(scheduleConfigSchema.parse({ repeat: 'days', time: '09:00', days: ['fri', 'mon'] }))).toEqual({
            repeat: 'days',
            time: '09:00',
            days: ['mon', 'fri'],
        });
        expect(resolveSchedule(scheduleConfigSchema.parse({ repeat: 'interval', every: '6h' }))).toEqual({
            repeat: 'interval',
            every: '6h',
        });
    });

    it('throws, naming the repeat, for a config that skipped the schema', () => {
        expect(() => resolveSchedule({ repeat: 'days', time: '09:00' })).toThrow(/"days" schedule is missing a field/);
        expect(() => resolveSchedule({ repeat: 'interval' })).toThrow(/"interval" schedule is missing a field/);
    });
});
