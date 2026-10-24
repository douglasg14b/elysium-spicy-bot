/**
 * Where a picture is shown, one row a place: "Welcome flow · Post Embed · embed 1 thumbnail",
 * the flow a link into the builder. A place only somebody's unsaved draft holds is marked
 * DRAFT — deleting the picture would break that draft, so it counts, but the saved flow
 * does not show it yet.
 *
 * The same rows on a card and in the delete dialog's refusal, so the dialog lists exactly
 * what the card did — or, after a 409, what the server says now.
 */

import { Anchor, Badge, Box, Group, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import type { UploadUse } from '@brattybot/web-sdk';
import { Link } from 'react-router-dom';

interface UploadUsesProps {
    readonly uses: readonly UploadUse[];
    /** The signed-in person, so their own draft is called theirs. */
    readonly viewerId: string | undefined;
    /** Names the list for assistive tech: "Where logo.png is used". */
    readonly label: string;
}

function draftTooltip(use: UploadUse, viewerId: string | undefined): string {
    return use.draftAuthorId === viewerId
        ? 'Only in your unsaved draft of this flow.'
        : `Only in an unsaved draft of this flow, by ${use.draftAuthorId}.`;
}

export function UploadUses({ uses, viewerId, label }: UploadUsesProps) {
    return (
        <Box component="ul" aria-label={label} m={0} p={0} style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {uses.map((use, index) => (
                <Box
                    component="li"
                    // One use per place, so flow + node + part is unique; the index guards a
                    // second reader that might one day name the same place.
                    key={`${use.flowId}:${use.nodeId}:${use.where}:${use.draftAuthorId ?? ''}:${index}`}
                    bg="dark.7"
                    px={9}
                    py={5}
                    style={{ border: '1px solid var(--mantine-color-dark-5)', borderRadius: 'var(--mantine-radius-sm)' }}
                >
                    <Group gap={7} wrap="nowrap">
                        <Text size="12.5px" c="dark.1" lh={1.45} style={{ minWidth: 0, flex: 1 }} lineClamp={2}>
                            <Anchor
                                component={Link}
                                to={`/flows/${use.flowId}`}
                                size="12.5px"
                                fw={700}
                                c="brand.4"
                                underline="hover"
                            >
                                {use.flowName}
                            </Anchor>{' '}
                            <Text span size="12.5px" c="dark.2">
                                · {use.blockLabel} · {use.where}
                            </Text>
                        </Text>
                        {use.draftAuthorId ? (
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
            ))}
        </Box>
    );
}
