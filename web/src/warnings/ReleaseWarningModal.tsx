import { useRef, useState } from 'react';
import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation } from '@tanstack/react-query';
import {
    ApiError,
    releaseWarning,
    zReleaseWarningBody,
    type Warning,
    type WarningReleaseRequest,
} from '@brattybot/web-sdk';
import { fieldProblems } from '../api/fieldProblems';
import { useWarningWriteFollowUp } from './useWarningWriteFollowUp';
import { warningPersonLabel } from './warningPresentation';

interface ReleaseWarningModalProps {
    readonly guildId: string;
    /** The warning to release, as the drawer showed it; null while the dialog is closed. */
    readonly warning: Warning | null;
    readonly onClose: () => void;
}

/**
 * Release a warning, after naming whose and for what, with the reason the record keeps
 * (`docs/plans/warnings-in-the-dashboard.md` §4.5; the `TicketsConfigPage` delete-confirm shape).
 * There is no undo, so the reason is required — the server's own rule, asked of its zod.
 *
 * Cannot be closed while the release runs, for the reason `WarningFormModal` gives.
 */
export function ReleaseWarningModal({ guildId, warning, onClose }: ReleaseWarningModalProps) {
    const [busy, setBusy] = useState(false);
    return (
        <Modal
            opened={warning !== null}
            onClose={onClose}
            title="Release warning"
            size="md"
            closeOnEscape={!busy}
            closeOnClickOutside={!busy}
            withCloseButton={!busy}
        >
            {warning && (
                <ReleaseForm guildId={guildId} warning={warning} onClose={onClose} busy={busy} onBusyChange={setBusy} />
            )}
        </Modal>
    );
}

interface ReleaseFormProps {
    readonly guildId: string;
    readonly warning: Warning;
    readonly onClose: () => void;
    /** The release and the re-read after it are running. */
    readonly busy: boolean;
    readonly onBusyChange: (busy: boolean) => void;
}

function ReleaseForm({ guildId, warning, onClose, busy, onBusyChange }: ReleaseFormProps) {
    const followUp = useWarningWriteFollowUp();
    const [reason, setReason] = useState('');
    const [touched, setTouched] = useState(false);
    const inFlight = useRef(false);

    const release = useMutation({
        mutationFn: async (body: WarningReleaseRequest) =>
            (await releaseWarning({ path: { guildId, slug: warning.slug }, body })).data,
    });

    // Checked as sent: the server trims the reason before its rule sees it.
    const body: WarningReleaseRequest = { reason: reason.trim() };
    const problem = fieldProblems(zReleaseWarningBody.safeParse(body)).reason;
    const canRelease = !problem && !busy;

    async function handleRelease(): Promise<void> {
        if (!canRelease || inFlight.current) return;
        inFlight.current = true;
        onBusyChange(true);
        try {
            const result = await release.mutateAsync(body);
            await followUp.landed(guildId, 'release', result);
            onClose();
        } catch (error) {
            // Already released, or gone: the drawer's copy is out of date, so re-read and close.
            if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
                await followUp.moved(guildId, error);
                onClose();
                return;
            }
            notifications.show({
                color: 'red',
                title: "Couldn't release it",
                message: error instanceof ApiError ? error.message : "Couldn't reach the server. Try again in a second.",
            });
        } finally {
            inFlight.current = false;
            onBusyChange(false);
        }
    }

    return (
        <Stack gap="md">
            <Text size="13.5px" c="dimmed">
                <Text span fw={700} c="bright">
                    {warningPersonLabel(warning.member)}
                </Text>{' '}
                comes off the hook for{' '}
                <Text span fw={700} c="bright">
                    {warning.rule}
                </Text>{' '}
                (
                <Text span ff="monospace">
                    {warning.slug}
                </Text>
                ). It stops counting against them for good — there is no undo — and the mod log hears why.
            </Text>
            <Textarea
                label="Reason"
                description="Kept on the record and posted to the mod log."
                placeholder="Apologised, grovelled, meant it"
                autosize
                minRows={2}
                maxRows={6}
                value={reason}
                onChange={(event) => {
                    setReason(event.currentTarget.value);
                    setTouched(true);
                }}
                error={touched ? problem : undefined}
                data-autofocus
            />
            <Group justify="flex-end" gap="sm">
                <Button variant="subtle" color="gray" onClick={onClose} disabled={busy}>
                    Cancel
                </Button>
                <Button color="red" loading={busy} disabled={!canRelease} onClick={() => void handleRelease()}>
                    Release warning
                </Button>
            </Group>
        </Stack>
    );
}
