import { useMemo, useState } from 'react';
import { Alert, Button, Card, Group, Select, Stack, Text } from '@mantine/core';
import type { OptionsFilter } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconClock } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ApiError,
    getGuildSettingsOptions,
    getGuildSettingsQueryKey,
    updateGuildTimeZoneMutation,
    type GuildSettings,
} from '@brattybot/web-sdk';
import { useSaveInFlight } from '../api/useSaveInFlight';
import { writeSavedAnswer } from '../api/writeSavedAnswer';
import {
    browserTimeZoneSpelling,
    timeZoneGenericName,
    timeZoneLabelMatches,
    timeZoneOptions,
} from '../format/timeZones';

export interface TimeZoneCardProps {
    readonly guildId: string;
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
 * wipes — the staff roles beside it. Reads the same cached settings entry the staff form
 * does (one GET for the page), and renders nothing until that has answered: the staff
 * card carries the page's one spinner and one load error.
 */
export function TimeZoneCard({ guildId }: TimeZoneCardProps) {
    const settings = useQuery(getGuildSettingsOptions({ path: { guildId } }));
    if (!settings.data) return null;
    return <TimeZoneForm guildId={guildId} settings={settings.data} />;
}

interface TimeZoneFormProps {
    readonly guildId: string;
    /** The server's saved settings; the draft starts from `timeZone`. */
    readonly settings: GuildSettings;
}

/**
 * The picker and its Save, once the saved settings are in hand.
 *
 * The ask is driven by the **saved** zone, not the draft: picking an option is not
 * choosing until it is saved.
 */
function TimeZoneForm({ guildId, settings }: TimeZoneFormProps) {
    const queryClient = useQueryClient();
    const settingsKey = getGuildSettingsQueryKey({ path: { guildId } });
    const saveKey = [...settingsKey, 'timeZone'] as const;
    /*
     * `undefined` until the operator picks: the picker shows what is saved. A draft taken at
     * mount would go stale when a save an earlier mount left in flight lands — the form
     * would show the replaced zone as an unsaved edit, one click from putting it back.
     */
    const [draft, setDraft] = useState<string | null>();
    const [lastSaved, setLastSaved] = useState<Date | null>(null);

    const save = useMutation({
        ...updateGuildTimeZoneMutation(),
        // This card's own key under the entry it writes, so a remount mid-save still sees
        // the save, and a staff-role save beside it does not read as this one.
        mutationKey: saveKey,
        onSuccess: async (updated, variables) => {
            // Over any GET still in flight, which would otherwise put the old zone back —
            // and only the zone: the answer carries the staff roles too, as they stood when
            // this save landed, and a staff save answering after it is newer about those.
            await writeSavedAnswer(queryClient, settingsKey, (current: GuildSettings | undefined) =>
                current ? { ...current, timeZone: updated.timeZone } : updated
            );
            // Back to showing what the server stored — unless the operator picked again while
            // this was in flight, which is kept.
            setDraft((current) => (current === variables.body.timeZone ? undefined : current));
            setLastSaved(new Date());
            notifications.show({
                color: 'brand',
                title: 'Saved',
                message: `This server now runs on ${updated.timeZone}. The clocks have been told.`,
            });
        },
        onError: (err) => {
            const message = err instanceof ApiError ? err.message : "Couldn't save. Try again in a second.";
            notifications.show({ color: 'red', title: "Couldn't save", message });
        },
    });

    // The saved zone in this browser's own spelling, so it is one entry in the picker
    // and an answer spelled differently from what was sent still reads as saved.
    const savedTimeZone = useMemo(() => inThisBrowser(settings.timeZone), [settings.timeZone]);
    const options = useMemo(() => timeZoneOptions(savedTimeZone, new Date()), [savedTimeZone]);
    const timeZone = draft === undefined ? savedTimeZone : draft;
    const pristine = timeZone === savedTimeZone;
    // This card's save, this mount's or one an earlier mount left in flight.
    const saving = useSaveInFlight(saveKey);
    // No unset action: once a zone is picked, the server changes zones but never goes
    // back to "not set", so there is nothing to save until one is chosen.
    const canSave = !!timeZone && !pristine && !saving;

    function handleSave() {
        if (!timeZone) return;
        save.mutate({ path: { guildId }, body: { timeZone } });
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
                    onChange={setDraft}
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
                        onClick={() => setDraft(undefined)}
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
