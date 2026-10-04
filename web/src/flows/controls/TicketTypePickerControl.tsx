/**
 * The `ticketTypePicker` control: one of the guild's own declared ticket types, stored by
 * **key** and shown by label.
 *
 * Apart from `PickerControls.tsx` because it shares nothing with the snowflake pickers
 * there: a ticket type is not a Discord object, a flow cannot declare one for install, and
 * no block records one for a `{{var}}` to name. It is a row in the guild's ticket config,
 * which is where its options come from — Support and Verification only because a fresh
 * guild was seeded with them.
 */

import { useMemo } from 'react';
import { Select, Text } from '@mantine/core';
import type { BlockConfigField } from '../../api/types';
import { asText, type ControlProps } from './types';

type TicketTypePickerField = Extract<BlockConfigField, { control: 'ticketTypePicker' }>;

/**
 * Pick a ticket type the guild declares.
 *
 * A stored key the guild no longer declares is kept as an option marked **not available
 * here**, the way a picked variable nothing records any more is, so the field shows what
 * the node still holds rather than going blank — and the note under it says what that
 * will do. What it means at run time is each block's own call, so the note stays general.
 *
 * Clearable only when the field is `optional`, where clearing removes the key — no type,
 * which a block taking one optionally reads as "any". A required pick writes `''` on a
 * change, as a required channel picker does.
 */
export function TicketTypePickerControl({ field, value, onChange, context, error }: ControlProps<TicketTypePickerField>) {
    const picked = asText(value);

    const offered = useMemo(
        () => context.ticketTypes.map((ticketType) => ({ value: ticketType.type, label: ticketType.label })),
        [context.ticketTypes]
    );

    const stale = Boolean(picked) && !offered.some((option) => option.value === picked);
    const options = stale ? [...offered, { value: picked, label: `${picked} — not available here` }] : offered;

    return (
        <>
            <Select
                label={field.label}
                description={field.description}
                placeholder={field.optional ? 'Any type' : 'Pick a ticket type'}
                error={error}
                data={options}
                value={picked || null}
                onChange={(next) => onChange(next ?? (field.optional ? undefined : ''))}
                searchable
                clearable={field.optional ?? false}
                nothingFoundMessage="No ticket types match"
                allowDeselect={false}
            />
            {stale ? (
                <Text size="11px" c="yellow" mt={4}>
                    This server doesn&apos;t declare a &ldquo;{picked}&rdquo; ticket type any more. Pick one it
                    does, or add it back on the tickets page.
                </Text>
            ) : null}
            {offered.length === 0 && !stale ? (
                <Text size="11px" c="dimmed" mt={4}>
                    This server has no ticket types yet — set some up on the tickets page, then pick one here.
                </Text>
            ) : null}
        </>
    );
}
