/**
 * Delete one picture — or, when something still shows it, say so and list each place.
 *
 * Which of the two it opens as is the page's list, which may be out of date: the server
 * checks again and answers 409 with the places it found, and the dialog turns into the
 * refusal with the server's list. The server decides; the page never deletes on its own say-so.
 *
 * Nothing here is ever `disabled` while the delete travels — a focused button that goes
 * disabled drops focus to the page, out of the dialog, under HTML's focus fixup rule. Delete
 * says "Deleting…" and ignores a second click; the dialog holds still until the answer lands.
 * When a 409 swaps the focused Delete for the refusal, focus goes to the refusal's Close.
 */

import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
    ApiError,
    deleteGuildUploadMutation,
    listGuildUploadsQueryKey,
    type GuildUploadListing,
    type ListGuildUploadsResponse,
    type UploadUse,
} from '@brattybot/web-sdk';
import { uploadImageUrl } from '../api/uploadImageUrl';
import { writeSavedAnswer } from '../api/writeSavedAnswer';
import { formatByteSize } from '../format/byteSize';
import { withoutUpload } from './keepGuildUpload';
import { UPLOAD_NOT_FOUND_SENTENCE } from './serverSentences';
import { UploadUses } from './UploadUses';

/** How the dialog ended: the picture is still there, or it is gone (deleted here, or already). */
export type DeleteUploadOutcome = 'kept' | 'gone';

interface DeleteUploadDialogProps {
    readonly guildId: string;
    /** The picture as the page listed it when Delete was pressed. */
    readonly upload: GuildUploadListing;
    readonly viewerId: string | undefined;
    readonly onClose: (outcome: DeleteUploadOutcome) => void;
}

/** What the server said when it would not delete. */
interface Refusal {
    readonly sentence: string;
    /** The places the server found, on a 409. */
    readonly uses: readonly UploadUse[];
}

export function DeleteUploadDialog({ guildId, upload, viewerId, onClose }: DeleteUploadDialogProps) {
    const queryClient = useQueryClient();
    const listKey = listGuildUploadsQueryKey({ path: { guildId } });
    const remove = useMutation(deleteGuildUploadMutation());
    const deleting = remove.isPending;
    // `isPending` reaches a render a tick late; a second click inside that tick reads this instead.
    const inFlight = useRef(false);
    const closeButton = useRef<HTMLButtonElement>(null);
    const [refusal, setRefusal] = useState<Refusal | null>(null);

    // The server's list after a 409, else the page's.
    const uses = refusal && refusal.uses.length > 0 ? refusal.uses : upload.uses;
    const inUse = uses.length > 0;

    useEffect(() => {
        if (refusal && inUse) closeButton.current?.focus();
    }, [refusal, inUse]);

    /** Take the picture off the cached list at once, then have the server's list over it. */
    async function dropFromList(): Promise<void> {
        await writeSavedAnswer<ListGuildUploadsResponse | undefined>(
            queryClient,
            listKey,
            (listed) => listed && withoutUpload(listed, upload.uploadId)
        );
        void queryClient.invalidateQueries({ queryKey: listKey });
    }

    async function handleDelete(): Promise<void> {
        if (inFlight.current) return;
        inFlight.current = true;
        setRefusal(null);
        try {
            await remove.mutateAsync({ path: { guildId, uploadId: upload.uploadId } });
            await dropFromList();
            notifications.show({
                color: 'brand',
                title: 'Gone',
                message: `${upload.fileName} has been shown the door.`,
            });
            onClose('gone');
        } catch (error) {
            if (error instanceof ApiError && error.status === 404 && error.message === UPLOAD_NOT_FOUND_SENTENCE) {
                // Somebody beat us to it: what was asked for is done, so the dialog has nothing left to ask.
                await dropFromList();
                notifications.show({ color: 'gray', title: 'Already gone', message: error.message });
                onClose('gone');
                return;
            }
            // A 409 means the page's list was out of date; anything else may have changed it too.
            void queryClient.invalidateQueries({ queryKey: listKey });
            setRefusal(
                error instanceof ApiError
                    ? { sentence: error.message, uses: error.uses }
                    : { sentence: "Couldn't reach the server to delete that. Try again in a second.", uses: [] }
            );
        } finally {
            inFlight.current = false;
        }
    }

    const preview = (
        <Box
            component="img"
            src={uploadImageUrl({ guildId, uploadId: upload.uploadId })}
            alt=""
            w={54}
            h={54}
            style={{ borderRadius: 8, objectFit: 'cover', flex: 'none', display: 'block' }}
        />
    );

    return (
        <Modal
            opened
            // Held open while the delete travels, so its answer lands where it was asked.
            onClose={() => {
                if (!deleting) onClose('kept');
            }}
            title={inUse ? `Can't delete ${upload.fileName}` : `Delete ${upload.fileName}?`}
            size="md"
        >
            {inUse ? (
                <Stack gap={12}>
                    <Group gap={12} wrap="nowrap">
                        {preview}
                        <Text size="13.5px" c="red.5" fw={700} lh={1.45} role={refusal ? 'alert' : undefined}>
                            {refusal ? refusal.sentence : 'Still in use — swap it out of these first:'}
                        </Text>
                    </Group>
                    <UploadUses uses={uses} viewerId={viewerId} label={`Where ${upload.fileName} is used`} />
                    <Group justify="flex-end" mt="xs">
                        <Button ref={closeButton} variant="subtle" color="gray" onClick={() => onClose('kept')}>
                            Close
                        </Button>
                    </Group>
                </Stack>
            ) : (
                <Stack gap={12}>
                    <Group gap={12} wrap="nowrap">
                        {preview}
                        <Text size="13.5px" c="dark.1">
                            {formatByteSize(upload.byteSize)} · nothing uses it.
                        </Text>
                    </Group>
                    <Text size="12.5px" c="dark.2" lh={1.5}>
                        Messages the bot already posted keep their copy — Discord holds it, not us.
                    </Text>
                    {refusal ? (
                        <Alert color="red" variant="light" p="xs">
                            <Text size="13px">{refusal.sentence}</Text>
                        </Alert>
                    ) : null}
                    <Group justify="flex-end" mt="xs">
                        <Button variant="subtle" color="gray" onClick={deleting ? undefined : () => onClose('kept')}>
                            Keep it
                        </Button>
                        <Button
                            color="red"
                            aria-busy={deleting}
                            leftSection={deleting ? <Loader size={14} color="white" /> : undefined}
                            onClick={() => void handleDelete()}
                        >
                            {deleting ? 'Deleting…' : 'Delete'}
                        </Button>
                    </Group>
                </Stack>
            )}
        </Modal>
    );
}
