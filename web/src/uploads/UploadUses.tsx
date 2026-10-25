/**
 * Where a picture is shown, one row a place: "Welcome flow · Post Embed · embed 1 thumbnail",
 * the flow a link into the builder, or "Onboarding · message Rules panel · embed 1 image" for a
 * journey's message, linking to the flows page, whose group header is where a journey's
 * resources are edited. A place only somebody's unsaved draft holds is marked DRAFT —
 * deleting the picture would break that draft, so it counts, but the saved flow does not
 * show it yet.
 *
 * The same rows on a card and in the delete dialog's refusal, so the dialog lists exactly
 * what the card did — or, after a 409, what the server says now.
 */

import { Anchor, Badge, Box, Group, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import type { FlowUploadUse, UploadUse } from '@brattybot/web-sdk';
import { Link } from 'react-router-dom';

interface UploadUsesProps {
    readonly uses: readonly UploadUse[];
    /** The signed-in person, so their own draft is called theirs. */
    readonly viewerId: string | undefined;
    /** Names the list for assistive tech: "Where logo.png is used". */
    readonly label: string;
}

function draftTooltip(use: FlowUploadUse, viewerId: string | undefined): string {
    return use.draftAuthorId === viewerId
        ? 'Only in your unsaved draft of this flow.'
        : `Only in an unsaved draft of this flow, by ${use.draftAuthorId}.`;
}

/** One use's React key: kind, owner and part are unique, and the index guards a second reader naming the same place. */
function keyOfUse(use: UploadUse, index: number): string {
    switch (use.kind) {
        case 'flow':
            return `flow:${use.flowId}:${use.nodeId}:${use.where}:${use.draftAuthorId ?? ''}:${index}`;
        case 'journeyMessage':
            return `journeyMessage:${use.journeyKey}:${use.resourceKey}:${use.where}:${index}`;
    }
}

/** One use's row: where its link goes, what the link says, and the rest of the row after it. */
interface UseRowParts {
    readonly to: string;
    readonly title: string;
    readonly rest: string;
}

/** Where the use's link goes, what it says, and the rest of the row after it. */
function partsOfUse(use: UploadUse): UseRowParts {
    switch (use.kind) {
        case 'flow':
            return { to: `/flows/${use.flowId}`, title: use.flowName, rest: `· ${use.blockLabel} · ${use.where}` };
        case 'journeyMessage':
            return { to: '/flows', title: use.journeyName, rest: `· message ${use.messageName} · ${use.where}` };
    }
}

export function UploadUses({ uses, viewerId, label }: UploadUsesProps) {
    return (
        <Box component="ul" aria-label={label} m={0} p={0} style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {uses.map((use, index) => {
                const parts = partsOfUse(use);
                return (
                    <Box
                        component="li"
                        key={keyOfUse(use, index)}
                        bg="dark.7"
                        px={9}
                        py={5}
                        style={{ border: '1px solid var(--mantine-color-dark-5)', borderRadius: 'var(--mantine-radius-sm)' }}
                    >
                        <Group gap={7} wrap="nowrap">
                            <Text size="12.5px" c="dark.1" lh={1.45} style={{ minWidth: 0, flex: 1 }} lineClamp={2}>
                                <Anchor component={Link} to={parts.to} size="12.5px" fw={700} c="brand.4" underline="hover">
                                    {parts.title}
                                </Anchor>{' '}
                                <Text span size="12.5px" c="dark.2">
                                    {parts.rest}
                                </Text>
                            </Text>
                            {use.kind === 'flow' && use.draftAuthorId ? (
                                <>
                                    <Tooltip label={draftTooltip(use, viewerId)} withArrow multiline w={220}>
                                        <Badge size="xs" color="violet" variant="light" radius="xl" style={{ flex: 'none' }} aria-hidden>
                                            Draft
                                        </Badge>
                                    </Tooltip>
                                    {/* The tooltip's meaning for anyone not hovering: a screen reader reads it in the row. */}
                                    <VisuallyHidden>{draftTooltip(use, viewerId)}</VisuallyHidden>
                                </>
                            ) : null}
                        </Group>
                    </Box>
                );
            })}
        </Box>
    );
}
