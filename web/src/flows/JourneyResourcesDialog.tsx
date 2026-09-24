/**
 * What a **journey** has in a guild, and the two ways to take it back.
 *
 * The group header's dialog. It exists because the header used to open
 * `InstalledResourcesDialog` through `group.flows[0]`, which was wrong in both
 * directions at once: the inventory showed one member's button messages while the
 * journey's other flows had their own still posted, and the uninstall beside it was
 * refused by the server's shared-journey 409 precisely because a flow may not tear down
 * structure its siblings install. An operator looking at the group could therefore see an
 * incomplete list and then be told they were not allowed to act on it.
 *
 * Acting on the journey answers both. The routes behind this fan out over every attached
 * flow, and they deliberately do **not** carry that 409 — an operator holding the journey
 * is the legitimate case the refusal was steering them towards, not a case it protects
 * against.
 *
 * ## Why this is a sibling rather than a prop on the other dialog
 *
 * The two share their inventory (`publishedInventory.tsx`) and their copy
 * (`summarisePublished`), which is the part that would have hurt to duplicate. What they
 * do not share is the three API calls, the consequences those carry, and the fact that
 * this one has to name the flows it affects. Folding that into one component meant a
 * `scope` prop threaded through every handler and every label — the parameter tunnelling
 * `.claude/rules/elegance.md` warns about — to save a shell that is mostly a `<Modal>`.
 */

import { useCallback, useEffect, useState } from 'react';
import { Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ApiError } from '../api/client';
import {
    getJourneyPublishedState,
    undeployJourney,
    unpublishJourney,
} from '../api/journeys';
import type { PublishedFlowState } from '../api/types';
import { joinWithAnd } from './nameLists';
import { ResourceGroup, TeardownActions } from './publishedInventory';
import { summarisePublished } from './publishedSummary';

interface JourneyResourcesDialogProps {
    readonly opened: boolean;
    readonly onClose: () => void;
    readonly guildId: string;
    readonly journeyKey: string;
    readonly journeyName: string;
    /**
     * The flows installing this journey, by name.
     *
     * Names rather than a count, which is the house rule for anything an operator has to
     * act on — see `sharedJourneyRefusal`, which names every flow for the same reason.
     * "2 flows" tells them the size of what they are about to affect and leaves them to
     * go and find which; the names *are* the answer, and the page already has them.
     */
    readonly flowNames: readonly string[];
    /**
     * Told after a teardown, so the page can re-read its list.
     *
     * Takes no argument. The flow dialog's equivalent reports which of the two actions
     * ran, because the builder listens and only an `unpublish` invalidates node config
     * on its canvas. The flows list has no canvas and re-reads either way, so a
     * discriminator here would be a parameter every caller ignores.
     */
    readonly onChanged?: () => void;
}

export function JourneyResourcesDialog({
    opened,
    onClose,
    guildId,
    journeyKey,
    journeyName,
    flowNames,
    onChanged,
}: JourneyResourcesDialogProps) {
    /**
     * `null` while loading — distinct from a loaded-but-empty state, because the dialog
     * must not say "this publishes nothing" before it has asked.
     */
    const [published, setPublished] = useState<PublishedFlowState | null>(null);
    /**
     * Why the lookup failed, when it did — a third state beside "loading" and "loaded".
     *
     * The flow dialog collapses this case into an empty state, and is right to: it is
     * wrapped by a delete confirmation, so a failed lookup must not block the delete the
     * operator came for. This dialog has no outer action to protect. An empty state here
     * would be a bare assertion that nothing is installed, made at the exact moment we
     * could not find out — on the screen whose only job is answering that question.
     */
    const [loadError, setLoadError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async (): Promise<PublishedFlowState | null> => {
        try {
            const state = await getJourneyPublishedState(guildId, journeyKey);
            setLoadError(null);
            return state;
        } catch (err) {
            setLoadError(
                err instanceof ApiError
                    ? err.message
                    : "Couldn't check what this journey has in your server."
            );
            return null;
        }
    }, [guildId, journeyKey]);

    useEffect(() => {
        if (!opened) {
            // No confirm to reset: `TeardownActions` owns that state and unmounts with
            // the modal, so a dialog reopened after an armed-but-abandoned click comes
            // back disarmed without this having to remember to say so.
            setPublished(null);
            setLoadError(null);
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

    const summary = published ? summarisePublished(published, 'journey') : null;

    /** Take every attached flow's buttons out of their channels. */
    async function handleUndeploy() {
        setBusy(true);
        try {
            const { results } = await undeployJourney(guildId, journeyKey);
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

            // A failed re-read leaves the last good inventory on screen rather than
            // blanking it: the teardown above already reported what it did, and
            // replacing that with an empty list would contradict the notification.
            const next = await refresh();
            if (next) setPublished(next);
            onChanged?.();
        } catch (err) {
            const message =
                err instanceof ApiError ? err.message : "Couldn't take those buttons down.";
            notifications.show({ color: 'red', title: 'Still up', message });
        } finally {
            setBusy(false);
        }
    }

    /**
     * Destroy the channels and roles this journey created.
     *
     * Behind its own confirm, because this is the only action here that deletes part of
     * a live server and cannot be undone — and it does so for every flow in the group at
     * once, which is what the line above the buttons is there to say.
     */
    async function handleUnpublish() {
        setBusy(true);
        try {
            const { results } = await unpublishJourney(guildId, journeyKey);
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

            // A failed re-read leaves the last good inventory on screen rather than
            // blanking it: the teardown above already reported what it did, and
            // replacing that with an empty list would contradict the notification.
            const next = await refresh();
            if (next) setPublished(next);
            onChanged?.();
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
            title={`What ${journeyName} has in your server`}
            // Wide enough for a resource name and its reason to coexist, matching the
            // flow dialog — the server's explanations name the channels blocking a
            // delete, and at `md` the name lost.
            size="lg"
        >
            <Stack gap="md">
                {/*
                 * Which flows this covers, named, above the inventory.
                 *
                 * The one thing this dialog must establish that the flow-scoped one never
                 * had to: the rows below are shared, and removing them reaches past
                 * whichever flow the operator was thinking of. Named rather than counted,
                 * and stated once here rather than repeated per row.
                 */}
                {flowNames.length > 0 && (
                    <Text size="13.5px" c="dimmed">
                        Shared by {joinWithAnd(flowNames.map((name) => `“${name}”`))}. Anything
                        removed here goes for all of them.
                    </Text>
                )}

                {!published && !loadError && (
                    <Group gap="xs">
                        <Loader size="xs" color="brand" />
                        <Text size="13px" c="dimmed">
                            Checking your server…
                        </Text>
                    </Group>
                )}

                {/*
                 * Said plainly, and never as an empty inventory. The actions below stay
                 * hidden because `summary` is null, so nothing offers a teardown we
                 * cannot describe.
                 */}
                {!published && loadError && (
                    <Text size="13.5px" c="orange.4">
                        {loadError} Close this and try again.
                    </Text>
                )}

                {summary && !summary.hasAnything && (
                    <Text size="13.5px" c="dimmed">
                        Nothing live in the server yet. Install it from any of these flows
                        first.
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
                 * No "delete journey" in the bar, hence no `extraActions`. A journey dies
                 * when its last flow leaves, not by being killed while flows still
                 * install it.
                 */}
                <TeardownActions
                    summary={summary}
                    busy={busy}
                    onClose={onClose}
                    onUndeploy={() => void handleUndeploy()}
                    onUnpublish={() => void handleUnpublish()}
                />
            </Stack>
        </Modal>
    );
}
