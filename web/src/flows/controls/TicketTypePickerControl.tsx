/**
 * The `ticketTypePicker` control: one of the guild's own declared ticket types, stored by
 * **key** and shown by label — or a ticket type the flow's journey declares, which install
 * creates (or finds) and writes in.
 *
 * Apart from `PickerControls.tsx` because it shares little with the snowflake pickers
 * there: a ticket type is not a Discord object and no block records one for a `{{var}}` to
 * name. It is a row in the guild's ticket config, which is where its options come from —
 * Support and Verification only because a fresh guild was seeded with them. What it does
 * share is the declared-resource sidecar: picking a declared type writes `<field>Key`
 * through the same `resource:` option values, so install's write-back fills it in.
 */

import { useMemo } from 'react';
import { Select, Text } from '@mantine/core';
import type { BlockConfigField } from '@brattybot/web-sdk';
import { declaredOptionValue, parseDeclaredOption } from './PickerControls';
import { asText, resourceKeyFieldFor, type ControlProps } from './types';

type TicketTypePickerField = Extract<BlockConfigField, { control: 'ticketTypePicker' }>;

/**
 * Pick a ticket type the guild declares, or one the flow's journey declares.
 *
 * A stored key the guild no longer declares is kept as an option marked **not available
 * here**, the way a picked variable nothing records any more is, so the field shows what
 * the node still holds rather than going blank — and the note under it says what that
 * will do. What it means at run time is each block's own call, so the note stays general.
 *
 * **A declared type has its own group, with `resource:` values.** Without the prefix, the
 * seeded `verification` declared by a journey and the guild's own `verification` would be
 * two options with one value, which Mantine refuses. Both show: picking the declared one
 * waits for install, as a declared channel does, and keeps the flow off until then.
 *
 * Picking a declared type writes the sidecar and **removes** the field — `undefined`, not
 * `''`, since Ticket Event's field is `.min(1).optional()` and an empty string is a value
 * it refuses. Picking the guild's own type writes the field and clears the sidecar.
 *
 * Clearable only when the field is `optional`, where clearing removes the key — no type,
 * which a block taking one optionally reads as "any". A required pick writes `''` on a
 * change, as a required channel picker does.
 */
export function TicketTypePickerControl({ field, value, onChange, context, config, error }: ControlProps<TicketTypePickerField>) {
    const picked = asText(value);
    const resourceKeyField = resourceKeyFieldFor(field.key);
    const declaredKey = asText(config?.[resourceKeyField]);

    const offered = useMemo(
        () => context.ticketTypes.map((ticketType) => ({ value: ticketType.type, label: ticketType.label })),
        [context.ticketTypes]
    );
    const declared = useMemo(
        () =>
            context.declaredResources
                .filter((resource) => resource.kind === 'ticketType')
                .map((resource) => ({ value: declaredOptionValue(resource.key), label: resource.defaultName })),
        [context.declaredResources]
    );

    // The sidecar wins, as it does on the snowflake pickers: it is canonical, and once
    // install has filled the key in, the field and the sidecar agree anyway.
    const current = declaredKey ? declaredOptionValue(declaredKey) : picked || null;

    const stale = !declaredKey && Boolean(picked) && !offered.some((option) => option.value === picked);
    const guildOptions = stale ? [...offered, { value: picked, label: `${picked} — not available here` }] : offered;
    const options =
        declared.length > 0
            ? [
                  { group: 'Declared by this flow — wired in on install', items: declared },
                  { group: 'Ticket types in this server', items: guildOptions },
              ]
            : guildOptions;

    return (
        <>
            <Select
                label={field.label}
                description={field.description}
                placeholder={field.optional ? 'Any type' : 'Pick a ticket type'}
                error={error}
                data={options}
                value={current}
                onChange={(next) => {
                    const resourceKey = next ? parseDeclaredOption(next) : undefined;
                    if (resourceKey) {
                        // The key arrives at install. Removed rather than blanked, so an
                        // optional field is not left holding a value its schema refuses.
                        context.setConfigKey(resourceKeyField, resourceKey);
                        onChange(undefined);
                        return;
                    }
                    context.setConfigKey(resourceKeyField, undefined);
                    onChange(next ?? (field.optional ? undefined : ''));
                }}
                searchable
                clearable={field.optional ?? false}
                nothingFoundMessage="No ticket types match"
                allowDeselect={false}
            />
            {declaredKey ? (
                <Text size="11px" c="yellow" mt={4}>
                    Wired in when this flow&apos;s resources are installed — it stays off until then.
                </Text>
            ) : null}
            {stale ? (
                <Text size="11px" c="yellow" mt={4}>
                    This server doesn&apos;t declare a &ldquo;{picked}&rdquo; ticket type any more. Pick one it
                    does, or add it back on the tickets page.
                </Text>
            ) : null}
            {offered.length === 0 && declared.length === 0 && !stale ? (
                <Text size="11px" c="dimmed" mt={4}>
                    This server has no ticket types yet — set some up on the tickets page, then pick one here.
                </Text>
            ) : null}
        </>
    );
}
