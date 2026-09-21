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
import { Button, Center, Divider, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconHelpCircle,
    IconMessage,
    type Icon as TablerIcon,
} from '@tabler/icons-react';
import { ApiError } from '../api/client';
import { getPublishedState, undeployFlow, unpublishFlow } from '../api/flows';
import type { PublishedFlowState } from '../api/types';
import {
    summarisePublished,
    type PublishedGroup,
    type PublishedResourceLine,
} from './publishedSummary';
import { RESOURCE_KIND_STYLES } from './resourceMeta';

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

/**
 * The icon and colour a row wears.
 *
 * The three real kinds come from `RESOURCE_KIND_STYLES`, which is the same table the
 * resources panel and the pickers draw from — so a channel is the same blue `#` here
 * as it is where it was declared. Only the two cases that table has no opinion about
 * are supplied locally: a posted message is not a resource, and `unknown` is a kind
 * this build does not recognise but must still show rather than drop.
 */
function rowIcon(glyph: PublishedResourceLine['glyph']): {
    readonly Icon: TablerIcon;
    readonly color: string;
} {
    switch (glyph) {
        case 'message':
            return { Icon: IconMessage, color: 'gray' };
        case 'unknown':
            return { Icon: IconHelpCircle, color: 'gray' };
        default: {
            const style = RESOURCE_KIND_STYLES[glyph];
            return { Icon: style.icon, color: style.color };
        }
    }
}

/** One row of the inventory: what it is, what it is called, and what happens to it. */
function ResourceRow({ line }: { readonly line: PublishedResourceLine }) {
    const deleted = line.fate === 'deleted';
    const { Icon, color } = rowIcon(line.glyph);

    return (
        <Group
            gap={10}
            wrap="nowrap"
            align="center"
            px={11}
            py={8}
            style={{
                background: 'var(--mantine-color-dark-8)',
                border: '1px solid var(--mantine-color-dark-6)',
                // The red edge does the work a "DELETES" badge was doing, without
                // spending a column on it.
                borderLeft: `3px solid var(--mantine-color-${deleted ? 'red-6' : 'dark-5'})`,
                borderRadius: 8,
                opacity: deleted ? 1 : 0.82,
            }}
        >
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

            <Text size="13.5px" fw={650} c={deleted ? 'bright' : 'dimmed'} truncate>
                {line.displayName}
            </Text>

            <Text size="11px" c="dark.3" tt="uppercase" style={{ letterSpacing: '0.04em' }}>
                {line.kindLabel}
            </Text>

            {/*
             * The reason a survivor survives, right-aligned. This is the part a count
             * would destroy: "1 item cannot be removed" is unactionable, "adopted, not
             * created" tells the operator why their channel is safe.
             */}
            {line.explanation && (
                <Text size="11.5px" c="dark.3" ta="right" ml="auto" lineClamp={2}>
                    {line.explanation}
                </Text>
            )}
            {deleted && (
                <Text size="11px" fw={800} c="red.5" ml="auto" tt="uppercase" style={{ flex: 'none' }}>
                    deletes
                </Text>
            )}
        </Group>
    );
}

/** A titled block of rows. Rendered only when it has rows — see `summarisePublished`. */
function ResourceGroup({ group }: { readonly group: PublishedGroup }) {
    return (
        <Stack gap={7}>
            <Group gap={8} wrap="nowrap" align="center">
                <Text
                    size="11.5px"
                    fw={800}
                    tt="uppercase"
                    c={group.destructive ? 'red.5' : 'dimmed'}
                    style={{ letterSpacing: '0.05em', flex: 'none' }}
                >
                    {group.title}
                </Text>
                <Text size="11.5px" c="dark.3" style={{ flex: 'none' }}>
                    {group.caption}
                </Text>
                <Divider style={{ flex: 1 }} color="dark.6" />
            </Group>
            <Stack gap={5}>
                {group.lines.map((line) => (
                    <ResourceRow key={line.resourceKey} line={line} />
                ))}
            </Stack>
        </Stack>
    );
}

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
    /** The second confirm, for the half that destroys channels rather than messages. */
    const [confirmUnpublish, setConfirmUnpublish] = useState(false);

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
            setPublished(null);
            setConfirmUnpublish(false);
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

            setConfirmUnpublish(false);
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
            size="md"
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
                 * The action bar, split by direction: reversible on the left,
                 * destructive on the right, with "Done" between them so the two are
                 * never adjacent.
                 *
                 * There is no confirmation card. It restated the list directly above it,
                 * which put a paragraph between the operator and the action rather than
                 * a safeguard in front of it. The second click happens on the button,
                 * which arms into "Yes, delete 2 resources" — still two deliberate
                 * clicks for something irreversible, without the prose.
                 */}
                <Group gap="sm" mt={4}>
                    {summary?.canUndeploy && (
                        <Button
                            size="xs"
                            variant="light"
                            color="orange"
                            loading={busy}
                            onClick={() => void handleUndeploy()}
                        >
                            Take buttons down
                        </Button>
                    )}
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
                    {summary?.canUnpublish &&
                        (confirmUnpublish ? (
                            <Button
                                size="xs"
                                color="red"
                                loading={busy}
                                onClick={() => void handleUnpublish()}
                            >
                                {summary.unpublishConfirmLabel}
                            </Button>
                        ) : (
                            <Button
                                size="xs"
                                variant="light"
                                color="red"
                                disabled={busy}
                                onClick={() => setConfirmUnpublish(true)}
                            >
                                {summary.unpublishLabel}
                            </Button>
                        ))}
                    {extraActions}
                </Group>
            </Stack>
        </Modal>
    );
}
