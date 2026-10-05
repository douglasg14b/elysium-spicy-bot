/**
 * The two fixed-choice controls. `segmented` shows every option at once;
 * `select` drops down, for when the labels are too long to sit side by side.
 *
 * Both disable an option whose declared `requires` the run reaching this node cannot be
 * relied on to carry — "The member's last message" where a run about nobody can arrive —
 * and say why on hover. A value already picked stays shown: the server's issue sits
 * beside it, and the author picks another.
 */

import { SegmentedControl, Select, Text } from '@mantine/core';
import { asText, type ControlProps } from './types';
import type { BlockConfigField, BlockConfigOption } from '../../api/types';
import { describeUnavailableRequirement, firstUnavailable, type RequirementAvailability } from '../variables';

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

/** Why an option cannot be picked at this node, or undefined when it can. */
function unavailableReason(option: BlockConfigOption, available: RequirementAvailability): string | undefined {
    const missing = firstUnavailable(option.requires, available);
    return missing ? describeUnavailableRequirement(missing.requirement, missing.loss) : undefined;
}

/**
 * A small set of choices, all visible.
 *
 * `SegmentedControl` has no `label` prop of its own, so the label is drawn above it
 * — the same shape the hand-built button-style field used before this was generic.
 */
export function SegmentedChoiceControl({
    field,
    value,
    onChange,
    context,
    error,
}: ControlProps<SegmentedField>) {
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
                data={field.options.map((option) => {
                    const reason = unavailableReason(option, context.requirements);
                    return {
                        value: option.value,
                        // A native title: a disabled segment still takes hover, and the
                        // reason is the whole of what an author needs from it.
                        label: reason ? <span title={reason}>{option.label}</span> : option.label,
                        disabled: reason !== undefined,
                    };
                })}
                value={asText(value) || fallback}
                onChange={(next) => onChange(next)}
            />
            {/*
             * Drawn by hand: `SegmentedControl` is the one control here with no
             * `error` prop of its own, having no input to attach one to. Same
             * placement and colour as Mantine's, so it does not read as a different
             * kind of message.
             */}
            {error ? (
                <Text size="11.5px" c="red.6" mt={4}>
                    {error}
                </Text>
            ) : null}
            {field.description ? (
                <Text size="11.5px" c="dimmed" mt={4}>
                    {field.description}
                </Text>
            ) : null}
        </div>
    );
}

/** A longer set of choices, in a dropdown. */
export function SelectChoiceControl({ field, value, onChange, context, error }: ControlProps<SelectField>) {
    const fallback = displayedFallback(field);
    const reasons = new Map(
        field.options.flatMap((option) => {
            const reason = unavailableReason(option, context.requirements);
            return reason ? [[option.value, reason] as const] : [];
        })
    );

    return (
        <Select
            label={field.label}
            description={field.description}
            error={error}
            data={field.options.map((option) => ({
                value: option.value,
                label: option.label,
                disabled: reasons.has(option.value),
            }))}
            renderOption={({ option }) => <span title={reasons.get(option.value)}>{option.label}</span>}
            value={asText(value) || fallback}
            onChange={(next) => onChange(next ?? fallback)}
            allowDeselect={false}
        />
    );
}
