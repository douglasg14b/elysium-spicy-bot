/**
 * Whether a journey's server objects are still what it declared — and putting them back.
 *
 * The third of the group header's dialogs, and the one that answers the question the
 * other two only appear to. The install chip reads the binding table, so it means
 * "install has run over this" and not "everything it made is still there"; the
 * inventory lists what exists and what may be deleted. Neither asks whether the
 * channel install created is still named what it was, still inside its category, or
 * still invisible to everyone but staff.
 *
 * Until this existed, nothing did. `buildInstallPlan` decides `reuse` on existence
 * alone, so a channel renamed, dragged out of its category and stripped of every
 * overwrite reported a clean reuse forever — and the permission half of that is why
 * this is a defect rather than untidiness, since a journey's stated value is often
 * "only staff can see this".
 *
 * ## Two questions on one screen
 *
 * Drift and orphans are genuinely different: drift is about things we still want and
 * an orphan is one we have and no longer asked for, which is why the repair button has
 * nothing to say about the second. They share this dialog anyway because they share an
 * operator's question — *is my server still what I asked for* — and answering half of
 * it on a screen that looks complete is worse than two screens.
 *
 * ## Why repair is not behind a red confirm
 *
 * `TeardownActions` arms its destructive button in place because deletion cannot be
 * walked back. Repair is the opposite: it writes the declaration the operator already
 * authored back over a change they did not make, and every resource it will touch is
 * listed with its own sentence directly above the button. The dangerous direction here
 * is an operator who does *not* repair, so the flow is deliberately one click.
 *
 * Forgetting a record is single-click for the same reason with a caveat: it deletes
 * nothing in the server, so the worst case is a row an operator has to reinstall. The
 * one case where it loses real information — a never-settled row with a live object —
 * is called out above the list rather than gated, because gating it would slow the
 * routine case to protect the rare one.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Center, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { ApiError } from '../api/client';
import { forgetJourneyOrphan, getJourneyDrift, repairJourneyDrift } from '../api/journeys';
import type { JourneyDrift } from '../api/types';
import {
    driftHeadline,
    hasFindings,
    hasRepairable,
    repairableKeys,
    repairLabel,
    riskyOrphans,
    summariseForget,
    summariseRepair,
    whyNotRepairable,
} from './driftSummary';
import { withEmphasis } from './publishedInventory';
import { RESOURCE_KIND_STYLES } from './resourceMeta';

interface JourneyDriftDialogProps {
    readonly opened: boolean;
    readonly onClose: () => void;
    readonly guildId: string;
    readonly journeyKey: string;
    readonly journeyName: string;
    /**
     * Told after a repair or a forget, so the page can re-read its list.
     *
     * A repair can change a resource's name, and the group header shows names.
     */
    readonly onChanged?: () => void;
}

export function JourneyDriftDialog({
    opened,
    onClose,
    guildId,
    journeyKey,
    journeyName,
    onChanged,
}: JourneyDriftDialogProps) {
    /** `null` while loading — distinct from a loaded-and-clean result. */
    const [drift, setDrift] = useState<JourneyDrift | null>(null);
    /**
     * Why the check failed, when it did.
     *
     * A third state beside loading and loaded, for the same reason
     * `JourneyResourcesDialog` keeps one: an empty state here would assert that
     * everything matches at the exact moment we could not find out, on the screen whose
     * only job is answering that.
     */
    const [loadError, setLoadError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async (): Promise<JourneyDrift | null> => {
        try {
            const next = await getJourneyDrift(guildId, journeyKey);
            setLoadError(null);
            return next;
        } catch (err) {
            setLoadError(
                err instanceof ApiError
                    ? err.message
                    : "Couldn't check this journey against your server."
            );
            return null;
        }
    }, [guildId, journeyKey]);

    useEffect(() => {
        if (!opened) {
            setDrift(null);
            setLoadError(null);
            return;
        }

        let cancelled = false;
        void (async () => {
            const next = await refresh();
            if (!cancelled) setDrift(next);
        })();
        return () => {
            cancelled = true;
        };
    }, [opened, refresh]);

    /** Put every repairable finding back to what the journey declares. */
    async function handleRepair() {
        if (!drift) return;

        const keys = repairableKeys(drift);
        if (keys.length === 0) {
            // Never a silent click. Reachable when the report changes between render
            // and press, and a button that does nothing visible reads as a broken one.
            const report = summariseRepair([]);
            notifications.show({
                color: report.color,
                title: report.title,
                message: report.message,
            });
            return;
        }

        setBusy(true);
        try {
            const { results } = await repairJourneyDrift(guildId, journeyKey, keys);
            const report = summariseRepair(results);
            notifications.show({
                color: report.color,
                title: report.title,
                message: report.message,
            });

            // A failed re-read leaves the last report on screen rather than blanking
            // it: the notification above already said what happened, and an empty
            // report would contradict it.
            //
            // Guarded on the key, because these handlers are plain async functions and
            // are *not* torn down when the dialog closes — unlike the mount effect. An
            // operator who acts on one journey, presses Done and opens another would
            // otherwise see the first journey's report under the second one's title,
            // which the header renders from props and could not contradict.
            const next = await refresh();
            if (next && next.journeyKey === journeyKey) setDrift(next);
            onChanged?.();
        } catch (err) {
            notifications.show({
                color: 'red',
                title: 'Nothing changed',
                message: err instanceof ApiError ? err.message : "Couldn't repair those resources.",
            });
        } finally {
            setBusy(false);
        }
    }

    /** Drop the record of one resource the journey no longer declares. */
    async function handleForget(bindingId: number) {
        setBusy(true);
        try {
            const result = await forgetJourneyOrphan(guildId, journeyKey, bindingId);
            const report = summariseForget(result);
            notifications.show({
                color: report.color,
                title: report.title,
                message: report.message,
            });

            const next = await refresh();
            if (next) setDrift(next);
            onChanged?.();
        } catch (err) {
            notifications.show({
                color: 'red',
                title: 'Still tracked',
                message: err instanceof ApiError ? err.message : "Couldn't remove that record.",
            });
        } finally {
            setBusy(false);
        }
    }

    const risky = drift ? riskyOrphans(drift.orphans) : [];

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={`Is ${journeyName} still what you asked for?`}
            // Same width as the inventory: a resource name and its reason have to
            // coexist, and the server's sentences name channels.
            size="lg"
        >
            <Stack gap="md">
                {!drift && !loadError && (
                    <Group gap="xs">
                        <Loader size="xs" color="brand" />
                        <Text size="13px" c="dimmed">
                            Comparing your server against what this journey declares…
                        </Text>
                    </Group>
                )}

                {!drift && loadError && (
                    <Text size="13.5px" c="orange.4">
                        {loadError} Close this and try again.
                    </Text>
                )}

                {drift && (
                    <Text size="13.5px" c={hasFindings(drift) ? 'bright' : 'dimmed'}>
                        {driftHeadline(drift)}
                    </Text>
                )}

                {drift && drift.drifted.length > 0 && (
                    <Stack gap="xs">
                        {drift.drifted.map((resource) => (
                            <DriftRow key={resource.resourceKey} resource={resource} />
                        ))}
                    </Stack>
                )}

                {/*
                 * Neither clean nor drifted, and said so. A resource whose permissions
                 * could not be compared is the one case where silence would certify
                 * something nobody looked at.
                 */}
                {drift && drift.unchecked.length > 0 && (
                    <Stack gap={6}>
                        <Text size="12px" fw={700} c="dimmed" tt="uppercase">
                            Not checked
                        </Text>
                        {drift.unchecked.map((entry) => (
                            <Text key={entry.resourceKey} size="13px" c="dimmed">
                                <Text span fw={700} c="bright" inherit>
                                    {entry.name}
                                </Text>
                                {' — '}
                                {entry.reason}
                            </Text>
                        ))}
                    </Stack>
                )}

                {drift && drift.orphans.length > 0 && (
                    <Stack gap="xs">
                        <Text size="12px" fw={700} c="dimmed" tt="uppercase">
                            No longer declared
                        </Text>

                        {/*
                         * Named above the list rather than gating each row. Forgetting
                         * a never-settled record with a live object behind it is the
                         * one case that loses the only pointer to a real channel.
                         */}
                        {risky.length > 0 && (
                            <Alert
                                color="orange"
                                variant="light"
                                icon={<IconAlertTriangle size={15} />}
                                p="xs"
                            >
                                <Text size="12.5px">
                                    Some of these were never finished installing but have
                                    something matching them in your server. Check those before
                                    removing the record — nothing will track them afterwards.
                                </Text>
                            </Alert>
                        )}

                        {drift.orphans.map((orphan) => (
                            <Group
                                key={orphan.bindingId}
                                gap="sm"
                                wrap="nowrap"
                                align="flex-start"
                                px={12}
                                py={9}
                                style={{
                                    background: 'var(--mantine-color-dark-8)',
                                    border: '1px solid var(--mantine-color-dark-6)',
                                    borderRadius: 8,
                                }}
                            >
                                <Text size="13px" c="dimmed" style={{ flex: 1 }}>
                                    {withEmphasis(orphan.explanation)}
                                </Text>
                                <Button
                                    size="compact-xs"
                                    variant="light"
                                    color="gray"
                                    disabled={busy}
                                    onClick={() => void handleForget(orphan.bindingId)}
                                >
                                    Stop tracking
                                </Button>
                            </Group>
                        ))}
                    </Stack>
                )}

                <Group gap="sm" mt={4}>
                    <Button
                        size="xs"
                        variant="subtle"
                        color="gray"
                        onClick={onClose}
                        disabled={busy}
                        ml="auto"
                    >
                        Done
                    </Button>
                    {drift && hasRepairable(drift) && (
                        <Button
                            size="xs"
                            color="brand"
                            loading={busy}
                            onClick={() => void handleRepair()}
                        >
                            {repairLabel(repairableKeys(drift).length)}
                        </Button>
                    )}
                </Group>
            </Stack>
        </Modal>
    );
}

/**
 * One drifted resource: what it is, every way it differs, and why it may be left alone.
 *
 * Each drift gets its own line. A channel renamed *and* dragged out of its category is
 * two independent findings, and running them together as a paragraph would hide that
 * repairing fixes both.
 */
function DriftRow({
    resource,
}: {
    readonly resource: JourneyDrift['drifted'][number];
}) {
    const style = RESOURCE_KIND_STYLES[resource.kind as keyof typeof RESOURCE_KIND_STYLES];
    const Icon = style?.icon;
    const color = style?.color ?? 'gray';
    const withheld = whyNotRepairable(resource);

    return (
        <Stack
            gap={5}
            px={12}
            py={9}
            style={{
                background: 'var(--mantine-color-dark-8)',
                border: '1px solid var(--mantine-color-dark-6)',
                // Amber rather than red: this is a divergence to reconcile, not a
                // deletion. The inventory's red edge means something is about to go.
                borderLeft: `3px solid var(--mantine-color-${withheld ? 'dark-5' : 'orange-6'})`,
                borderRadius: 8,
            }}
        >
            <Group gap={10} wrap="nowrap" align="center">
                {Icon && (
                    <Center
                        w={21}
                        h={21}
                        style={{
                            flex: 'none',
                            borderRadius: 5,
                            background: `var(--mantine-color-${color}-light)`,
                            color: `var(--mantine-color-${color}-4)`,
                        }}
                    >
                        <Icon size={13} />
                    </Center>
                )}
                <Text size="13.5px" fw={650} c="bright" truncate>
                    {resource.name}
                </Text>
                {withheld && (
                    <Badge size="xs" variant="light" color="gray" style={{ flex: 'none' }}>
                        left alone
                    </Badge>
                )}
            </Group>

            {resource.drift.map((detail, index) => (
                <Text key={`${detail.kind}-${index}`} size="13px" c="dimmed">
                    {withEmphasis(detail.explanation)}
                </Text>
            ))}

            {withheld && (
                <Text size="12.5px" c="dimmed" fs="italic">
                    {withheld}
                </Text>
            )}
        </Stack>
    );
}
