/**
 * The confirm for dragging a flow out of its group.
 *
 * Leaving always asks, even though nothing in Discord is touched by it. The reason is
 * the second half of the dialog: the flow stops installing the journey's resources, so
 * every node in it that points at one of those keys will start failing to save. That is
 * invisible from the flows page and only shows up the next time someone opens the
 * builder — which is too late for a gesture as cheap as a drag.
 *
 * The remaining flows are **named**, not counted, matching the rest of this feature.
 * "2 flows still install them" leaves the operator to go and work out which; naming them
 * is what makes "nothing already in the server is touched" checkable rather than a
 * promise.
 */

import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { joinWithAnd } from './nameLists';

interface LeaveGroupDialogProps {
    readonly opened: boolean;
    readonly onClose: () => void;
    readonly flowName: string;
    readonly journeyName: string;
    /** Every **other** flow still on the journey, by name. */
    readonly remainingFlowNames: readonly string[];
    readonly onConfirm: () => Promise<void>;
    readonly busy: boolean;
}

export function LeaveGroupDialog({
    opened,
    onClose,
    flowName,
    journeyName,
    remainingFlowNames,
    onConfirm,
    busy,
}: LeaveGroupDialogProps) {
    const remaining = joinWithAnd(remainingFlowNames);

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={`Take ${flowName} out of ${journeyName}?`}
            size="md"
        >
            <Stack gap="md">
                <Text size="13.5px" style={{ lineHeight: 1.6 }}>
                    It stops installing {journeyName}&apos;s resources.
                    {remainingFlowNames.length > 0 && (
                        <>
                            {' '}
                            <Text span fw={700} c="bright" inherit>
                                {remaining}
                            </Text>{' '}
                            still {remainingFlowNames.length === 1 ? 'installs' : 'install'} them,
                            and
                        </>
                    )}{' '}
                    nothing already in the server is touched.
                </Text>

                <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
                    <Text size="12.5px" style={{ lineHeight: 1.6 }}>
                        Nodes in{' '}
                        <Text span fw={700} c="bright" inherit>
                            {flowName}
                        </Text>{' '}
                        that point at {journeyName}&apos;s resources will stop saving until you
                        repoint them.
                    </Text>
                </Alert>

                <Group justify="flex-end" gap="sm">
                    <Button variant="subtle" color="gray" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button color="red" loading={busy} onClick={() => void onConfirm()}>
                        Take it out
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}
