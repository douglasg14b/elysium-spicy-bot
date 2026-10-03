/**
 * The `variableSelect` control: one variable an earlier block records, picked by name
 * and filtered to the kind the field asks for — or any variable, when it asks for none.
 *
 * Named apart from `VariablePicker.tsx` on purpose. That one inserts `{{var.…}}` tokens
 * into copy; this one stores a **bare name**, which the executor passes through
 * untouched so the block can read the variable itself and decide what "unset" means.
 */

import { useMemo } from 'react';
import { Select, Text } from '@mantine/core';
import type { BlockConfigField, BlockOutputValueKind } from '../../api/types';
import { asText, type ControlProps } from './types';

type VariableSelectField = Extract<BlockConfigField, { control: 'variableSelect' }>;

/** A kind as it reads in "No time variables…". One entry per kind, so a new kind cannot go unworded. */
const KIND_NOUNS: Readonly<Record<BlockOutputValueKind, string>> = {
    channel: 'channel',
    time: 'time',
};

/**
 * Pick a variable of the field's kind from the ones in scope at this node.
 *
 * Offers what `availableVariablesAt` found upstream whose resolved kind matches — the
 * same path over-approximation save-time validation uses. Save is stricter in one way:
 * it refuses a name any block in the flow records as another kind, where this offers
 * the nearest producer's kind, and its message names both blocks. A name already
 * stored but no longer offered (renamed, deleted, now only recorded after this block,
 * or now nearest-recorded as another kind) is kept as an option marked **not available
 * here**, so the field shows what the config still holds rather than going blank.
 *
 * A field declaring no kind takes any variable, so everything in scope is offered and
 * the wording drops the kind: "Pick a variable".
 *
 * Clearable, since the stored name is optional to the schema; whether the block needs
 * one is the block's own refinement to say.
 */
export function VariableSelectControl({ field, value, onChange, context, error }: ControlProps<VariableSelectField>) {
    const picked = asText(value);
    const kind = field.valueKind;
    // "time variable", or plain "variable" for a field taking any.
    const noun = kind ? `${KIND_NOUNS[kind]} variable` : 'variable';

    const offered = useMemo(
        () =>
            context.variables
                .filter((variable) => !kind || variable.valueKind === kind)
                .map((variable) => ({
                    value: variable.name,
                    // The name, then which block records it — the same two facts the
                    // channel picker's "From earlier blocks" group shows.
                    label: `${variable.producerIcon} ${variable.name} · from ${variable.producerLabel}`,
                })),
        [context.variables, kind]
    );

    const stale = Boolean(picked) && !offered.some((option) => option.value === picked);
    const options = stale ? [...offered, { value: picked, label: `${picked} — not available here` }] : offered;

    return (
        <>
            <Select
                label={field.label}
                description={field.description}
                placeholder={`Pick a ${noun}`}
                error={error}
                data={options}
                value={picked || null}
                // Cleared removes the key, as a cleared optional picker does.
                onChange={(next) => onChange(next ?? undefined)}
                // Nothing to pick and nothing held: the hint below says what to do.
                disabled={options.length === 0}
                searchable
                clearable
                nothingFoundMessage={`No ${noun}s match`}
                allowDeselect={false}
            />
            {stale ? (
                <Text size="11px" c="yellow" mt={4}>
                    &ldquo;{picked}&rdquo; is not available here —{' '}
                    {kind
                        ? `the nearest block before this one that records it doesn't record it as a ${KIND_NOUNS[kind]}, or none does.`
                        : 'no block before this one records it.'}{' '}
                    Pick another, or wire the block that records it in above this one.
                </Text>
            ) : null}
            {options.length === 0 ? (
                <Text size="11px" c="dimmed" mt={4}>
                    No {noun}s before this block — add a block above it that records one, then pick it here.
                </Text>
            ) : null}
        </>
    );
}
