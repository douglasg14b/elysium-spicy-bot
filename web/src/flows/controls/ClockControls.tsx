/**
 * The two clock-shaped controls: a time of day, and days of the week.
 *
 * Both generic — what the time or the days are *for* is the block's business. A time of
 * day is always on the server's clock, so its control says which zone that is, and asks
 * for one the way Server Settings does while none is picked.
 */

import { Anchor, Chip, Group, SegmentedControl, Select, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import type { BlockConfigField } from '../../api/types';
import { timeZoneGenericName } from '../../format/timeZones';
import { DAYS_OF_WEEK, fromTwelveHour, toTwelveHour, type ClockPeriod, type TwelveHourTime } from '../clockValues';
import { asTextList, type ControlProps, type ServerTimeZone } from './types';

type TimeOfDayField = Extract<BlockConfigField, { control: 'timeOfDay' }>;
type DaysOfWeekField = Extract<BlockConfigField, { control: 'daysOfWeek' }>;

const HOURS = Array.from({ length: 12 }, (_unused, index) => String(index + 1));
const MINUTES = Array.from({ length: 60 }, (_unused, index) => String(index).padStart(2, '0'));
const PERIODS: ClockPeriod[] = ['AM', 'PM'];

/** Where an unset part starts from when the author picks another: midnight, 12:00 AM. */
const MIDNIGHT: TwelveHourTime = { hour: 12, minute: 0, period: 'AM' };

/**
 * A time of day on a 12-hour clock — hour, minute, AM/PM — stored as 24-hour `HH:MM`.
 *
 * Three parts rather than a time input, because the browser decides whether a native one
 * shows 12 or 24 hours, and the dashboard reads times on a 12-hour clock. Any minute,
 * searchable, not five-minute steps.
 *
 * An unset value shows empty parts rather than the default: a time drawn on screen that
 * the node does not hold is one the save would then refuse.
 */
export function TimeOfDayControl({ field, value, onChange, context, error }: ControlProps<TimeOfDayField>) {
    const time = toTwelveHour(value);
    const emit = (change: Partial<TwelveHourTime>): void => onChange(fromTwelveHour({ ...(time ?? MIDNIGHT), ...change }));

    return (
        <div>
            <Text size="12px" fw={700} mb={4}>
                {field.label}
            </Text>
            <Group gap="xs" align="center" wrap="nowrap">
                <Select
                    aria-label={`${field.label} hour`}
                    placeholder="Hour"
                    data={HOURS}
                    value={time ? String(time.hour) : null}
                    onChange={(next) => {
                        if (next) emit({ hour: Number(next) });
                    }}
                    allowDeselect={false}
                    error={Boolean(error)}
                    w={76}
                />
                <Text c="dimmed" fw={700}>
                    :
                </Text>
                <Select
                    aria-label={`${field.label} minute`}
                    placeholder="Min"
                    data={MINUTES}
                    value={time ? String(time.minute).padStart(2, '0') : null}
                    onChange={(next) => {
                        if (next) emit({ minute: Number(next) });
                    }}
                    searchable
                    allowDeselect={false}
                    error={Boolean(error)}
                    w={80}
                />
                <SegmentedControl
                    aria-label={`${field.label} AM or PM`}
                    size="xs"
                    color="brand"
                    data={PERIODS}
                    value={time?.period ?? 'AM'}
                    onChange={(next) => emit({ period: next === 'PM' ? 'PM' : 'AM' })}
                />
            </Group>
            {/* By hand, under all three parts: the message is about the time, not one part. */}
            {error ? (
                <Text size="11.5px" c="red.6" mt={4}>
                    {error}
                </Text>
            ) : null}
            {context.serverTimeZone ? <ServerTimeLine zone={context.serverTimeZone} /> : null}
            {field.description ? (
                <Text size="11.5px" c="dimmed" mt={4}>
                    {field.description}
                </Text>
            ) : null}
        </div>
    );
}

/**
 * Which clock the time is on: the server's zone, or — while none is picked — the ask
 * Server Settings makes, with the way there.
 */
function ServerTimeLine({ zone }: { zone: ServerTimeZone }) {
    if (zone.timeZone) {
        return (
            <Text size="11.5px" c="dimmed" mt={4}>
                Server time: {zone.timeZone}
            </Text>
        );
    }

    return (
        <Text size="11.5px" c="yellow.5" mt={4}>
            Not set: using {timeZoneGenericName(zone.defaultTimeZone, new Date())} until you pick one in{' '}
            <Anchor component={Link} to="/settings" size="11.5px">
                Server Settings
            </Anchor>
            .
        </Text>
    );
}

/**
 * Any of the seven days, Monday first, as chips. Stored as a list of `'mon'` … `'sun'`,
 * always in week order — so picking the same days in another order writes the same value.
 */
export function DaysOfWeekControl({ field, value, onChange, error }: ControlProps<DaysOfWeekField>) {
    const picked = asTextList(value);

    return (
        <div>
            <Text size="12px" fw={700} mb={4}>
                {field.label}
            </Text>
            <Chip.Group
                multiple
                value={picked}
                onChange={(next) => onChange(DAYS_OF_WEEK.map((day) => day.value).filter((day) => next.includes(day)))}
            >
                <Group gap={6}>
                    {DAYS_OF_WEEK.map((day) => (
                        <Chip key={day.value} value={day.value} size="xs" color="brand">
                            {day.label}
                        </Chip>
                    ))}
                </Group>
            </Chip.Group>
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
