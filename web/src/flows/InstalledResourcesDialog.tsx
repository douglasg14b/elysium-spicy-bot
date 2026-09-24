/**
 * What a flow has live in a guild, and the two ways to take it back.
 *
 * Shared by the flows list and the builder, which is the point: teardown used to live
 * only on the list page, so an operator editing a flow could install resources and had
 * no way to uninstall them without navigating away. One component means the builder's
 * uninstall and the list's cannot drift into two behaviours — or two sets of copy for
 * the same irreversible action.
 *
 * It owns the fetch and both actions rather than taking them as props. The alternative
 * was handing each page a fistful of callbacks and having both reimplement "refetch
 * after the teardown so the list reflects what just happened", which is exactly the
 * duplication this extraction exists to remove.
 *
 * ## What it does not own
 *
 * Deleting the *flow*. The list page wraps this in its own delete confirmation and
 * passes `extraActions`; the builder passes none. Putting a "Delete flow" button in here
 * would mean an operator who opened the dialog to tidy up a category would find the
 * button that destroys their work sitting under the cursor.
 */

import { useCallback, useEffect, useState } from 'react';
import { Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ApiError } from '../api/client';
import { getPublishedState, undeployFlow, unpublishFlow } from '../api/flows';
import type { PublishedFlowState } from '../api/types';
import { ResourceGroup, TeardownActions } from './publishedInventory';
import { summarisePublished } from './publishedSummary';

interface InstalledResourcesDialogProps {
    readonly opened: boolean;
    readonly onClose: () => void;
    readonly guildId: string;
    readonly flowId: string;
    readonly flowName: string;
    /**
     * Shown above the inventory. The list page explains that deleting the flow leaves
     * this behind; the builder has nothing extra to say and passes nothing.
     */
    readonly intro?: React.ReactNode;
    /**
     * Extra controls for the end of the action bar. The list page puts its delete
     * buttons here.
     *
     * Appended to the bar rather than replacing it: a delete dialog needs the uninstall
     * available *beside* its own button, because "this leaves channels behind — do you
     * want them gone first?" is the entire reason it shows the inventory at all.
     */
    readonly extraActions?: React.ReactNode;
    /**
     * Told after a teardown, so a caller showing flow state can react.
     *
     * Carries which one happened because the two have different consequences: an
     * `unpublish` destroys channels and roles that blocks may still name, while an
     * `undeploy` only retires messages and invalidates nothing on the canvas.
     */
    readonly onChanged?: (action: 'undeploy' | 'unpublish') => void;
}

/*
 * The rows themselves live in `publishedInventory.tsx`, shared with
 * `JourneyResourcesDialog`. They moved there rather than being exported from here
 * because the second dialog needed exactly the same inventory over a different scope,
 * and importing row internals from a module whose subject is a modal would have made
 * this file the owner of markup it no longer solely uses.
 */

export function InstalledResourcesDialog({
    opened,
    onClose,
    guildId,
    flowId,
    flowName,
    intro,
    extraActions,
    onChanged,
}: InstalledResourcesDialogProps) {
    /**
     * `null` while loading — distinct from a loaded-but-empty state, because the dialog
     * must not say "this publishes nothing" before it has asked.
     */
    const [published, setPublished] = useState<PublishedFlowState | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        try {
            return await getPublishedState(guildId, flowId);
        } catch {
            /*
             * A failed lookup must not block the caller's delete, but it must not
             * silently claim there is nothing published either. An empty state is the
             * honest answer: the actions it gates stay hidden rather than offering a
             * teardown we cannot describe.
             */
            return {
                buttonMessages: [],
                deletableResources: [],
                refusedResources: [],
                mayHaveUnrecordedButtons: true,
            } satisfies PublishedFlowState;
        }
    }, [guildId, flowId]);

    useEffect(() => {
        if (!opened) {
            // No confirm to reset: `TeardownActions` owns that state and unmounts with
            // the modal, so a dialog reopened after an armed-but-abandoned click comes
            // back disarmed without this having to remember to say so.
            setPublished(null);
            return;
        }

        let cancelled = false;
        void (async () => {
            const state = await refresh();
            if (!cancelled) setPublished(state);
        })();
        return () => {
            cancelled = true;
        };
    }, [opened, refresh]);

    const summary = published ? summarisePublished(published) : null;

    /**
     * Take the flow's buttons out of their channels.
     *
     * Its own action, not a step inside delete. The flow row survives it, so an
     * operator can retire a live button without throwing the flow away.
     */
    async function handleUndeploy() {
        setBusy(true);
        try {
            const { results } = await undeployFlow(guildId, flowId);
            const failed = results.filter((result) => result.outcome === 'failed');
            const gone = results.length - failed.length;

            notifications.show({
                color: failed.length > 0 ? 'orange' : 'brand',
                title: failed.length > 0 ? 'Mostly gone' : 'Buttons retired',
                message:
                    failed.length > 0
                        ? `${gone} removed, ${failed.length} wouldn't budge: ${failed[0].explanation ?? 'Discord said no.'}`
                        : `${gone} button message${gone === 1 ? '' : 's'} taken down.`,
            });

            setPublished(await refresh());
            onChanged?.('undeploy');
        } catch (err) {
            const message =
                err instanceof ApiError ? err.message : "Couldn't take those buttons down.";
            notifications.show({ color: 'red', title: 'Still up', message });
        } finally {
            setBusy(false);
        }
    }

    /**
     * Destroy the channels and roles the flow's journey created.
     *
     * Behind its own confirm, because this is the only action here that deletes part of
     * a live server and cannot be undone.
     */
    async function handleUnpublish() {
        setBusy(true);
        try {
            const { results } = await unpublishFlow(guildId, flowId);
            const deleted = results.filter((result) => result.outcome === 'deleted').length;
            const failed = results.filter((result) => result.outcome === 'failed');

            notifications.show({
                color: failed.length > 0 ? 'orange' : 'brand',
                title: failed.length > 0 ? 'Partly done' : 'Uninstalled',
                message:
                    failed.length > 0
                        ? `${deleted} deleted; ${failed.length} refused: ${failed[0].explanation ?? 'Discord said no.'}`
                        : `${deleted} thing${deleted === 1 ? '' : 's'} deleted from the server. Anything adopted was left exactly where it was.`,
            });

            setPublished(await refresh());
            onChanged?.('unpublish');
        } catch (err) {
            const message =
                err instanceof ApiError ? err.message : "Couldn't remove those resources.";
            notifications.show({ color: 'red', title: 'Nothing deleted', message });
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={`What ${flowName} has in your server`}
            // Wide enough for a resource name and its reason to coexist. At `md` the
            // server's explanations — which name the channels blocking a delete — had
            // nowhere to go, and the name lost.
            size="lg"
        >
            <Stack gap="md">
                {intro}

                {!published && (
                    <Group gap="xs">
                        <Loader size="xs" color="brand" />
                        <Text size="13px" c="dimmed">
                            Checking your server…
                        </Text>
                    </Group>
                )}

                {summary && !summary.hasAnything && (
                    <Text size="13.5px" c="dimmed">
                        Nothing live in the server yet. Install it from the builder first.
                    </Text>
                )}

                {summary && summary.hasAnything && (
                    <Stack gap="md">
                        {summary.groups.map((group) => (
                            <ResourceGroup key={group.id} group={group} />
                        ))}
                    </Stack>
                )}

                {/*
                 * The delete-flow button rides in `extraActions`, after the uninstall
                 * rather than instead of it: "deleting the flow leaves these channels" is
                 * only useful next to the thing that removes them.
                 */}
                <TeardownActions
                    summary={summary}
                    busy={busy}
                    onClose={onClose}
                    onUndeploy={() => void handleUndeploy()}
                    onUnpublish={() => void handleUnpublish()}
                    extraActions={extraActions}
                />
            </Stack>
        </Modal>
    );
}
