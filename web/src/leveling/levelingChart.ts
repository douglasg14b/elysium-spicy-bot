/**
 * The activity chart's bars, as numbers, with no charting dependency.
 *
 * A bar's height is only meaningful relative to the tallest bar in the same chart, so the
 * scale has to be computed across the whole series before any one bar can be drawn. That is
 * a decision, it has an all-zero edge case, and a component cannot be tested — so it lives
 * here and the page maps the result to divs.
 */

import type { LevelingActivityBucket, LevelingActivityChart } from '@brattybot/web-sdk';

export interface ActivityChartBar {
    /** The bucket's own day key, for the React key and the tooltip. */
    readonly activityDate: string;
    /** Every event in the bucket, which is what the bar's height represents. */
    readonly total: number;
    /** 0–100, as a percentage of the tallest bar in this chart. */
    readonly heightPercent: number;
    readonly messageCount: number;
    readonly reactionCount: number;
    readonly photoUploadCount: number;
    readonly voiceSessionCount: number;
}

/*
 * The chart's three heights live together, because they are one decision.
 *
 * The floor for "barely anything" only reads as different from "nothing" if it lands taller
 * than the hairline, and whether it does depends on the row's pixel height — so a rule stated
 * in percent and a rule stated in pixels have to be checked against each other. They were
 * previously two files apart, and the floor lost: 2% of 96px is 1.92px, which `minHeight: 2`
 * rounds up to exactly the hairline, leaving one event and no events the same height.
 */

/** The bar row's height. Owned here so the two floors below can be judged against it. */
export const CHART_HEIGHT_PX = 96;

/** The hairline an empty bucket keeps, so the axis has no holes in it. */
export const EMPTY_BAR_HEIGHT_PX = 2;

/**
 * The shortest a bar carrying at least one event may be drawn, as a percentage.
 *
 * Five rather than two: at {@link CHART_HEIGHT_PX} that is 4.8px against the hairline's 2px, a
 * gap wide enough to see. A test pins the relationship, so shrinking the chart cannot quietly
 * collapse it again.
 */
export const MIN_VISIBLE_BAR_PERCENT = 5;

export interface ActivityChartView {
    readonly bars: readonly ActivityChartBar[];
    /** The tallest bucket's total, so the chart can label what full height means. */
    readonly peak: number;
    /** Every event in the window, for the caption under the chart. */
    readonly total: number;
    /** True when the window has buckets but every one of them is empty. */
    readonly allEmpty: boolean;
}

/**
 * Events in a bucket: messages, reactions and voice sessions.
 *
 * **`photoUploadCount` is deliberately not added.** A photo upload is not its own event — it
 * is a flag on a message. `levelingService` grants one `message` event with
 * `photoBonusApplied: true`, and `aggregateActivityTotals` then increments `messageCount`
 * *and* `photoUploadCount` from that single row, so photos are a strict subset of messages
 * and never disjoint from them. Adding the fourth counter counted every photo message twice
 * and inflated the caption, the tooltip and the scale by the member's photo count.
 *
 * Kept identical to the server's own peak calculation — `dailyPeakEvents` in
 * `statsCardMetrics.ts` sums exactly these three — so the chart's scale and the page's
 * "Busiest" metric cannot disagree about what an event is. That agreement is the point; the
 * photo count is still carried on the bar for the tooltip's breakdown, as a qualifier on the
 * message count rather than a total of its own.
 */
function bucketTotal(bucket: LevelingActivityBucket): number {
    return bucket.messageCount + bucket.reactionCount + bucket.voiceSessionCount;
}

/**
 * Scale the buckets into drawable bars.
 *
 * Scaled to the **peak bucket**, not to a fixed ceiling: the point of the chart is the shape
 * of somebody's week, and a fixed axis flattens a quiet member's chart into a straight line
 * at the bottom. The peak is reported alongside so the page can say what full height is
 * worth, which is what keeps a relative scale honest.
 *
 * A peak of zero gives every bar 0% rather than dividing by it. `allEmpty` distinguishes
 * that from an empty `buckets` array — "they were here and did nothing" and "the window has
 * no days in it" are different things to say, and a chart of invisible bars says neither.
 */
export function activityChartView(chart: LevelingActivityChart): ActivityChartView {
    const totals = chart.buckets.map(bucketTotal);
    const peak = totals.reduce((highest, value) => Math.max(highest, value), 0);
    const total = totals.reduce((sum, value) => sum + value, 0);

    const bars = chart.buckets.map((bucket, index) => {
        const bucketSum = totals[index] ?? 0;
        return {
            activityDate: bucket.activityDate,
            total: bucketSum,
            /*
             * A floor on a non-empty bucket: a single event against a peak of 400 rounds to 0%
             * and vanishes, which reads as a day with nothing on it. A visible sliver is the
             * honest rendering of "something, but barely".
             *
             * {@link MIN_VISIBLE_BAR_PERCENT} rather than 2, and the reason is a cross-file
             * one: the page gives every bar `minHeight: 2` so an empty bucket keeps a hairline,
             * and a 2% floor against a 96px row is 1.92px — which that `minHeight` rounds up to
             * exactly the hairline's 2px. The floor computed here was real, tested, and then
             * invisible, leaving one event and no events the same height and distinguishable
             * only by colour.
             */
            heightPercent:
                peak > 0 && bucketSum > 0
                    ? Math.max(Math.round((bucketSum / peak) * 100), MIN_VISIBLE_BAR_PERCENT)
                    : 0,
            messageCount: bucket.messageCount,
            reactionCount: bucket.reactionCount,
            photoUploadCount: bucket.photoUploadCount,
            voiceSessionCount: bucket.voiceSessionCount,
        };
    });

    return {
        bars,
        peak,
        total,
        allEmpty: chart.buckets.length > 0 && peak === 0,
    };
}
