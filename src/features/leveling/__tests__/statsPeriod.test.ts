import { describe, expect, it } from 'vitest';
import {
    getStatsPeriodDays,
    parseStatsPeriod,
    resolveActivityChartGranularity,
} from '../logic/statsPeriod';

describe('statsPeriod', () => {
    it('defaults unknown period values to week', () => {
        expect(parseStatsPeriod(null)).toBe('week');
        expect(parseStatsPeriod('invalid')).toBe('week');
    });

    it('maps period choices to day counts', () => {
        expect(getStatsPeriodDays('week')).toBe(7);
        expect(getStatsPeriodDays('month')).toBe(30);
        expect(getStatsPeriodDays('year')).toBe(364);
    });

    it('uses daily chart buckets within the max bar count and weekly beyond it', () => {
        expect(resolveActivityChartGranularity(7)).toBe('daily');
        expect(resolveActivityChartGranularity(30)).toBe('daily');
        expect(resolveActivityChartGranularity(52)).toBe('daily');
        expect(resolveActivityChartGranularity(53)).toBe('weekly');
        expect(resolveActivityChartGranularity(364)).toBe('weekly');
    });
});
