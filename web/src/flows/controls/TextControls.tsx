/**
 * Free-text controls. `text` is one line; `longText` autosizes for a message body.
 */

import { Textarea, TextInput } from '@mantine/core';
import { asText, type ControlProps } from './types';
import type { BlockConfigField } from '../../api/types';

type TextField = Extract<BlockConfigField, { control: 'text' }>;
type LongTextField = Extract<BlockConfigField, { control: 'longText' }>;

/** Single-line text. */
export function TextControl({ field, value, onChange }: ControlProps<TextField>) {
    return (
        <TextInput
            label={field.label}
            description={field.description}
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            value={asText(value)}
            onChange={(event) => onChange(event.currentTarget.value)}
        />
    );
}

/** Autosizing multi-line text. */
export function LongTextControl({ field, value, onChange }: ControlProps<LongTextField>) {
    return (
        <Textarea
            label={field.label}
            description={field.description}
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            autosize
            minRows={4}
            maxRows={10}
            value={asText(value)}
            onChange={(event) => onChange(event.currentTarget.value)}
        />
    );
}
