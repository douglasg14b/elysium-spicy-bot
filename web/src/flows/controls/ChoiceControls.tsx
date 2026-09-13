/**
 * The two fixed-choice controls. `segmented` shows every option at once;
 * `select` drops down, for when the labels are too long to sit side by side.
 */

import { SegmentedControl, Select, Text } from '@mantine/core';
import { asText, type ControlProps } from './types';
import type { BlockConfigField } from '../../api/types';

type SegmentedField = Extract<BlockConfigField, { control: 'segmented' }>;
type SelectField = Extract<BlockConfigField, { control: 'select' }>;

/**
 * What a choice control shows when `node.data` carries no value for it.
 *
 * A fixed-choice control cannot render "nothing selected" without looking broken, so
 * it falls back to the declared default. It does **not** write that value back:
 * repairing the graph from inside a render would dirty the flow and clear the redo
 * stack merely because someone selected a node. The graph is brought up to date once
 * on load instead — see the `defaultDataFor` backfill in `FlowBuilderPage`.
 */
function displayedFallback(field: SegmentedField | SelectField): string {
    return field.defaultValue ?? field.options[0]?.value ?? '';
}

/**
 * A small set of choices, all visible.
 *
 * `SegmentedControl` has no `label` prop of its own, so the label is drawn above it
 * — the same shape the hand-built button-style field used before this was generic.
 */
export function SegmentedChoiceControl({ field, value, onChange }: ControlProps<SegmentedField>) {
    const fallback = displayedFallback(field);

    return (
        <div>
            <Text size="sm" fw={500} mb={4}>
                {field.label}
            </Text>
            <SegmentedControl
                fullWidth
                size="xs"
                color="brand"
                data={field.options.map((option) => ({
                    value: option.value,
                    label: option.label,
                }))}
                value={asText(value) || fallback}
                onChange={(next) => onChange(next)}
            />
            {field.description ? (
                <Text size="11.5px" c="dimmed" mt={4}>
                    {field.description}
                </Text>
            ) : null}
        </div>
    );
}

/** A longer set of choices, in a dropdown. */
export function SelectChoiceControl({ field, value, onChange }: ControlProps<SelectField>) {
    const fallback = displayedFallback(field);

    return (
        <Select
            label={field.label}
            description={field.description}
            data={field.options.map((option) => ({ value: option.value, label: option.label }))}
            value={asText(value) || fallback}
            onChange={(next) => onChange(next ?? fallback)}
            allowDeselect={false}
        />
    );
}
