/**
 * A whole Discord message — plain text and embeds — as one object-valued key.
 *
 * The inspector is too narrow to draw an embed, so it shows a compact preview — each embed's
 * title and body beside its colour stripe — how many problems the server found inside the
 * message, and the button that opens the message window (`../messageEditor`), where every
 * part is edited in place.
 */

import { useState } from 'react';
import { Button, Group, Stack, Text } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import type { BlockConfigField } from '@brattybot/web-sdk';
import { MessageEditor } from '../messageEditor/MessageEditor';
import { DISCORD } from '../messageEditor/discordLook';
import { readStoredMessage } from '../storedMessage';
import { problemCount } from '../validationIssues';
import type { ControlProps } from './types';

type MessageField = Extract<BlockConfigField, { control: 'message' }>;

const NO_SWATCHES: readonly string[] = [];

/** "2 embeds · plain text above" — what the preview holds, in one line. */
function contentsLine(embeds: number, hasContent: boolean): string {
    const counted = embeds === 0 ? 'No embeds' : `${embeds} ${embeds === 1 ? 'embed' : 'embeds'}`;
    return hasContent ? `${counted} · plain text above` : counted;
}

export function MessageControl({ field, value, onChange, context, error, issues }: ControlProps<MessageField>) {
    const [editing, setEditing] = useState(false);
    const preview = readStoredMessage(value);
    const isEmpty = !preview.content && preview.embeds.length === 0;
    const problems = issues?.length ?? 0;

    return (
        <Stack gap={6}>
            <div>
                <Text size="12px" fw={700}>
                    {field.label}
                </Text>
                {field.description ? (
                    <Text size="11.5px" c="dimmed">
                        {field.description}
                    </Text>
                ) : null}
            </div>

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
                        {isEmpty ? 'Nothing in it yet.' : contentsLine(preview.embeds.length, !!preview.content)}
                    </Text>
                    <Button
                        ml="auto"
                        style={{ flex: 'none' }}
                        variant="light"
                        size="xs"
                        leftSection={<IconPencil size={13} />}
                        onClick={() => setEditing(true)}
                    >
                        Edit message
                    </Button>
                </Group>
            </Stack>

            {problems > 0 ? (
                <Text size="11.5px" c="red.5">
                    {problemCount(problems)} in this message
                </Text>
            ) : null}
            {error ? (
                <Text size="11.5px" c="red.5">
                    {error}
                </Text>
            ) : null}

            {editing ? (
                <MessageEditor
                    title={field.label}
                    description={field.description}
                    swatches={field.swatches ?? NO_SWATCHES}
                    value={value}
                    onChange={onChange}
                    variables={context.variables}
                    requirements={context.requirements}
                    uploads={context.uploads}
                    issues={issues ?? []}
                    error={error}
                    onClose={() => setEditing(false)}
                />
            ) : null}
        </Stack>
    );
}
