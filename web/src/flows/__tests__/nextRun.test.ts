import { describe, expect, it } from 'vitest';
import {
    anyNextRunPassed,
    describeNextRun,
    formatNextRunExact,
    nextRunForNode,
    nodeDataKey,
    sameNextRun,
} from '../nextRun';

const NOW = new Date('2026-07-01T12:00:00.000Z');
const later = (milliseconds: number) => new Date(NOW.getTime() + milliseconds);

describe('describeNextRun', () => {
    it.each([
        { name: 'hours away', at: later(3 * 3_600_000), line: 'Next run in 3 hours' },
        { name: 'an hour away', at: later(3_600_000 + 60_000), line: 'Next run in 1 hour' },
        { name: 'minutes away', at: later(12 * 60_000 + 30_000), line: 'Next run in 12 minutes' },
        { name: 'one minute away', at: later(60_000), line: 'Next run in 1 minute' },
        { name: 'seconds away', at: later(20_000), line: 'Next run in less than a minute' },
        { name: 'days away', at: later(3 * 86_400_000), line: 'Next run in 3 days' },
        { name: 'exactly now', at: NOW, line: 'Next run any moment now' },
        { name: 'already passed', at: later(-5 * 60_000), line: 'Next run any moment now' },
    ])('$name: "$line"', ({ at, line }) => {
        expect(describeNextRun(at, NOW)).toBe(line);
    });
});

describe('formatNextRunExact', () => {
    it('reads the exact time on the 12-hour clock, in the zone it was worked out in', () => {
        expect(formatNextRunExact(new Date('2026-07-01T16:00:00.000Z'), 'America/Los_Angeles')).toBe(
            'Wed, Jul 1, 9:00 AM PDT (America/Los_Angeles)'
        );
    });
});

describe('nextRunForNode', () => {
    const saved = new Map([['schedule', nodeDataKey({ repeat: 'daily', time: '09:00' })]]);
    const listed = { timeZone: 'America/Los_Angeles', nextRuns: { schedule: '2026-07-01T16:00:00.000Z' } };

    it('shows the countdown for a node still as saved — whatever order its keys are in', () => {
        expect(nextRunForNode('schedule', { time: '09:00', repeat: 'daily' }, listed, saved)).toEqual({
            kind: 'at',
            at: '2026-07-01T16:00:00.000Z',
            timeZone: 'America/Los_Angeles',
        });
    });

    it('says the time comes with the save once the node is edited', () => {
        expect(nextRunForNode('schedule', { repeat: 'daily', time: '10:00' }, listed, saved)).toEqual({ kind: 'afterSave' });
    });

    it('shows nothing for a node with no listed time, or before the list has answered', () => {
        expect(nextRunForNode('other', {}, listed, saved)).toBeNull();
        expect(nextRunForNode('schedule', { repeat: 'daily', time: '09:00' }, null, saved)).toBeNull();
    });
});

describe('sameNextRun', () => {
    it('compares what the line says', () => {
        const at = { kind: 'at', at: 'x', timeZone: 'UTC' } as const;
        expect(sameNextRun(at, { ...at })).toBe(true);
        expect(sameNextRun(at, { ...at, at: 'y' })).toBe(false);
        expect(sameNextRun({ kind: 'afterSave' }, { kind: 'afterSave' })).toBe(true);
        expect(sameNextRun(at, { kind: 'afterSave' })).toBe(false);
        expect(sameNextRun(null, null)).toBe(true);
        expect(sameNextRun(at, null)).toBe(false);
    });
});

describe('anyNextRunPassed', () => {
    it('is true while any listed time is in the past', () => {
        const nextRuns = { timeZone: 'UTC', nextRuns: { first: later(60_000).toISOString(), second: later(-1).toISOString() } };
        expect(anyNextRunPassed(nextRuns, NOW)).toBe(true);
        expect(anyNextRunPassed({ timeZone: 'UTC', nextRuns: { first: later(60_000).toISOString() } }, NOW)).toBe(false);
        expect(anyNextRunPassed(null, NOW)).toBe(false);
    });
});
