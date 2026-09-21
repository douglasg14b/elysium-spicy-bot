/**
 * One chip on a resource's summary line.
 *
 * Deliberately presentational and deliberately thin: it reads a row out of
 * `RESOURCE_CHIPS`, renders the tone, the glyph and the label, and calls back when
 * clicked. Every decision about *whether* a chip applies lives in
 * `detectResourceProblems.ts`, and every decision about *where* clicking it lands
 * lives in whatever renders the expanded row — because only that component owns the
 * refs to focus. This one owns neither, which is what keeps it testable by reading.
 *
 * `web/` has no jsdom, so components here are not render-tested; the arrangement the
 * repo already uses (see `installSummary.test.ts`) is to keep the decisions in a
 * module the suite can drive and leave the component a renderer over it. Putting any
 * judgement in this file would put it somewhere nothing can check.
 *
 * The visual language is the mockup's, expressed in Mantine over the theme's slate
 * `dark` ramp: grey for a plain fact, teal for adoption, amber for "this will not do
 * what you think", red for "this will be refused". `variant="light"` gives the tinted
 * fill and matching text the mockup draws by hand.
 */

import { Badge, Tooltip } from '@mantine/core';
import type { ResourceChipDetail, ResourceChipId } from './resourceChips';
import { RESOURCE_CHIPS } from './resourceChips';

interface ResourceChipProps {
    id: ResourceChipId;
    /** Whatever the detector found — a rule number, a count, which field failed. */
    detail?: ResourceChipDetail;
    /**
     * Expand the row and focus the field that caused this chip.
     *
     * Optional, and its absence is meaningful rather than a default: a chip rendered
     * in a legend or a tooltip has nothing to jump to, and should not look clickable.
     */
    onJump?: () => void;
}

const NO_DETAIL: ResourceChipDetail = {};

export function ResourceChip({ id, detail = NO_DETAIL, onJump }: ResourceChipProps) {
    const style = RESOURCE_CHIPS[id];
    const ChipIcon = style.icon;
    const label = style.label(detail);
    const clickable = Boolean(onJump);

    const badge = (
        <Badge
            size="sm"
            variant="light"
            color={style.color}
            leftSection={<ChipIcon size={12} />}
            style={clickable ? { cursor: 'pointer' } : undefined}
            onClick={onJump}
            // A chip that jumps is a control, so it is reachable and pressable without
            // a mouse. A chip that does not is a label, and announcing it as a button
            // would promise an interaction that is not there.
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onKeyDown={
                clickable
                    ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onJump?.();
                          }
                      }
                    : undefined
            }
        >
            {label}
        </Badge>
    );

    // The reason is the sentence the contract doc shows for this chip, so the tooltip
    // and the doc cannot say different things about what a chip means.
    return (
        <Tooltip label={style.reason} withArrow multiline w={260} openDelay={350}>
            {badge}
        </Tooltip>
    );
}
