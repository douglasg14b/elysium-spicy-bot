/**
 * A button's label and style, as the message window's button box and the Button Click
 * trigger's "+ New button" both ask for them — one pair of fields, so a button reads the same
 * wherever it is made.
 */

import { Group, SegmentedControl, Text, TextInput } from '@mantine/core';
import type { MessageButtonStyle } from '@brattybot/web-sdk';
import { BUTTON_STYLE_ORDER, BUTTON_STYLES } from './discordLook';
import { BUTTON_LABEL_RULE } from './partRules';

interface ButtonLabelFieldProps {
    readonly value: string;
    readonly onChange: (next: string) => void;
    readonly autoFocus?: boolean;
}

/** The label, with how much of its 80 characters it spends. */
export function ButtonLabelField({ value, onChange, autoFocus }: ButtonLabelFieldProps) {
    const maxLength = BUTTON_LABEL_RULE.maxLength ?? Number.POSITIVE_INFINITY;
    const over = value.length > maxLength;

    return (
        <TextInput
            label="Label"
            value={value}
            data-autofocus={autoFocus || undefined}
            onChange={(event) => onChange(event.currentTarget.value)}
            rightSectionWidth={64}
            rightSection={
                <Text size="11px" c={over ? 'red.4' : 'dark.2'}>
                    {value.length} / {BUTTON_LABEL_RULE.maxLength}
                </Text>
            }
        />
    );
}

interface ButtonStyleFieldProps {
    readonly value: MessageButtonStyle;
    readonly onChange: (next: MessageButtonStyle) => void;
}

/** The style, each named as the dashboard calls it beside a swatch of Discord's colour. */
export function ButtonStyleField({ value, onChange }: ButtonStyleFieldProps) {
    return (
        <div>
            <Text size="sm" fw={500} mb={4}>
                Style
            </Text>
            <SegmentedControl
                fullWidth
                size="xs"
                aria-label="Style"
                value={value}
                onChange={(next) => onChange(next as MessageButtonStyle)}
                data={BUTTON_STYLE_ORDER.map((style) => ({
                    value: style,
                    label: (
                        <Group gap={5} wrap="nowrap" justify="center">
                            <span
                                aria-hidden
                                style={{ width: 9, height: 9, borderRadius: 2, background: BUTTON_STYLES[style].colour, flex: 'none' }}
                            />
                            {BUTTON_STYLES[style].name}
                        </Group>
                    ),
                }))}
            />
        </div>
    );
}
