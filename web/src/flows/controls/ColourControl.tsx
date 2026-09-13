/**
 * Hex colour picker, with the swatches the field declares.
 */

import { ColorInput } from '@mantine/core';
import { asText, type ControlProps } from './types';
import type { BlockConfigField } from '../../api/types';

type ColourField = Extract<BlockConfigField, { control: 'colour' }>;

/**
 * `#RRGGBB` colour with declared swatches.
 *
 * Falls back to the declared default for display without writing it, on the same
 * reasoning as the choice controls: the graph is brought up to date once on load,
 * not from inside a render. Harmless here regardless — every block using this
 * treats colour as optional.
 */
export function ColourControl({ field, value, onChange }: ControlProps<ColourField>) {
    return (
        <ColorInput
            label={field.label}
            description={field.description}
            format="hex"
            value={asText(value) || field.defaultValue || ''}
            onChange={(next) => onChange(next)}
            swatches={field.swatches ? [...field.swatches] : undefined}
        />
    );
}
