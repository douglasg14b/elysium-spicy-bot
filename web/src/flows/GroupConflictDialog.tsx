/**
 * The stop-and-ask when a dragged flow declares resources of its own.
 *
 * The link row moves cleanly; the bindings do not. A binding is keyed
 * `(guild, journey, key)` and names a channel or role that already exists in the
 * server, so joining another journey forces a choice the app cannot take on the
 * operator's behalf: carry the declarations across, or abandon them.
 *
 * **Every resource is named, never counted.** That is the house convention across this
 * feature (journey delete, flow detach, flow delete) and it is load-bearing here: the
 * "leave them behind" outcome strands live Discord objects, and "2 resources" gives an
 * operator nothing to go and look at. The only two counts in this dialog are the chip
 * and the confirm button — the one place the rule bends, because a button has room for
 * a word and the number is the part that has to survive being skim-read.
 *
 * `web/` has no jsdom, so nothing here decides anything worth testing: the preview
 * arrives fully resolved from `GET /group-preview` and this renders it.
 */

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Group, Modal, Radio, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { GroupPreview, GroupResolution, MovingResource } from '../api/types';
import { joinWithAnd } from './nameLists';
import { RESOURCE_KIND_STYLES, resourceDisplayName } from './resourceMeta';

interface GroupConflictDialogProps {
    readonly opened: boolean;
    readonly onClose: () => void;
    /** Null while the preview is still in flight — the dialog renders nothing then. */
    readonly preview: GroupPreview | null;
    readonly onConfirm: (resolution: GroupResolution) => Promise<void>;
    readonly busy: boolean;
}

/**
 * What a moving resource is called, preferring what it actually is in Discord.
 *
 * A live resource shows the real channel or role name — that is the thing the operator
 * can go and find — and falls back to the declared name only when nothing is installed.
 */
function movingResourceLabel(resource: MovingResource): string {
    return resourceDisplayName(resource.kind, resource.live?.name ?? resource.declaredName);
}

/**
 * A run of names, emphasised and joined into a sentence.
 *
 * The separator rule is `joinWithAnd`', tested next door — three of these sentences
 * appear in this dialog and each one is a place where a dropped or mispunctuated name
 * still reads like English.
 */
function BoldNames({ names }: { readonly names: readonly string[] }) {
    return (
        <Text span inherit c="bright" fw={700}>
            {joinWithAnd(names)}
        </Text>
    );
}

/** One line of the "these are its own" list, wearing its kind's accent. */
function MovingResourceRow({ resource }: { readonly resource: MovingResource }) {
    const style = RESOURCE_KIND_STYLES[resource.kind];

    return (
        <Group
            gap={10}
            wrap="nowrap"
            px={12}
            py={8}
            style={{
                background: 'var(--mantine-color-dark-7)',
                border: '1px solid var(--mantine-color-dark-5)',
                borderLeft: `3px solid var(--mantine-color-${style.color}-6)`,
                borderRadius: 8,
            }}
        >
            <Text size="13px" fw={700} style={{ flex: 'none' }}>
                {resource.key}
            </Text>

            {/*
             * "live · #ticket-area" rather than a tick: the operator is about to decide
             * whether this survives as a managed object, and whether it exists yet is
             * the whole of that decision.
             */}
            {resource.live ? (
                <Badge size="sm" variant="light" color="teal" radius="xl">
                    live · {movingResourceLabel(resource)}
                </Badge>
            ) : (
                <Badge size="sm" variant="light" color="gray" radius="xl">
                    not installed
                </Badge>
            )}

            <Text size="11.5px" c="dark.3" ml="auto" style={{ flex: 'none' }}>
                {style.label.toLowerCase()}
            </Text>
        </Group>
    );
}

/**
 * The red block: what "leave them behind" strands, by name.
 *
 * Its own bordered box rather than a sentence inside the choice's description, because
 * orphaning is the one outcome in this dialog the app cannot walk back — the channel
 * survives and the record of it does not, so nothing will ever offer to clean it up
 * again.
 */
function OrphanWarning({
    orphaned,
    movingFlowName,
}: {
    readonly orphaned: readonly MovingResource[];
    readonly movingFlowName: string;
}) {
    return (
        <Stack
            gap={6}
            mt={9}
            px={13}
            py={10}
            style={{
                background: 'var(--mantine-color-red-light)',
                border: '1px solid var(--mantine-color-red-8)',
                borderLeft: '3px solid var(--mantine-color-red-6)',
                borderRadius: 8,
            }}
        >
            <Group gap={6} wrap="nowrap">
                <IconAlertTriangle size={13} color="var(--mantine-color-red-5)" />
                <Text
                    size="12px"
                    fw={800}
                    c="red.5"
                    tt="uppercase"
                    style={{ letterSpacing: '0.03em' }}
                >
                    Nothing will install these any more
                </Text>
            </Group>

            <Stack gap={2}>
                {orphaned.map((resource) => (
                    <Text key={resource.key} size="12.5px" style={{ lineHeight: 1.7 }}>
                        <Text span fw={700} c="bright" inherit>
                            {movingResourceLabel(resource)}
                        </Text>{' '}
                        — stays in the server, unmanaged
                    </Text>
                ))}
            </Stack>

            <Text
                size="12px"
                c="dimmed"
                pt={8}
                style={{
                    lineHeight: 1.55,
                    borderTop: '1px solid var(--mantine-color-red-9)',
                }}
            >
                BrattyBot will not create, update or remove them again. Deleting{' '}
                <Text span fw={700} c="bright" inherit>
                    {movingFlowName}
                </Text>{' '}
                later will not offer to clean them up, because it will no longer know they were
                its. Removing them becomes a manual job in Discord.
            </Text>
        </Stack>
    );
}

export function GroupConflictDialog({
    opened,
    onClose,
    preview,
    onConfirm,
    busy,
}: GroupConflictDialogProps) {
    /**
     * No default that survives the dialog closing.
     *
     * Both outcomes are consequential, so the selection is reset every time a preview
     * arrives rather than inherited from the last drag — an operator who chose "leave"
     * on one flow must not find it pre-chosen on the next.
     */
    const [resolution, setResolution] = useState<GroupResolution>('merge');

    const canMerge = preview?.canMerge ?? false;

    useEffect(() => {
        if (!preview) return;
        // A refused merge has one way in, so the dialog opens already on it rather than
        // making the operator click a disabled option to find that out.
        setResolution(preview.canMerge ? 'merge' : 'leave');
    }, [preview]);

    if (!preview) return null;

    const orphanCount = preview.orphaned.length;
    const orphaning = resolution === 'leave' && orphanCount > 0;

    const title = canMerge
        ? `${preview.movingFlowName} declares its own resources`
        : `${preview.destinationName} already declares ${preview.collisions[0]?.key ?? 'the same key'}`;

    return (
        <Modal opened={opened} onClose={onClose} title={title} size="lg">
            <Stack gap="md">
                {canMerge ? (
                    <Text size="13.5px" style={{ lineHeight: 1.6 }}>
                        Moving it into{' '}
                        <Text span fw={700} c="bright" inherit>
                            {preview.destinationName}
                        </Text>{' '}
                        changes which resources it installs. These are its own:
                    </Text>
                ) : (
                    <Text size="13.5px" style={{ lineHeight: 1.6 }}>
                        <Text span fw={700} c="bright" inherit>
                            {preview.movingFlowName}
                        </Text>{' '}
                        and{' '}
                        <Text span fw={700} c="bright" inherit>
                            {preview.destinationName}
                        </Text>{' '}
                        both declare these, meaning different things by them:
                    </Text>
                )}

                {/*
                 * When merging is refused the list narrows to the keys that refused it —
                 * the operator's next move is to rename one side, and the resources that
                 * merged cleanly are not part of that decision.
                 */}
                <Stack gap={6}>
                    {canMerge
                        ? preview.moving.map((resource) => (
                              <MovingResourceRow key={resource.key} resource={resource} />
                          ))
                        : preview.collisions.map((collision) => (
                              <Group
                                  key={collision.key}
                                  gap={10}
                                  wrap="nowrap"
                                  px={12}
                                  py={8}
                                  style={{
                                      background: 'var(--mantine-color-red-light)',
                                      border: '1px solid var(--mantine-color-red-8)',
                                      borderLeft: '3px solid var(--mantine-color-red-6)',
                                      borderRadius: 8,
                                  }}
                              >
                                  <Text size="13px" fw={700} style={{ flex: 'none' }}>
                                      {collision.key}
                                  </Text>
                                  {/*
                                   * Both sides named on one line. "welcome-channel
                                   * collides" tells an operator nothing they can act on;
                                   * "#tickets-welcome vs #welcome" tells them which one
                                   * to rename.
                                   */}
                                  <Badge size="sm" variant="light" color="red" radius="xl">
                                      {collision.movingName} vs {collision.destinationName}
                                  </Badge>
                              </Group>
                          ))}
                </Stack>

                {!canMerge && (
                    <>
                        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
                            <Text size="12.5px" style={{ lineHeight: 1.6 }}>
                                One key can name only one channel inside a journey. Merging would
                                make{' '}
                                <Text span fw={700} c="bright" inherit>
                                    {preview.collisions[0]?.key}
                                </Text>{' '}
                                ambiguous, and the installer would write whichever it resolved
                                first into every flow that mentions it —{' '}
                                <Text span fw={700} c="bright" inherit>
                                    including the ones already working
                                </Text>
                                .
                            </Text>
                        </Alert>
                        <Text size="12.5px" c="dimmed" style={{ lineHeight: 1.6 }}>
                            So the only way in is to leave them behind, which orphans them. Cancel
                            and rename one side&apos;s keys if you would rather keep them managed.
                        </Text>
                    </>
                )}

                <Radio.Group
                    value={resolution}
                    onChange={(value) => setResolution(value as GroupResolution)}
                >
                    <Stack gap={9}>
                        {/*
                         * The merge choice stays on the page when it is unavailable rather
                         * than being removed. An operator who dragged expecting a merge has
                         * to be told it was considered and why it was refused — a dialog
                         * offering only "leave them behind" reads as the app's preference
                         * rather than its only remaining option.
                         */}
                        <Stack
                            gap={0}
                            px={14}
                            py={12}
                            opacity={canMerge ? 1 : 0.45}
                            style={{
                                background:
                                    resolution === 'merge' && canMerge
                                        ? 'var(--mantine-color-brand-light)'
                                        : 'var(--mantine-color-dark-7)',
                                border: `1px solid var(--mantine-color-${
                                    resolution === 'merge' && canMerge ? 'brand-6' : 'dark-5'
                                })`,
                                borderRadius: 10,
                            }}
                        >
                            <Radio
                                value="merge"
                                disabled={!canMerge}
                                color="brand"
                                label={
                                    <Text size="13.5px" fw={700}>
                                        Bring them into {preview.destinationName}
                                    </Text>
                                }
                                description={
                                    canMerge ? (
                                        <Text size="12.5px" c="dimmed" style={{ lineHeight: 1.55 }}>
                                            They all become {preview.destinationName}&apos;s,
                                            alongside its existing resources.{' '}
                                            {orphanCount > 0 && (
                                                <>
                                                    <BoldNames
                                                        names={preview.orphaned.map(
                                                            movingResourceLabel
                                                        )}
                                                    />{' '}
                                                    {orphanCount === 1
                                                        ? 'stays exactly where it is in the server and keeps'
                                                        : 'stay exactly where they are in the server and keep'}{' '}
                                                    working — the record of them moves, not the
                                                    channels.
                                                </>
                                            )}
                                        </Text>
                                    ) : (
                                        <Text size="12.5px" c="dimmed" style={{ lineHeight: 1.55 }}>
                                            Unavailable while{' '}
                                            <BoldNames
                                                names={preview.collisions.map(
                                                    (collision) => collision.key
                                                )}
                                            />{' '}
                                            {preview.collisions.length === 1 ? 'is' : 'are'} claimed
                                            on both sides. Rename one side&apos;s keys and drag
                                            again.
                                        </Text>
                                    )
                                }
                            />
                        </Stack>

                        <Stack
                            gap={0}
                            px={14}
                            py={12}
                            style={{
                                background:
                                    resolution === 'leave'
                                        ? 'var(--mantine-color-red-light)'
                                        : 'var(--mantine-color-dark-7)',
                                border: `1px solid var(--mantine-color-${
                                    orphanCount > 0
                                        ? resolution === 'leave'
                                            ? 'red-6'
                                            : 'red-8'
                                        : resolution === 'leave'
                                          ? 'brand-6'
                                          : 'dark-5'
                                })`,
                                borderRadius: 10,
                            }}
                        >
                            <Radio
                                value="leave"
                                color={orphanCount > 0 ? 'red' : 'brand'}
                                label={
                                    <Group gap={7} wrap="nowrap">
                                        <Text size="13.5px" fw={700}>
                                            Leave them behind
                                        </Text>
                                        {/*
                                         * The chip is one of exactly two counts in this
                                         * dialog. It is a marker on a choice, not the
                                         * explanation — the names are directly below it.
                                         */}
                                        {orphanCount > 0 && (
                                            <Badge size="sm" variant="light" color="red" radius="xl">
                                                orphans {orphanCount} live object
                                                {orphanCount === 1 ? '' : 's'}
                                            </Badge>
                                        )}
                                    </Group>
                                }
                                description={
                                    <Text size="12.5px" c="dimmed" style={{ lineHeight: 1.55 }}>
                                        {preview.movingFlowName} joins {preview.destinationName} and
                                        installs {preview.destinationName}&apos;s resources instead.
                                    </Text>
                                }
                            />

                            {orphanCount > 0 && (
                                <OrphanWarning
                                    orphaned={preview.orphaned}
                                    movingFlowName={preview.movingFlowName}
                                />
                            )}

                            {/*
                             * The other half of leaving: the nodes that still point at
                             * these keys. Named, because repointing them is the work this
                             * choice creates and the operator needs the list to do it.
                             */}
                            {preview.moving.length > 0 && (
                                <Text size="12.5px" c="dimmed" mt={9} style={{ lineHeight: 1.55 }}>
                                    Nodes still pointing at{' '}
                                    <BoldNames
                                        names={preview.moving.map((resource) => resource.key)}
                                    />{' '}
                                    will stop saving until you repoint them.
                                </Text>
                            )}
                        </Stack>
                    </Stack>
                </Radio.Group>

                <Group justify="flex-end" gap="sm">
                    <Button variant="subtle" color="gray" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button
                        color={orphaning ? 'red' : 'brand'}
                        loading={busy}
                        onClick={() => void onConfirm(resolution)}
                    >
                        {orphaning ? `Move it & orphan ${orphanCount}` : 'Move it'}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}
