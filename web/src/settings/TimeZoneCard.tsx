import { useMemo, useState } from 'react';
import { Alert, Button, Card, Group, Select, Stack, Text } from '@mantine/core';
import type { OptionsFilter } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconClock } from '@tabler/icons-react';
import { ApiError } from '../api/client';
import { updateGuildTimeZone } from '../api/config';
import type { GuildSettings } from '../api/types';
import {
    browserTimeZoneSpelling,
    timeZoneGenericName,
    timeZoneLabelMatches,
    timeZoneOptions,
} from '../format/timeZones';

export interface TimeZoneCardProps {
    readonly guildId: string;
    /** The server's saved settings; the card's draft starts from `timeZone`. */
    readonly settings: GuildSettings;
    /**
     * Called after a successful save with the guild it was for and the zone the server
     * stored — only the field this card owns, so a late answer cannot bring back an old
     * value of anything else on the page.
     */
    readonly onSaved: (guildId: string, timeZone: string | null) => void;
}

/** A saved zone as this browser spells it; `null` (not picked) stays `null`. */
function inThisBrowser(timeZone: string | null): string | null {
    return timeZone ? browserTimeZoneSpelling(timeZone) : null;
}

/** Mantine's filter with the search folded the way operators type; see `timeZoneLabelMatches`. */
const timeZoneFilter: OptionsFilter = ({ options, search }) =>
    options.filter((option) => 'label' in option && timeZoneLabelMatches(option.label, search));

/**
 * The server's time zone: a searchable picker, and an ask while none is picked.
 *
 * Its own form with its own Save and its own route, so saving it never submits — or
 * wipes — the staff roles beside it. The ask is driven by the **saved** zone, not the
 * draft: picking an option is not choosing until it is saved.
 */
export function TimeZoneCard({ guildId, settings, onSaved }: TimeZoneCardProps) {
    const [timeZone, setTimeZone] = useState<string | null>(() => inThisBrowser(settings.timeZone));
    const [saving, setSaving] = useState(false);
    const [lastSaved, setLastSaved] = useState<Date | null>(null);

    // The saved zone in this browser's own spelling, so it is one entry in the picker
    // and an answer spelled differently from what was sent still reads as saved.
    const savedTimeZone = useMemo(() => inThisBrowser(settings.timeZone), [settings.timeZone]);
    const options = useMemo(() => timeZoneOptions(savedTimeZone, new Date()), [savedTimeZone]);
    const pristine = timeZone === savedTimeZone;
    // No unset action: once a zone is picked, the server changes zones but never goes
    // back to "not set", so there is nothing to save until one is chosen.
    const canSave = !!timeZone && !pristine && !saving;

    async function handleSave() {
        if (!timeZone) return;
        const sent = timeZone;
        setSaving(true);
        try {
            const updated = await updateGuildTimeZone(guildId, sent);
            onSaved(guildId, updated.timeZone);
            // What the server stored, in this browser's spelling — unless the operator
            // picked again while this was in flight, which is kept.
            setTimeZone((current) => (current === sent ? inThisBrowser(updated.timeZone) : current));
            setLastSaved(new Date());
            notifications.show({
                color: 'brand',
                title: 'Saved',
                message: `This server now runs on ${updated.timeZone}. The clocks have been told.`,
            });
        } catch (err) {
            const message =
                err instanceof ApiError ? err.message : "Couldn't save. Try again in a second.";
            notifications.show({ color: 'red', title: "Couldn't save", message });
        } finally {
            setSaving(false);
        }
    }

    return (
        <Card p="xl" maw={640}>
            <Group gap={8} mb={4}>
                <IconClock size={18} color="var(--mantine-color-brand-6)" />
                <Text fw={700} size="15px">
                    Time Zone
                </Text>
            </Group>
            <Text c="dimmed" size="13px" mb="lg">
                The clock this server runs on. Anything scheduled here happens on this
                server&apos;s time, not yours.
            </Text>

            <Stack gap="lg">
                {/* Deliberately never disabled while saving (the repo's rule against
                    disabling an input in use); a pick made mid-save is kept. */}
                <Select
                    label="Time zone"
                    placeholder="Pick a time zone"
                    data={options}
                    value={timeZone}
                    onChange={setTimeZone}
                    searchable
                    filter={timeZoneFilter}
                    allowDeselect={false}
                    nothingFoundMessage="No time zone by that name"
                />

                {settings.timeZone === null && (
                    <Alert color="yellow" variant="light" icon={<IconClock size={16} />}>
                        Not set: using {timeZoneGenericName(settings.defaultTimeZone, new Date())}{' '}
                        until you pick one.
                    </Alert>
                )}

                <Group gap="sm" mt="xs">
                    <Button color="brand" onClick={handleSave} loading={saving} disabled={!canSave}>
                        Save time zone
                    </Button>
                    <Button
                        variant="subtle"
                        color="gray"
                        onClick={() => setTimeZone(savedTimeZone)}
                        disabled={pristine || saving}
                    >
                        Cancel
                    </Button>
                    {lastSaved && (
                        <Text size="12px" c="dark.2" ml="auto">
                            Last saved {lastSaved.toLocaleTimeString()}
                        </Text>
                    )}
                </Group>
            </Stack>
        </Card>
    );
}
