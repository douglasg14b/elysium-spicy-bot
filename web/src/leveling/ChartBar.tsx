/**
 * One bar in a leveling bar chart: the hairline, the floor's counterpart, and the tooltip.
 *
 * The three bar charts in this feature — the member page's activity window, and the insights
 * page's level-reach and XP-decile charts — all made the same four decisions inline: a percentage
 * height, `minHeight: EMPTY_BAR_HEIGHT_PX` so an empty bucket keeps the axis continuous, a 2px
 * radius, and a colour that dims when the bar holds nothing.
 *
 * **That repetition is the risk, not the verbosity.** The floor computed in `levelingChart` and
 * the hairline applied in CSS are one coupled decision — a 2% floor against a 96px row is 1.92px,
 * which a `minHeight: 2` rounds up to exactly the hairline, leaving "one event" and "nothing" the
 * same height. That has happened once. Importing the constant fixed the number in three places
 * but left the *rule* restated in three places, which is how it comes back.
 *
 * The row wrapper stays at each call site: the gap, the overflow behaviour and the flex basis
 * genuinely differ between a 52-bar year and a 9-bar decile chart, and folding those in would
 * make this a component with a mode switch.
 */

import { Tooltip } from '@mantine/core';
import { EMPTY_BAR_HEIGHT_PX } from './levelingChart';

export interface ChartBarProps {
    /** 0–100, already scaled by whichever view function owns this chart's denominator. */
    readonly heightPercent: number;
    /** The tooltip's text. Every chart labels its own bar, since the units differ. */
    readonly label: string;
    /**
     * Whether the bar carries anything.
     *
     * Separate from `heightPercent > 0` on purpose: a floored bar has a non-zero height *because*
     * it is non-empty, so deriving one from the other would make the colour depend on the scale
     * rather than on the data. A chart whose server cannot emit an empty bar simply passes `true`.
     */
    readonly filled: boolean;
    /** The bar's CSS `flex`, since a 52-bar row and a 9-bar row want different basis values. */
    readonly flex: string;
    /** Minimum width in px, so a long series stays scrubbable rather than collapsing to slivers. */
    readonly minWidth?: number;
}

export function ChartBar({ heightPercent, label, filled, flex, minWidth }: ChartBarProps) {
    return (
        <Tooltip withArrow label={label}>
            <div
                style={{
                    flex,
                    minWidth,
                    // A percentage of the row's fixed height, so the tallest bar fills it and the
                    // rest are honestly proportional to it.
                    height: `${heightPercent}%`,
                    /*
                     * The hairline, from the module that owns it rather than a literal `2`. An
                     * empty bucket keeps a visible line so the axis reads as a continuous window
                     * instead of a row with holes in it, and the floor in `levelingChart` is set
                     * well clear of this — a test pins the relationship.
                     */
                    minHeight: EMPTY_BAR_HEIGHT_PX,
                    borderRadius: 2,
                    background: filled
                        ? 'var(--mantine-color-brand-6)'
                        : 'var(--mantine-color-dark-5)',
                }}
            />
        </Tooltip>
    );
}
