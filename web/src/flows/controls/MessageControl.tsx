/**
 * A whole Discord message — plain text and embeds — as one object-valued key, and the buttons
 * under it when the field names a `buttonsKey`.
 *
 * The inspector is too narrow to draw an embed, so it shows a compact preview
 * (`MessagePreviewCard`), how many problems the server found inside the message, and the
 * button that opens the message window (`../messageEditor`), where every part is edited in
 * place. The buttons are drawn and edited there too, under the embeds, and written into their
 * own key (`context.setConfigKey`).
 */

import { useState } from 'react';
import { Stack, Text } from '@mantine/core';
import type { BlockConfigField, ButtonListener } from '@brattybot/web-sdk';
import { MessageEditor } from '../messageEditor/MessageEditor';
import { MessagePreviewCard } from '../messageEditor/MessagePreviewCard';
import { problemCount } from '../validationIssues';
import { asMessageButtons, type ControlProps } from './types';

type MessageField = Extract<BlockConfigField, { control: 'message' }>;

const NO_SWATCHES: readonly string[] = [];

/**
 * Who listens to a block's buttons: nobody yet. A press on one answers "Nothing's hooked up to
 * this yet" until a Button Click trigger can name a block's button (step 2 of
 * `docs/plans/block-message-buttons-step-1.md`).
 */
const NO_LISTENERS: readonly ButtonListener[] = [];

export function MessageControl({ field, value, onChange, context, config, error, issues }: ControlProps<MessageField>) {
    const [editing, setEditing] = useState(false);
    const problems = issues?.length ?? 0;
    const { buttonsKey } = field;

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

            <MessagePreviewCard
                value={value}
                buttonCount={buttonsKey ? asMessageButtons(config?.[buttonsKey]).length : undefined}
                onEdit={() => setEditing(true)}
            />

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
                    buttons={
                        buttonsKey
                            ? {
                                  value: asMessageButtons(config?.[buttonsKey]),
                                  onChange: (next) => context.setConfigKey(buttonsKey, next),
                                  listeners: NO_LISTENERS,
                                  serverEmojis: context.serverEmojis,
                              }
                            : undefined
                    }
                    onClose={() => setEditing(false)}
                />
            ) : null}
        </Stack>
    );
}
