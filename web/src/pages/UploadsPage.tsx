/**
 * Every picture the server has uploaded for its messages, how much room they take, and where
 * each is shown — with the way to add more and to delete what nothing uses.
 *
 * Reads the same cache entry as the flow builder's picture box (`listGuildUploadsOptions`), so
 * a picture added or deleted here is what the builder shows next, and one uploaded there is
 * here. The pieces live in `web/src/uploads/`; this file is wiring.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Alert, Card, Center, Group, Loader, Progress, SegmentedControl, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconPhoto } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { listGuildUploadsOptions, type GuildUploadListing } from '@brattybot/web-sdk';
import { loadErrorMessage } from '../api/loadErrorMessage';
import { useAuth } from '../auth/AuthContext';
import { formatByteSize } from '../format/byteSize';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';
import { DeleteUploadDialog, type DeleteUploadOutcome } from '../uploads/DeleteUploadDialog';
import { UploadCard } from '../uploads/UploadCard';
import { UploadDropZone } from '../uploads/UploadDropZone';
import { UploadQueueList } from '../uploads/UploadQueueList';
import { filterUploads, type UploadFilter } from '../uploads/uploadPresentation';
import { useUploadQueue } from '../uploads/useUploadQueue';

/** What each filter says when it leaves nothing. */
const NOTHING_UNDER: Readonly<Record<Exclude<UploadFilter, 'all'>, string>> = {
    inUse: "Nothing's in use. Every picture here is just sitting pretty, doing nothing for anyone.",
    unused: "Nothing unused — every picture here is earning its keep.",
};

/** Whether a drag carries files from outside the page, rather than text or a link within it. */
function carriesFiles(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes('Files') ?? false;
}

export function UploadsPage() {
    const { selected, loading: guildsLoading } = useGuilds();
    const heading = useRef<HTMLHeadingElement>(null);

    if (guildsLoading) {
        return (
            <Center mih="60vh">
                <Loader color="brand" />
            </Center>
        );
    }

    if (!selected) {
        return (
            <Alert color="gray" title="No server">
                The bot isn&apos;t in any server you can manage.
            </Alert>
        );
    }

    return (
        <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
            <div>
                <Text size="12.5px" c="dark.2">
                    <Text span c="dark.1" fw={600}>
                        {selected.name}
                    </Text>{' '}
                    › Configure › Uploads
                </Text>
                <Group gap={10} mt={4}>
                    <IconPhoto size={22} color="var(--mantine-color-brand-6)" />
                    {/* Focusable by script only: where focus lands once a deleted picture's card is gone. */}
                    <Title ref={heading} order={1} size="24px" tabIndex={-1} style={{ outline: 'none' }}>
                        Uploads
                    </Title>
                </Group>
                <Text c="dimmed" size="13.5px" mt={4} maw={760}>
                    Every picture this server has uploaded for its messages, and where each one is shown. A
                    picture that&apos;s in use can&apos;t be deleted until nothing uses it.
                </Text>
            </div>

            {/*
             * Keyed by server, so a dialog never carries over to another one. A batch stops at the
             * switch: the picture on its way finishes, the ones still waiting are not sent.
             */}
            <ServerUploads key={selected.id} guildId={selected.id} heading={heading} />
        </Stack>
    );
}

interface ServerUploadsProps {
    readonly guildId: string;
    readonly heading: RefObject<HTMLHeadingElement>;
}

/** The delete dialog's picture, and the button that opened it. */
interface DeleteTarget {
    readonly upload: GuildUploadListing;
    readonly opener: HTMLElement;
}

function ServerUploads({ guildId, heading }: ServerUploadsProps) {
    const { user } = useAuth();
    const listed = useQuery(listGuildUploadsOptions({ path: { guildId } }));
    const queue = useUploadQueue(guildId);
    const [filter, setFilter] = useState<UploadFilter>('all');
    const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
    const browse = useRef<HTMLButtonElement>(null);
    const viewerId = user?.id;

    /*
     * A file dropped beside the drop zone would otherwise be opened by the browser in place of the
     * dashboard, taking a running batch with it. Only drags carrying files: text and links dragged
     * within the page keep their own behaviour.
     */
    useEffect(() => {
        const holdFiles = (event: DragEvent) => {
            if (carriesFiles(event)) event.preventDefault();
        };
        window.addEventListener('dragover', holdFiles);
        window.addEventListener('drop', holdFiles);
        return () => {
            window.removeEventListener('dragover', holdFiles);
            window.removeEventListener('drop', holdFiles);
        };
    }, []);

    /*
     * The dialog unmounts rather than closing, so Mantine has no focus to give back: it is put back
     * here, on the card's Delete button while the picture stays, or on the heading once it is gone.
     */
    function closeDialog(outcome: DeleteUploadOutcome): void {
        const opener = deleting?.opener;
        setDeleting(null);
        const target = outcome === 'kept' && opener?.isConnected ? opener : heading.current;
        // After the dialog has left the page, so its focus trap is not still holding on.
        setTimeout(() => target?.focus(), 0);
    }

    function clearFinished(): void {
        if (queue.clearFinished()) browse.current?.focus();
    }

    const error = loadErrorMessage(listed.error, "Couldn't load this server's pictures.");
    const data = listed.data;

    return (
        <>
            <Card p="md">
                <Group gap="lg" wrap="wrap" align="center">
                    <Stack gap={7} style={{ flex: '1 1 280px' }}>
                        <Group justify="space-between" gap="xs">
                            <Text size="12.5px" c="dark.2">
                                {data ? (
                                    <>
                                        {/* Rounded down, so a server with room left never reads as full. */}
                                        <Text span fw={700} c="dark.0">
                                            {formatByteSize(data.totalBytes, 'down')}
                                        </Text>{' '}
                                        of {formatByteSize(data.limitBytes)} used
                                    </>
                                ) : (
                                    'Counting…'
                                )}
                            </Text>
                            {data ? (
                                <Text size="12.5px" c="dark.2">
                                    {data.uploads.length} {data.uploads.length === 1 ? 'picture' : 'pictures'}
                                </Text>
                            ) : null}
                        </Group>
                        <Progress
                            aria-label="Upload space used"
                            value={data ? Math.min(100, (data.totalBytes / data.limitBytes) * 100) : 0}
                            color="brand"
                            size={8}
                            radius="xl"
                        />
                    </Stack>
                    <UploadDropZone onFiles={queue.add} browseRef={browse} />
                </Group>
                <UploadQueueList entries={queue.entries} busy={queue.busy} onClear={clearFinished} />
            </Card>

            {error && !data ? (
                <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Couldn't load uploads">
                    {error}
                </Alert>
            ) : !data ? (
                <Center py="xl">
                    <Loader color="brand" size="sm" />
                </Center>
            ) : data.uploads.length === 0 ? (
                <Card py={48} px="md">
                    <Stack align="center" gap={6}>
                        <IconPhoto size={28} color="var(--mantine-color-dark-3)" />
                        <Text fw={700} size="15px">
                            No pictures yet
                        </Text>
                        <Text c="dimmed" size="13px" ta="center" maw={440}>
                            Bare walls. Drop a few pictures above, or upload them from a message in the flow
                            builder, and they&apos;ll all hang here.
                        </Text>
                    </Stack>
                </Card>
            ) : (
                <Stack gap={14}>
                    {error ? (
                        // A later read failed: what is shown is the last list that loaded, and may be behind.
                        <Text size="12.5px" c="yellow.4" role="status">
                            Couldn&apos;t refresh this list ({error}) — what you see may be out of date.
                        </Text>
                    ) : null}
                    <Group justify="space-between">
                        <SegmentedControl
                            size="xs"
                            aria-label="Show"
                            value={filter}
                            onChange={(value) => setFilter(value as UploadFilter)}
                            data={[
                                { value: 'all', label: 'All' },
                                { value: 'inUse', label: 'In use' },
                                { value: 'unused', label: 'Unused' },
                            ]}
                        />
                        <Text size="12.5px" c="dark.3">
                            Newest first
                        </Text>
                    </Group>
                    <UploadGrid
                        uploads={filterUploads(data.uploads, filter)}
                        filter={filter}
                        guildId={guildId}
                        viewerId={viewerId}
                        onDelete={(upload, opener) => setDeleting({ upload, opener })}
                    />
                </Stack>
            )}

            {deleting ? (
                <DeleteUploadDialog
                    key={deleting.upload.uploadId}
                    guildId={guildId}
                    upload={deleting.upload}
                    viewerId={viewerId}
                    onClose={closeDialog}
                />
            ) : null}
        </>
    );
}

interface UploadGridProps {
    readonly uploads: readonly GuildUploadListing[];
    readonly filter: UploadFilter;
    readonly guildId: string;
    readonly viewerId: string | undefined;
    readonly onDelete: (upload: GuildUploadListing, opener: HTMLElement) => void;
}

function UploadGrid({ uploads, filter, guildId, viewerId, onDelete }: UploadGridProps) {
    if (uploads.length === 0 && filter !== 'all') {
        return (
            <Text c="dimmed" size="13px" ta="center" py="xl">
                {NOTHING_UNDER[filter]}
            </Text>
        );
    }
    return (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing={14}>
            {uploads.map((upload) => (
                <UploadCard key={upload.uploadId} guildId={guildId} upload={upload} viewerId={viewerId} onDelete={onDelete} />
            ))}
        </SimpleGrid>
    );
}
