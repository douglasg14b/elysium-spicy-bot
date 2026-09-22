/**
 * Which journey this flow installs, and the attach/detach that changes it.
 *
 * Sits at the top of the resources panel because it answers the question the panel's
 * whole list depends on: *whose* resources are these? A flow on a shared journey is
 * editing declarations several flows install, and the panel below is otherwise
 * indistinguishable from one editing its own.
 *
 * **Every decision it takes is imported from `journeyAttachment.ts`.** `web/` has no
 * jsdom, so anything reachable only by rendering cannot be tested; the rules that are
 * wrong *quietly* — an attach described as an addition when it is a move, a detach read
 * as an uninstall — live there where the suite can drive them.
 */

import { useState } from 'react';
import { Alert, Badge, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { IconLink, IconUnlink, IconUsers } from '@tabler/icons-react';
import type { FlowAttachment, JourneySummary } from '../api/types';
import {
    attachableJourneys,
    describeAttachIntent,
    describeDetachIntent,
} from './journeyAttachment';

interface JourneyAttachmentControlProps {
    /** The journey this flow installs, or `null` when it is attached to none. */
    attachment: FlowAttachment | null;
    /** Every journey in the guild, for the picker. */
    journeys: readonly JourneySummary[];
    /** Whether the attachment is still being fetched. */
    loading: boolean;
    onAttach: (journeyKey: string) => Promise<void>;
    onDetach: () => Promise<void>;
}

export function JourneyAttachmentControl({
    attachment,
    journeys,
    loading,
    onAttach,
    onDetach,
}: JourneyAttachmentControlProps) {
    const [attachOpen, setAttachOpen] = useState(false);
    const [detachOpen, setDetachOpen] = useState(false);
    const [picked, setPicked] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const options = attachableJourneys(journeys, attachment?.journeyKey);
    const target = options.find((journey) => journey.journeyKey === picked);
    const shared = attachment?.sharedWith ?? [];

    async function runAttach() {
        if (!picked) return;
        setBusy(true);
        try {
            await onAttach(picked);
            setAttachOpen(false);
            setPicked(null);
        } finally {
            setBusy(false);
        }
    }

    async function runDetach() {
        setBusy(true);
        try {
            await onDetach();
            setDetachOpen(false);
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Group
                justify="space-between"
                align="center"
                wrap="wrap"
                gap="sm"
                p="sm"
                style={{
                    background: 'var(--mantine-color-dark-7)',
                    border: '1px solid var(--mantine-color-dark-5)',
                    borderRadius: 10,
                }}
            >
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                    <IconLink size={18} color="var(--mantine-color-brand-5)" style={{ flex: 'none' }} />
                    <div style={{ minWidth: 0 }}>
                        {loading ? (
                            <Text size="sm" c="dimmed">
                                Checking which journey this flow installs…
                            </Text>
                        ) : attachment ? (
                            <>
                                <Text size="sm" fw={600} truncate>
                                    Installing {attachment.name}
                                </Text>
                                {shared.length > 0 && (
                                    <Group gap={6} mt={4} wrap="wrap">
                                        <IconUsers size={13} color="var(--mantine-color-dark-2)" />
                                        {/*
                                         * Named, not counted. Editing a row below changes
                                         * what these flows install too, and "shared with
                                         * 2 flows" leaves the operator to go and find
                                         * which — the density rule the refusal copy
                                         * already follows.
                                         */}
                                        <Text size="12px" c="dark.2">
                                            Shared with
                                        </Text>
                                        {shared.map((flow) => (
                                            <Badge
                                                key={flow.flowId}
                                                size="xs"
                                                variant="light"
                                                color="gray"
                                                radius="sm"
                                            >
                                                {flow.name}
                                            </Badge>
                                        ))}
                                    </Group>
                                )}
                            </>
                        ) : (
                            <Text size="sm" c="dimmed">
                                Not attached to a journey. Anything declared below becomes this
                                flow&apos;s own.
                            </Text>
                        )}
                    </div>
                </Group>

                <Group gap="xs" wrap="nowrap">
                    <Button
                        size="xs"
                        variant="light"
                        color="brand"
                        leftSection={<IconLink size={14} />}
                        disabled={loading || options.length === 0}
                        onClick={() => setAttachOpen(true)}
                    >
                        {attachment ? 'Move to journey' : 'Attach to journey'}
                    </Button>
                    {attachment && (
                        <Button
                            size="xs"
                            variant="subtle"
                            color="red"
                            leftSection={<IconUnlink size={14} />}
                            onClick={() => setDetachOpen(true)}
                        >
                            Detach
                        </Button>
                    )}
                </Group>
            </Group>

            <Modal
                opened={attachOpen}
                onClose={() => setAttachOpen(false)}
                title={attachment ? 'Move to another journey' : 'Attach to a journey'}
                size="md"
            >
                <Stack gap="md">
                    <Select
                        data-autofocus
                        label="Journey"
                        description="Only journeys in this server, and not the one this flow is already on."
                        placeholder="Pick a journey"
                        data={options.map((journey) => ({
                            value: journey.journeyKey,
                            label: `${journey.name} · ${journey.resourceCount} resource${
                                journey.resourceCount === 1 ? '' : 's'
                            }`,
                        }))}
                        value={picked}
                        onChange={setPicked}
                        searchable
                        nothingFoundMessage="No match"
                        comboboxProps={{ withinPortal: true }}
                    />

                    {/*
                     * The move warning is the whole reason this is a dialog rather than an
                     * inline picker. A flow has at most one journey, so attaching while
                     * already attached silently changes what this flow installs — and the
                     * operator would find out by watching their install plan change.
                     */}
                    {target && (
                        <Alert
                            color={attachment ? 'yellow' : 'gray'}
                            variant="light"
                            icon={<IconLink size={16} />}
                        >
                            <Text size="sm">
                                {describeAttachIntent({
                                    currentJourneyName: attachment?.name,
                                    targetJourneyName: target.name,
                                })}
                            </Text>
                        </Alert>
                    )}

                    <Group justify="flex-end" gap="sm">
                        <Button
                            variant="subtle"
                            color="gray"
                            onClick={() => setAttachOpen(false)}
                            disabled={busy}
                        >
                            Cancel
                        </Button>
                        <Button
                            color="brand"
                            loading={busy}
                            disabled={!picked}
                            onClick={() => void runAttach()}
                        >
                            {attachment ? 'Move it' : 'Attach'}
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={detachOpen}
                onClose={() => setDetachOpen(false)}
                title="Detach from journey"
                size="md"
            >
                <Stack gap="md">
                    <Text size="sm" c="dimmed">
                        {attachment
                            ? describeDetachIntent({
                                  journeyName: attachment.name,
                                  sharedWith: shared,
                              })
                            : ''}
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button
                            variant="subtle"
                            color="gray"
                            onClick={() => setDetachOpen(false)}
                            disabled={busy}
                        >
                            Cancel
                        </Button>
                        <Button
                            color="red"
                            leftSection={<IconUnlink size={16} />}
                            loading={busy}
                            onClick={() => void runDetach()}
                        >
                            Detach
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}
