/**
 * The batch being uploaded, one row a file: waiting, on its way, kept, or refused in the
 * server's words. Finished rows stay until cleared, so a refusal is not gone before it is read.
 *
 * The list is a live region, mounted even while empty: a region that appears together with its
 * first row is often not announced at all. Each row is read whole — the file and where it has
 * got to — when its state changes.
 */

import { Box, Button, Group, Loader, Text } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import type { QueuedUpload, QueuedUploadState } from './useUploadQueue';

interface UploadQueueListProps {
    readonly entries: readonly QueuedUpload[];
    readonly busy: boolean;
    readonly onClear: () => void;
}

function Kept({ children }: { readonly children: string }) {
    return (
        <Group gap={6} wrap="nowrap">
            <IconCheck size={14} color="var(--mantine-color-teal-5)" style={{ flex: 'none' }} />
            <Text size="12.5px" c="teal.5">
                {children}
            </Text>
        </Group>
    );
}

function StateLine({ state }: { readonly state: QueuedUploadState }) {
    switch (state.kind) {
        case 'waiting':
            return (
                <Text size="12.5px" c="dark.3">
                    Waiting its turn
                </Text>
            );
        case 'sending':
            return (
                <Group gap={6} wrap="nowrap">
                    <Loader size={12} color="brand" />
                    <Text size="12.5px" c="dark.2">
                        Uploading…
                    </Text>
                </Group>
            );
        case 'kept':
            return <Kept>Kept</Kept>;
        case 'alreadyHeld':
            return <Kept>{`Already had this one, as ${state.keptAs}`}</Kept>;
        case 'refused':
            return (
                <Group gap={6} wrap="nowrap" align="flex-start">
                    <IconX size={14} color="var(--mantine-color-red-5)" style={{ flex: 'none', marginTop: 2 }} />
                    <Text size="12.5px" c="red.4" lh={1.45}>
                        {state.sentence}
                    </Text>
                </Group>
            );
    }
}

export function UploadQueueList({ entries, busy, onClear }: UploadQueueListProps) {
    return (
        <>
            <Box
                component="ul"
                aria-label="Pictures being uploaded"
                aria-live="polite"
                mx={0}
                mb={0}
                // Empty, it takes no room: no margin, no rows. Still in the page, so still a live region.
                mt={entries.length > 0 ? 14 : 0}
                p={0}
                style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}
            >
                {entries.map((entry) => (
                    <Box
                        component="li"
                        key={entry.id}
                        aria-label={entry.fileName}
                        aria-atomic="true"
                        bg="dark.7"
                        px={12}
                        py={7}
                        style={{ border: '1px solid var(--mantine-color-dark-5)', borderRadius: 'var(--mantine-radius-md)' }}
                    >
                        <Group gap={12} wrap="nowrap" align="flex-start">
                            <Text size="13px" fw={600} truncate style={{ flex: '0 1 220px', minWidth: 0 }} title={entry.fileName}>
                                {entry.fileName}
                            </Text>
                            <Box style={{ flex: 1, minWidth: 0 }}>
                                <StateLine state={entry.state} />
                            </Box>
                        </Group>
                    </Box>
                ))}
            </Box>
            {entries.length > 0 ? (
                <Group justify="flex-end" mt={6}>
                    {/* Mounted while the batch runs, so a focused Clear keeps its focus; it does nothing until the batch ends. */}
                    <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        aria-label={busy ? 'Clear finished uploads, once the batch is done' : 'Clear finished uploads'}
                        onClick={busy ? undefined : onClear}
                    >
                        Clear
                    </Button>
                </Group>
            ) : null}
        </>
    );
}
