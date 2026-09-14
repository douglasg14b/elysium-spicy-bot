/**
 * Free-text controls. `text` is one line; `longText` autosizes for a message body.
 */

import { Textarea, TextInput } from '@mantine/core';
import { asText, type ControlProps } from './types';
import type { BlockConfigField } from '../../api/types';

type TextField = Extract<BlockConfigField, { control: 'text' }>;
type LongTextField = Extract<BlockConfigField, { control: 'longText' }>;

/**
 * The browser's hard character cap, which a copy field must not have.
 *
 * `maxLength` on the input stops the author typing past the limit — correct for a
 * plain string, wrong for copy, because the engine measures the string *after*
 * `{{subject.mention}}` and friends expand. A 1990-character template with three
 * mentions in it is under the cap here and over it at runtime, and nothing on the
 * save path can tell. Letting the author type it and failing nameably at render
 * beats a cap that quietly measures the wrong string.
 */
function hardLimit(field: TextField | LongTextField): number | undefined {
    return field.rendersTokens ? undefined : field.maxLength;
}

/** The limit as advice, for a field where it cannot be enforced as you type. */
function limitHint(field: TextField | LongTextField): string | undefined {
    if (!field.rendersTokens || field.maxLength === undefined) {
        return field.description;
    }

    const limit = `Up to ${field.maxLength} characters once any {{tokens}} are filled in.`;
    return field.description ? `${field.description} ${limit}` : limit;
}

/** Single-line text. */
export function TextControl({ field, value, onChange }: ControlProps<TextField>) {
    return (
        <TextInput
            label={field.label}
            description={limitHint(field)}
            placeholder={field.placeholder}
            maxLength={hardLimit(field)}
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
            description={limitHint(field)}
            placeholder={field.placeholder}
            maxLength={hardLimit(field)}
            autosize
            minRows={4}
            maxRows={10}
            value={asText(value)}
            onChange={(event) => onChange(event.currentTarget.value)}
        />
    );
}
