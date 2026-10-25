/**
 * A message in a few lines, for a column too narrow to draw it: each embed's title and body
 * beside its colour stripe, what else it holds, and **Edit message**, which opens the message
 * window. The inspector's `message` control shows one, and so does a message resource's row.
 */

import type { Ref } from 'react';
import { Button, Group, Stack, Text } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { readStoredMessage } from '../storedMessage';
import { DISCORD } from './discordLook';

interface MessagePreviewCardProps {
    /** The message as stored, whatever shape it is in. */
    readonly value: unknown;
    /** How many buttons sit under it, for a message that has them. */
    readonly buttonCount?: number;
    readonly onEdit: () => void;
    /** The **Edit message** button, for whoever moves focus to it. */
    readonly editRef?: Ref<HTMLButtonElement>;
}

/** "2 embeds · plain text above · 3 buttons" — what the preview holds, in one line. */
function contentsLine(embeds: number, hasContent: boolean, buttons: number): string {
    const counted = embeds === 0 ? 'No embeds' : `${embeds} ${embeds === 1 ? 'embed' : 'embeds'}`;
    const parts = [counted, ...(hasContent ? ['plain text above'] : []), ...(buttons > 0 ? [`${buttons} ${buttons === 1 ? 'button' : 'buttons'}`] : [])];
    return parts.join(' · ');
}

export function MessagePreviewCard({ value, buttonCount = 0, onEdit, editRef }: MessagePreviewCardProps) {
    const preview = readStoredMessage(value);
    const isEmpty = !preview.content && preview.embeds.length === 0;

    return (
        <Stack
            gap={8}
            p={10}
            style={{
                background: 'var(--mantine-color-dark-7)',
                border: '1px solid var(--mantine-color-dark-5)',
                borderRadius: 'var(--mantine-radius-md)',
            }}
        >
            {preview.content ? (
                <Text size="12px" lineClamp={2}>
                    {preview.content}
                </Text>
            ) : null}

            {preview.embeds.map((embed, index) => (
                /*
                 * Keyed by position: embeds carry no identity of their own, and this list
                 * is read-only, so nothing here can be reordered under its key.
                 */
                <div
                    key={index}
                    style={{
                        borderLeft: `3px solid ${embed.color ?? DISCORD.embedGrey}`,
                        background: DISCORD.embed,
                        borderRadius: 4,
                        padding: '8px 10px',
                        color: DISCORD.text,
                    }}
                >
                    <Text size="12.5px" fw={700} lineClamp={1}>
                        {embed.title ?? `Embed ${index + 1}`}
                    </Text>
                    {embed.description ? (
                        <Text size="12px" c={DISCORD.muted} lineClamp={2}>
                            {embed.description}
                        </Text>
                    ) : null}
                </div>
            ))}

            <Group gap={8} wrap="nowrap">
                <Text size="11.5px" c="dark.2">
                    {isEmpty ? 'Nothing in it yet.' : contentsLine(preview.embeds.length, !!preview.content, buttonCount)}
                </Text>
                <Button
                    ref={editRef}
                    ml="auto"
                    style={{ flex: 'none' }}
                    variant="light"
                    size="xs"
                    leftSection={<IconPencil size={13} />}
                    onClick={onEdit}
                >
                    Edit message
                </Button>
            </Group>
        </Stack>
    );
}
