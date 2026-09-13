/**
 * Duration editor: a number plus a unit, storing milliseconds, so nobody
 * hand-computes 604800000.
 */

import { Group, NumberInput, Select, Text } from '@mantine/core';
import { DURATION_UNITS, nextDurationValue, splitDuration } from './duration';
import { asNumber, type ControlProps } from './types';
import type { BlockConfigField } from '../../api/types';

type DurationField = Extract<BlockConfigField, { control: 'duration' }>;

/**
 * Number + unit, stored as milliseconds.
 *
 * The `optional` distinction is load-bearing and must not be unified away: when
 * `optional`, clearing the number removes the key entirely, because the server
 * rejects a non-positive value but allows absence. When it is *not* optional,
 * clearing emits `0` — an invalid value the save path reports, which is the
 * intended loud failure rather than a key silently vanishing from a required field.
 */
export function DurationControl({ field, value, onChange }: ControlProps<DurationField>) {
    const { value: amount, unit } = splitDuration(asNumber(value));

    const emit = (nextValue: number | null, nextUnit: number): void => {
        onChange(nextDurationValue(nextValue, nextUnit, field.optional ?? false));
    };

    return (
        <div>
            <Text size="12px" fw={700} mb={4}>
                {field.label}
            </Text>
            <Group gap="xs" align="flex-start" wrap="nowrap">
                <NumberInput
                    placeholder={field.placeholder ?? '5'}
                    min={0}
                    step={1}
                    value={amount ?? ''}
                    onChange={(next) =>
                        emit(typeof next === 'number' ? next : Number(next) || null, unit)
                    }
                    style={{ flex: 1 }}
                />
                <Select
                    data={DURATION_UNITS.map((option) => ({
                        value: String(option.ms),
                        label: option.label,
                    }))}
                    value={String(unit)}
                    onChange={(next) => emit(amount, Number(next) || 60_000)}
                    allowDeselect={false}
                    w={120}
                />
            </Group>
            {field.description ? (
                <Text size="11.5px" c="dimmed" mt={4}>
                    {field.description}
                </Text>
            ) : null}
        </div>
    );
}
