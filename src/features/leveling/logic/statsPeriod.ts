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

/**
 * The periods, as data, for the places that need to enumerate them.
 *
 * Ordered shortest to longest because that is the order a period picker offers them.
 * Held to the type by `satisfies` in both directions — a member that is not a
 * `StatsPeriod` is rejected here, and `STATS_PERIOD_DAYS` above cannot omit one — so this
 * cannot drift from the union it mirrors.
 */
export const STATS_PERIODS = ['week', 'month', 'year'] as const satisfies readonly StatsPeriod[];

/**
 * Do not delete as unused: removing this lets the list above go stale.
 *
 * `satisfies` rejects a member that is not a `StatsPeriod`, but says nothing about one
 * the list *omits* — which is the direction that actually rots, since adding `'quarter'`
 * to the union would leave this list silently short and every period picker missing it.
 *
 * The tuple wrapper is load-bearing: a bare `Missing extends never` distributes over the
 * union and is vacuously true for an empty one, so it would pass whatever the list said.
 */
type MissingStatsPeriod = Exclude<StatsPeriod, (typeof STATS_PERIODS)[number]>;

const statsPeriodsAreComplete: [MissingStatsPeriod] extends [never]
    ? true
    : ['STATS_PERIODS is missing a member', MissingStatsPeriod] = true;

void statsPeriodsAreComplete;

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
