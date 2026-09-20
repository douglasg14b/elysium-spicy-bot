/**
 * An ordered list of short strings the author types — the first control here
 * whose value is not a scalar.
 *
 * Every edit emits a **whole new array** rather than mutating the current one:
 * the value lands in React state via `updateNodeConfig`, which compares by
 * reference, so an in-place edit would be a change the canvas never redraws.
 */

import { ActionIcon, Button, Stack, Text, TextInput } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { asTextList, type ControlProps } from './types';
import type { BlockConfigField } from '../../api/types';

type TextListField = Extract<BlockConfigField, { control: 'textList' }>;

/**
 * The advice under the control: the field's own description, plus whatever the
 * current list needs the author to know.
 *
 * Two additions, both only when they apply. A list below `minEntries` says so; a
 * list at `maxEntries` does not, because the "add" button is simply gone, which
 * says the same thing without spending a line on it.
 *
 * `dropped` is the one that would otherwise be invisible. A stored list holding
 * a non-string — which only the API can produce, since this control cannot type
 * one — renders fewer rows than the graph holds, and without this the author
 * sees a row count that silently disagrees with what saves.
 */
function describe(field: TextListField, count: number, dropped: number): string | undefined {
    const parts = [field.description];

    if (field.minEntries !== undefined && count < field.minEntries) {
        parts.push(`Needs at least ${field.minEntries}.`);
    }

    if (dropped > 0) {
        parts.push(
            `Ignoring ${dropped} ${dropped === 1 ? 'entry' : 'entries'} this control can't edit; ` +
                'editing any row here drops them.'
        );
    }

    const advice = parts.filter(Boolean).join(' ');
    return advice || undefined;
}

/**
 * A list of short strings, one row per entry.
 *
 * An empty list writes `[]` rather than removing the key: unlike an `optional`
 * duration, where absence is a real setting, a block declaring this control
 * always wants an array — its schema says so — and removing the key would make
 * the save fail on a field the author had merely emptied.
 */
export function TextListControl({ field, value, onChange, error }: ControlProps<TextListField>) {
    const entries = asTextList(value);
    const atCapacity = field.maxEntries !== undefined && entries.length >= field.maxEntries;
    const dropped = (Array.isArray(value) ? value.length : entries.length) - entries.length;
    const advice = describe(field, entries.length, dropped);

    const replace = (index: number, next: string) =>
        onChange(entries.map((entry, position) => (position === index ? next : entry)));

    const remove = (index: number) => onChange(entries.filter((_entry, position) => position !== index));

    return (
        <Stack gap={6}>
            <Text size="12px" fw={700}>
                {field.label}
            </Text>

            {entries.map((entry, index) => (
                <TextInput
                    /*
                     * Keyed by position because that is what an entry *is* here —
                     * these strings carry no identity of their own, and two rows
                     * holding the same text are genuinely interchangeable, so
                     * there is nothing else to key on short of inventing an id.
                     *
                     * The cost is small but not nil: on a removal React reuses
                     * each later row's DOM node rather than remounting it, so a
                     * caret sitting in a row below the deleted one keeps its
                     * element — and its text shifts up under it, resetting the
                     * caret to the end of the line. On single-line inputs that is
                     * the whole of it.
                     */
                    key={index}
                    placeholder={field.placeholder}
                    maxLength={field.maxLength}
                    value={entry}
                    onChange={(event) => replace(index, event.currentTarget.value)}
                    rightSection={
                        <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="sm"
                            aria-label={`Remove entry ${index + 1}`}
                            onClick={() => remove(index)}
                        >
                            <IconTrash size={14} />
                        </ActionIcon>
                    }
                />
            ))}

            {!atCapacity && (
                <Button
                    variant="subtle"
                    size="compact-xs"
                    leftSection={<IconPlus size={13} />}
                    onClick={() => onChange([...entries, ''])}
                    style={{ alignSelf: 'flex-start' }}
                >
                    {field.addLabel ?? 'Add'}
                </Button>
            )}

            {/*
             * Under the list rather than on a row: an issue reaching this control
             * is about the list as a whole (too few entries, too many), because an
             * issue about one entry arrives on a path naming its index and the
             * inspector renders those at node level instead.
             */}
            {error && (
                <Text size="11.5px" c="red.6">
                    {error}
                </Text>
            )}

            {advice && (
                <Text size="11.5px" c={dropped > 0 ? 'yellow.5' : 'dimmed'}>
                    {advice}
                </Text>
            )}
        </Stack>
    );
}
