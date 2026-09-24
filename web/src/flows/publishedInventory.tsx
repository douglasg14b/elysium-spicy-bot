/**
 * The inventory half of a teardown dialog: the rows, and the markdown their explanations
 * arrive in.
 *
 * Extracted when the journey-scoped dialog arrived. Both dialogs answer the same question
 * — *what is live in the server, and what happens to it?* — and differ only in **scope**
 * and in the two actions underneath. Leaving the row rendering inside
 * `InstalledResourcesDialog` would have meant the second dialog either imported from a
 * component whose export is a modal, or carried a second copy of it; the copy is the worse
 * of the two, because the red left edge and the "deletes" marker are how an operator reads
 * which rows die, and a drifted copy would say that wrong on one of the two screens.
 *
 * Nothing here decides anything. What is in a group, which rows are destructive and what
 * the headings say is `summarisePublished`'s, tested without a DOM; this renders what it
 * returns.
 */

import { useState } from 'react';
import { Button, Center, Divider, Group, Stack, Text } from '@mantine/core';
import { IconHelpCircle, IconMessage, type Icon as TablerIcon } from '@tabler/icons-react';
import type { PublishedGroup, PublishedResourceLine, PublishedSummary } from './publishedSummary';
import { RESOURCE_KIND_STYLES } from './resourceMeta';

/**
 * The icon and colour a row wears.
 *
 * The three real kinds come from `RESOURCE_KIND_STYLES`, which is the same table the
 * resources panel and the pickers draw from — so a channel is the same blue `#` here
 * as it is where it was declared. Only the two cases that table has no opinion about
 * are supplied locally: a posted message is not a resource, and `unknown` is a kind
 * this build does not recognise but must still show rather than drop.
 */
export function rowIcon(glyph: PublishedResourceLine['glyph']): {
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

/**
 * Render the `**bold**` in a server explanation as bold.
 *
 * The explanations are written once, in provisioning, in Discord's flavour of markdown
 * — that is the right call, because the same sentence is shown to operators in Discord
 * too. The browser is the odd one out, and it was printing the asterisks literally, so
 * a refusal naming a category read `**test stuff**`.
 *
 * Split rather than a markdown dependency: the only syntax these sentences use is
 * `**`, and the emphasis is always a resource name. Pulling in a renderer to bold a
 * channel name would be a library for one call site.
 */
export function withEmphasis(text: string): React.ReactNode {
    return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
        part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
            <Text key={index} span fw={700} c="bright" inherit>
                {part.slice(2, -2)}
            </Text>
        ) : (
            part
        )
    );
}

/** One row of the inventory: what it is, what it is called, and what happens to it. */
export function ResourceRow({ line }: { readonly line: PublishedResourceLine }) {
    const deleted = line.fate === 'deleted';
    const { Icon, color } = rowIcon(line.glyph);

    return (
        /*
         * Two rows, not one.
         *
         * Identity and explanation used to share a line, so a long reason squeezed the
         * name until a category called "test stuff" rendered as "te:" — the dialog
         * truncating the one thing an operator needs to recognise. Giving the
         * explanation its own full-width line below means neither has to win.
         */
        <Stack
            gap={5}
            px={12}
            py={9}
            style={{
                background: 'var(--mantine-color-dark-8)',
                border: '1px solid var(--mantine-color-dark-6)',
                // The red edge does the work a "DELETES" badge was doing, without
                // spending a column on it.
                borderLeft: `3px solid var(--mantine-color-${deleted ? 'red-6' : 'dark-5'})`,
                borderRadius: 8,
            }}
        >
            <Group gap={10} wrap="nowrap" align="center">
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

                {/*
                 * `truncate` stays as the last resort for a genuinely long name, but it
                 * now competes with nothing — the row is as wide as the dialog.
                 */}
                <Text size="13.5px" fw={650} c={deleted ? 'bright' : 'dimmed'} truncate>
                    {line.displayName}
                </Text>

                <Text
                    size="11px"
                    c="dark.3"
                    tt="uppercase"
                    style={{ letterSpacing: '0.04em', flex: 'none' }}
                >
                    {line.kindLabel}
                </Text>

                {deleted && (
                    <Text
                        size="11px"
                        fw={800}
                        c="red.5"
                        ml="auto"
                        tt="uppercase"
                        style={{ flex: 'none' }}
                    >
                        deletes
                    </Text>
                )}
            </Group>

            {/*
             * Why this one is being kept, in full. Never clamped: a reason cut off
             * mid-sentence — "it still contains…" — withholds exactly the part that
             * tells the operator what to go and move.
             */}
            {line.explanation && (
                <Text size="11.5px" c="dimmed" style={{ lineHeight: 1.5 }}>
                    {withEmphasis(line.explanation)}
                </Text>
            )}
        </Stack>
    );
}

/** A titled block of rows. Rendered only when it has rows — see `summarisePublished`. */
export function ResourceGroup({ group }: { readonly group: PublishedGroup }) {
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

interface TeardownActionsProps {
    /** Null while loading or after a failed lookup — the bar renders only "Done". */
    readonly summary: PublishedSummary | null;
    readonly busy: boolean;
    readonly onClose: () => void;
    readonly onUndeploy: () => void;
    readonly onUnpublish: () => void;
    /** Appended after the destructive button. The flows list puts "Delete flow" here. */
    readonly extraActions?: React.ReactNode;
}

/**
 * The action bar both teardown dialogs share, including the two-stage red confirm.
 *
 * Shared because this is the safety-relevant half. The destructive button arms in place
 * rather than opening a confirmation card — the card was removed for restating the list
 * directly above it — so the *only* thing standing between a click and an irreversible
 * deletion is that this renders two different buttons in sequence. A second copy of that
 * is a second chance for one dialog to lose its confirm while the other keeps it, and no
 * test would catch it: `web/` has no jsdom.
 *
 * `confirmUnpublish` is owned here rather than by the callers, which is what makes the
 * guarantee structural. A caller cannot forget to reset it, and cannot render the armed
 * button without having rendered the unarmed one first.
 *
 * The layout is the same argument as the state: reversible on the left, destructive on
 * the right, "Done" between them so the two are never adjacent under a moving cursor.
 */
export function TeardownActions({
    summary,
    busy,
    onClose,
    onUndeploy,
    onUnpublish,
    extraActions,
}: TeardownActionsProps) {
    const [confirmUnpublish, setConfirmUnpublish] = useState(false);

    return (
        <Group gap="sm" mt={4}>
            {summary?.canUndeploy && (
                <Button size="xs" variant="light" color="orange" loading={busy} onClick={onUndeploy}>
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
                        onClick={() => {
                            // Disarmed as the action starts. A teardown that empties the
                            // inventory unmounts this button, but one that partly fails
                            // leaves it on screen — and leaving it armed would put a
                            // single click on a second destroy.
                            setConfirmUnpublish(false);
                            onUnpublish();
                        }}
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
    );
}
