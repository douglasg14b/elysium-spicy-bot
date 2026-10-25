/**
 * A whole Discord message — plain text and embeds — as one object-valued key.
 *
 * The inspector is too narrow to draw an embed, so it shows a compact preview
 * (`MessagePreviewCard`), how many problems the server found inside the message, and the
 * button that opens the message window (`../messageEditor`), where every part is edited in
 * place.
 */

import { useState } from 'react';
import { Stack, Text } from '@mantine/core';
import type { BlockConfigField } from '@brattybot/web-sdk';
import { MessageEditor } from '../messageEditor/MessageEditor';
import { MessagePreviewCard } from '../messageEditor/MessagePreviewCard';
import { problemCount } from '../validationIssues';
import type { ControlProps } from './types';

type MessageField = Extract<BlockConfigField, { control: 'message' }>;

const NO_SWATCHES: readonly string[] = [];

export function MessageControl({ field, value, onChange, context, error, issues }: ControlProps<MessageField>) {
    const [editing, setEditing] = useState(false);
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

            <MessagePreviewCard value={value} onEdit={() => setEditing(true)} />

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
