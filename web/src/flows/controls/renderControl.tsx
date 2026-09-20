/**
 * The one dispatcher from a declared field to its widget.
 *
 * This switch is on the **control vocabulary**, not on block type — which is
 * exactly the shape the block contract intends. Adding a control to
 * `BLOCK_CONTROL_TYPES` fails to compile here until it is implemented, so the
 * vocabulary and the builder cannot drift.
 */

import type { ReactElement } from 'react';
import { Text } from '@mantine/core';
import type { BlockConfigField } from '../../api/types';
import { EligibilityControl } from './EligibilityControl';
import { ChannelPickerControl, RolePickerControl } from './PickerControls';
import { ColourControl } from './ColourControl';
import { DurationControl } from './DurationControl';
import { SegmentedChoiceControl, SelectChoiceControl } from './ChoiceControls';
import { LongTextControl, TextControl } from './TextControls';
import { ObjectListControl } from './ObjectListControl';
import { TextListControl } from './TextListControl';
import type { ControlChange, ControlContext } from './types';

/**
 * Render one config field's control.
 *
 * @param field - The block's own declaration of this field.
 * @param value - The current `node.data` value for `field.key`.
 * @param onChange - Emits the next value; `undefined` removes the key.
 * @param context - Guild roles and channels, for the pickers.
 * @param config - The whole node's config, for controls reading a sibling key.
 * @param error - Why the last save refused this field, if it did. Passed to every
 * control rather than to the ones that happen to want it, so a new control gets
 * field-level errors by taking the prop it already has.
 */
export function renderControl(
    field: BlockConfigField,
    value: unknown,
    onChange: ControlChange,
    context: ControlContext,
    config?: Record<string, unknown>,
    error?: string
): ReactElement {
    const props = { value, onChange, context, config, error };

    switch (field.control) {
        case 'rolePicker':
            return <RolePickerControl field={field} {...props} />;
        case 'channelPicker':
            return <ChannelPickerControl field={field} {...props} />;
        case 'text':
            return <TextControl field={field} {...props} />;
        case 'longText':
            return <LongTextControl field={field} {...props} />;
        case 'duration':
            return <DurationControl field={field} {...props} />;
        case 'segmented':
            return <SegmentedChoiceControl field={field} {...props} />;
        case 'select':
            return <SelectChoiceControl field={field} {...props} />;
        case 'colour':
            return <ColourControl field={field} {...props} />;
        case 'textList':
            return <TextListControl field={field} {...props} />;
        case 'objectList':
            return <ObjectListControl field={field} {...props} />;
        case 'eligibility':
            return <EligibilityControl field={field} {...props} />;
        default: {
            // Adding a member to `BLOCK_CONTROL_TYPES` without implementing it here
            // is a compile error, by design.
            const unhandled: never = field;
            /*
             * Reached only when the server is newer than this bundle and sends a
             * control this build has never heard of. Shown rather than thrown: the
             * inspector has no error boundary above it, so throwing would take the
             * canvas and any unsaved edits down with it. The unknown *block* path
             * degrades the same way.
             */
            return <UnknownControl field={unhandled} />;
        }
    }
}

/**
 * Placeholder for a control type this build cannot draw.
 *
 * Names the field and the control so the mismatch is diagnosable, and says plainly
 * that the value is untouched — an author who cannot edit a field still needs to
 * know the flow will save with whatever is already in it.
 */
function UnknownControl({ field }: { field: BlockConfigField }) {
    return (
        <div>
            <Text size="12px" fw={700} mb={4}>
                {field.label}
            </Text>
            <Text size="11.5px" c="yellow.5">
                This build can&apos;t edit a “{field.control}” field. Update the dashboard to
                change it — it&apos;ll save untouched until then.
            </Text>
        </div>
    );
}
