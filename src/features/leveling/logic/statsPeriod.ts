/** Max bars on the stats activity chart before switching from daily to weekly buckets. */
export const STATS_CHART_MAX_BARS = 52;

export type StatsPeriod = 'week' | 'month' | 'year';

export const DEFAULT_STATS_PERIOD: StatsPeriod = 'week';

/** Year uses 52×7 days so weekly chart buckets stay within {@link STATS_CHART_MAX_BARS}. */
export const STATS_PERIOD_DAYS: Record<StatsPeriod, number> = {
    week: 7,
    month: 30,
    year: 52 * 7,
} as const;

export type ActivityChartGranularity = 'daily' | 'weekly';

export function parseStatsPeriod(value: string | null): StatsPeriod {
    if (value === 'month' || value === 'year') {
        return value;
    }

    return DEFAULT_STATS_PERIOD;
}

export function getStatsPeriodDays(period: StatsPeriod): number {
    return STATS_PERIOD_DAYS[period];
}

export function resolveActivityChartGranularity(periodDays: number): ActivityChartGranularity {
    return periodDays <= STATS_CHART_MAX_BARS ? 'daily' : 'weekly';
}

export function formatStatsPeriodChartLabel(period: StatsPeriod): string {
    switch (period) {
        case 'week':
            return '7d';
        case 'month':
            return '30d';
        case 'year':
            return '1y';
    }
}
