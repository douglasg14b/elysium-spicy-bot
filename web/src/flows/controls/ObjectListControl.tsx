/**
 * An ordered list of records — `TextListControl` one dimension up.
 *
 * Every edit emits a **whole new array of whole new entries** rather than
 * mutating: the value lands in React state via `updateNodeConfig`, which compares
 * by reference, so an in-place edit at either level is a change the canvas never
 * redraws. That is the same rule the string list follows, and it is the one that
 * bites differently here — mutating `entries[i].name` leaves the array identical
 * by reference and the edit simply disappears.
 */

import { ActionIcon, Checkbox, Group, Paper, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { Button } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { ControlProps } from './types';
import type { BlockConfigColumn, BlockConfigField } from '../../api/types';

type ObjectListField = Extract<BlockConfigField, { control: 'objectList' }>;

/** One stored entry, as it arrives off the wire. */
type Entry = Record<string, unknown>;

/**
 * Narrow an unknown `node.data` value to a list of entries.
 *
 * Non-object members are dropped rather than coerced, matching `asTextList`: a
 * saved list holding a string got there through an API the schema rejects, and
 * showing it as an empty row would invite an author to keep a value the save will
 * not take.
 */
function asEntryList(value: unknown): Entry[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is Entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
        : [];
}

/** The current value of one column on one entry, as a string. */
function columnText(entry: Entry, column: BlockConfigColumn): string {
    const value = entry[column.key];
    return typeof value === 'string' ? value : '';
}

/** The current value of a `toggle` column, which is absent until first set. */
function columnFlag(entry: Entry, column: BlockConfigColumn): boolean {
    return entry[column.key] === true;
}

/**
 * A new, empty entry carrying every declared column.
 *
 * Every key is present from the start rather than appearing as it is typed, so a
 * row the author adds and leaves blank is the shape the schema expects to see —
 * an entry missing a required key fails the save naming a column the author never
 * knew was absent.
 */
function emptyEntry(columns: readonly BlockConfigColumn[]): Entry {
    const entry: Entry = {};
    for (const column of columns) {
        entry[column.key] = column.control === 'toggle' ? false : '';
    }
    return entry;
}

/**
 * The advice under the control. Mirrors `TextListControl`'s, including the
 * dropped-entry warning, which is the one an author cannot otherwise see.
 */
function describe(field: ObjectListField, count: number, dropped: number): string | undefined {
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

/** One column's input on one row. */
function ColumnInput({
    column,
    entry,
    index,
    onChange,
}: {
    column: BlockConfigColumn;
    entry: Entry;
    index: number;
    onChange: (key: string, value: string | boolean) => void;
}) {
    if (column.control === 'toggle') {
        return (
            <Checkbox
                label={column.label}
                size="xs"
                checked={columnFlag(entry, column)}
                onChange={(event) => onChange(column.key, event.currentTarget.checked)}
            />
        );
    }

    const shared = {
        label: column.label,
        placeholder: column.placeholder,
        /*
         * No hard cap on a column that renders tokens, for the reason
         * `TextControls.hardLimit` gives: the engine measures the string after
         * `{{subject.mention}}` expands, so a cap here would measure the wrong
         * one. The limit is stated as advice instead and enforced nameably at
         * render.
         */
        maxLength: column.rendersTokens ? undefined : column.maxLength,
        value: columnText(entry, column),
        'aria-label': `${column.label}, entry ${index + 1}`,
    };

    switch (column.control) {
        case 'longText':
            return (
                <Textarea
                    {...shared}
                    autosize
                    minRows={2}
                    maxRows={6}
                    onChange={(event) => onChange(column.key, event.currentTarget.value)}
                />
            );
        case 'text':
            return (
                <TextInput
                    {...shared}
                    onChange={(event) => onChange(column.key, event.currentTarget.value)}
                />
            );
        default: {
            // Adding a member to `BLOCK_COLUMN_CONTROLS` without drawing it here is
            // a compile error, matching `renderControl`. A fall-through to a text
            // input would render an unknown column as one silently.
            const unhandled: never = column.control;
            void unhandled;
            return null;
        }
    }
}

/**
 * A list of records, one bordered block per entry.
 *
 * An empty list writes `[]` rather than removing the key, matching `textList`: a
 * block declaring this control always wants an array, so removing the key would
 * fail the save on a field the author had merely emptied.
 */
export function ObjectListControl({ field, value, onChange }: ControlProps<ObjectListField>) {
    const entries = asEntryList(value);
    const atCapacity = field.maxEntries !== undefined && entries.length >= field.maxEntries;
    const dropped = (Array.isArray(value) ? value.length : entries.length) - entries.length;
    const advice = describe(field, entries.length, dropped);

    const editEntry = (index: number, key: string, next: string | boolean) =>
        onChange(
            entries.map((entry, position) => (position === index ? { ...entry, [key]: next } : entry))
        );

    const remove = (index: number) => onChange(entries.filter((_entry, position) => position !== index));

    return (
        <Stack gap={6}>
            <Text size="12px" fw={700}>
                {field.label}
            </Text>

            {entries.map((entry, index) => (
                /*
                 * Keyed by position for the same reason the string list is: these
                 * entries carry no identity of their own, and two rows holding the
                 * same values are genuinely interchangeable. The caret cost noted
                 * there applies here too, one input at a time.
                 */
                <Paper key={index} withBorder p={8} radius="sm">
                    <Group justify="space-between" align="flex-start" wrap="nowrap" gap={8}>
                        <Stack gap={6} style={{ flex: 1 }}>
                            {field.columns.map((column) => (
                                <ColumnInput
                                    key={column.key}
                                    column={column}
                                    entry={entry}
                                    index={index}
                                    onChange={(key, next) => editEntry(index, key, next)}
                                />
                            ))}
                        </Stack>
                        <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="sm"
                            aria-label={`Remove entry ${index + 1}`}
                            onClick={() => remove(index)}
                        >
                            <IconTrash size={14} />
                        </ActionIcon>
                    </Group>
                </Paper>
            ))}

            {!atCapacity && (
                <Button
                    variant="subtle"
                    size="compact-xs"
                    leftSection={<IconPlus size={13} />}
                    onClick={() => onChange([...entries, emptyEntry(field.columns)])}
                    style={{ alignSelf: 'flex-start' }}
                >
                    {field.addLabel ?? 'Add'}
                </Button>
            )}

            {advice && (
                <Text size="11.5px" c={dropped > 0 ? 'yellow.5' : 'dimmed'}>
                    {advice}
                </Text>
            )}
        </Stack>
    );
}
