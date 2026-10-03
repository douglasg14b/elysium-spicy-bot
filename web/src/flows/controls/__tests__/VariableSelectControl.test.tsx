import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BlockConfigField } from '../../../api/types';
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

/** A field declaring no kind, which takes any variable — Compare's. */
const ANY_FIELD: Extract<BlockConfigField, { control: 'variableSelect' }> = {
    key: 'variableName',
    label: 'Variable',
    control: 'variableSelect',
};

function renderSelect(options: { variables: AvailableVariable[]; value?: string; field?: typeof FIELD }) {
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
        <VariableSelectControl field={options.field ?? FIELD} value={options.value} onChange={onChange} context={context} />
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

describe('picking any variable, when the field declares no kind', () => {
    it('offers variables of every kind and none, and stores the bare name', async () => {
        const { user, onChange } = renderSelect({ variables: [SEEN_AT, PICK, TICKET_CHANNEL], field: ANY_FIELD });

        await user.click(screen.getByRole('textbox', { name: 'Variable' }));

        expect(screen.getByRole('option', { name: '🧪 seenAt · from Record Typed' })).toBeTruthy();
        expect(screen.getByRole('option', { name: '🎫 ticketChannelId · from Has Open Ticket?' })).toBeTruthy();
        await user.click(screen.getByRole('option', { name: '🎲 pick · from Pick at Random' }));
        expect(onChange).toHaveBeenCalledWith('pick');
    });

    it('drops the kind from its wording', () => {
        renderSelect({ variables: [], field: ANY_FIELD });

        expect(screen.getByPlaceholderText('Pick a variable')).toBeTruthy();
        expect(screen.getByText(/^No variables before this block/)).toBeTruthy();
    });

    it('still marks a stored name no longer offered as not available here', () => {
        renderSelect({ variables: [PICK], value: 'count', field: ANY_FIELD });

        expect(screen.getByText(/“count” is not available here — no block before this one records it\./)).toBeTruthy();
    });
});
