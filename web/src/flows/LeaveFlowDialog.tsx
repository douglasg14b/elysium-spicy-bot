/**
 * The question the builder asks when the operator walks away from unsaved work.
 *
 * Presentation only. What each answer does — the save, the draft flush, the discard — is
 * the page's, because the page holds the canvas and the autosave they act on.
 */

import { Button, Group, Modal, Stack, Text } from '@mantine/core';

/** The three answers that act before leaving. Staying is not one: it acts on nothing. */
export type LeaveAction = 'save' | 'keepDraft' | 'discard';

export interface LeaveFlowDialogProps {
    readonly opened: boolean;
    /** Named in the title, so the operator knows which work is on the line. */
    readonly flowName: string;
    /** The answer being carried out, if one is. Every button waits on it. */
    readonly pending: LeaveAction | null;
    readonly onChoose: (action: LeaveAction) => void;
    readonly onStay: () => void;
}

/**
 * Save, keep as draft, discard, or stay.
 *
 * Nothing closes it while an answer is in flight — not Escape, not the backdrop — because
 * "stay" halfway through a save or a discard would leave the operator on a page whose
 * state that answer is still changing.
 */
export function LeaveFlowDialog({ opened, flowName, pending, onChoose, onStay }: LeaveFlowDialogProps) {
    const busy = pending !== null;
    const answer = (action: LeaveAction) => ({
        onClick: () => onChoose(action),
        loading: pending === action,
        disabled: busy,
    });

    return (
        <Modal
            opened={opened}
            onClose={() => {
                if (!busy) onStay();
            }}
            title={`Leave "${flowName}" with unsaved changes?`}
            // Wide enough for the four answers on one line; at `md` Discard wrapped onto its own.
            size="lg"
            closeOnEscape={!busy}
            closeOnClickOutside={!busy}
            withCloseButton={!busy}
        >
            <Stack gap="md">
                <Text size="13px" c="dimmed">
                    Commit it, park it as your draft, or ditch it.
                </Text>
                <Group justify="space-between" gap="sm">
                    <Button variant="subtle" color="red" {...answer('discard')}>
                        Discard changes
                    </Button>
                    <Group gap="sm">
                        <Button variant="subtle" color="gray" onClick={onStay} disabled={busy}>
                            Stay
                        </Button>
                        <Button variant="light" color="gray" {...answer('keepDraft')}>
                            Keep as draft
                        </Button>
                        <Button color="brand" {...answer('save')}>
                            Save
                        </Button>
                    </Group>
                </Group>
            </Stack>
        </Modal>
    );
}
