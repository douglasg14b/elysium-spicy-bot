import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BlockConfigField } from '@brattybot/web-sdk';
import { renderWithProviders } from '../../../__tests__/support/renderWithProviders';
import type { AvailableVariable } from '../../variables';
import type { ControlContext } from '../types';
import { VariableSelectControl } from '../VariableSelectControl';

/**
 * Picking a variable by name, filtered by kind.
 *
 * Clicked rather than asserted on the option list, because what has to hold is what
 * lands in the config — the bare name, never a token — and what the author sees when the
 * name they picked is no longer offered.
 */

const FIELD: Extract<BlockConfigField, { control: 'variableSelect' }> = {
    key: 'timeVariable',
    label: 'Saved time',
    control: 'variableSelect',
    valueKind: 'time',
};

const SEEN_AT: AvailableVariable = { name: 'seenAt', producerLabel: 'Record Typed', producerIcon: '🧪', valueKind: 'time' };
const PICK: AvailableVariable = { name: 'pick', producerLabel: 'Pick at Random', producerIcon: '🎲' };
const TICKET_CHANNEL: AvailableVariable = {
    name: 'ticketChannelId',
    producerLabel: 'Has Open Ticket?',
    producerIcon: '🎫',
    valueKind: 'channel',
};

function renderSelect(options: { variables: AvailableVariable[]; value?: string }) {
    const onChange = vi.fn();
    const context: ControlContext = {
        roles: [],
        channels: [],
        variables: options.variables,
        actorAvailable: true,
        declaredResources: [],
        setConfigKey: vi.fn(),
    };

    const rendered = renderWithProviders(
        <VariableSelectControl field={FIELD} value={options.value} onChange={onChange} context={context} />
    );
    return { ...rendered, onChange };
}

describe('picking a variable by name', () => {
    it('offers only variables of the field’s kind, and stores the bare name', async () => {
        const { user, onChange } = renderSelect({ variables: [SEEN_AT, PICK, TICKET_CHANNEL] });

        await user.click(screen.getByRole('textbox', { name: 'Saved time' }));

        expect(screen.queryByRole('option', { name: /pick ·/ })).toBeNull();
        expect(screen.queryByRole('option', { name: /ticketChannelId/ })).toBeNull();
        await user.click(screen.getByRole('option', { name: '🧪 seenAt · from Record Typed' }));
        expect(onChange).toHaveBeenCalledWith('seenAt');
    });

    it('shows a name no longer offered as not available here, never as a blank select', () => {
        renderSelect({ variables: [SEEN_AT], value: 'joinedAt' });

        expect(screen.getByRole('textbox', { name: 'Saved time' })).toHaveProperty(
            'value',
            'joinedAt — not available here'
        );
        expect(screen.getByText(/is not available here — the nearest block before this one/)).toBeTruthy();
    });

    it('says what to do when nothing before the block records one', () => {
        renderSelect({ variables: [PICK] });

        expect(screen.getByText(/No time variables before this block/)).toBeTruthy();
    });
});
