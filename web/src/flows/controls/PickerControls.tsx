/**
 * The two snowflake pickers. Nobody ever types a raw id, per the block contract's
 * `rolePicker`/`channelPicker` entries.
 */

import { useMemo } from 'react';
import { Select } from '@mantine/core';
import { roleColorHex } from '../nodeMeta';
import { asText, type ControlProps } from './types';
import type { BlockConfigField } from '../../api/types';

type RolePickerField = Extract<BlockConfigField, { control: 'rolePicker' }>;
type ChannelPickerField = Extract<BlockConfigField, { control: 'channelPicker' }>;

/** Searchable role picker showing each role's own colour as a leading dot. */
export function RolePickerControl({
    field,
    value,
    onChange,
    context,
}: ControlProps<RolePickerField>) {
    const current = asText(value);

    // Highest roles first, as Discord itself lists them.
    const options = useMemo(
        () =>
            [...context.roles]
                .sort((first, second) => second.position - first.position)
                .map((role) => ({ value: role.id, label: `@${role.name}` })),
        [context.roles]
    );

    const selected = context.roles.find((role) => role.id === current);

    return (
        <Select
            label={field.label}
            description={field.description}
            placeholder="Pick a role"
            data={options}
            value={current || null}
            onChange={(next) => onChange(next ?? '')}
            searchable
            nothingFoundMessage="No roles found"
            allowDeselect={false}
            leftSection={
                selected ? (
                    <span
                        style={{
                            width: 11,
                            height: 11,
                            borderRadius: '50%',
                            display: 'block',
                            background: roleColorHex(selected.color),
                        }}
                    />
                ) : undefined
            }
        />
    );
}

/** Searchable channel picker. */
export function ChannelPickerControl({
    field,
    value,
    onChange,
    context,
}: ControlProps<ChannelPickerField>) {
    const options = useMemo(
        () => context.channels.map((channel) => ({ value: channel.id, label: `# ${channel.name}` })),
        [context.channels]
    );

    return (
        <Select
            label={field.label}
            description={field.description}
            placeholder="Pick a channel"
            data={options}
            value={asText(value) || null}
            onChange={(next) => onChange(next ?? '')}
            searchable
            nothingFoundMessage="No channels found"
            allowDeselect={false}
        />
    );
}
