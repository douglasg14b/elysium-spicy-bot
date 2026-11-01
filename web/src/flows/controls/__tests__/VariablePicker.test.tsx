import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../__tests__/support/renderWithProviders';
import { ALL_REQUIREMENTS_AVAILABLE, type AvailableVariable } from '../../variables';
import { VariablePicker } from '../VariablePicker';

/**
 * The `#name` chip: a channel variable inserted as a link, offered only where Discord shows
 * one. Clicked, because what has to hold is the token that lands in the copy.
 */

const TICKET_CHANNEL: AvailableVariable = {
    name: 'ticketChannelId',
    producerLabel: 'Has Open Ticket?',
    producerIcon: '🎫',
    valueKind: 'channel',
};
const PICK: AvailableVariable = { name: 'pick', producerLabel: 'Pick at Random', producerIcon: '🎲' };

function renderPicker(channelLinks: boolean) {
    const onInsert = vi.fn();
    const rendered = renderWithProviders(
        <VariablePicker
            variables={[TICKET_CHANNEL, PICK]}
            requirements={ALL_REQUIREMENTS_AVAILABLE}
            value=""
            onInsert={onInsert}
            channelLinks={channelLinks}
        />
    );
    return { ...rendered, onInsert };
}

describe('VariablePicker channel links', () => {
    it('inserts a channel variable as a link', async () => {
        const { user, onInsert } = renderPicker(true);

        await user.click(screen.getByRole('button', { name: '#ticketChannelId' }));

        expect(onInsert).toHaveBeenCalledWith('<#{{var.ticketChannelId}}>');
    });

    it('keeps the plain chip beside it, for the bare id', async () => {
        const { user, onInsert } = renderPicker(true);

        await user.click(screen.getByRole('button', { name: 'ticketChannelId' }));

        expect(onInsert).toHaveBeenCalledWith('{{var.ticketChannelId}}');
    });

    it('offers no link for a variable that is not a channel', () => {
        renderPicker(true);

        expect(screen.getByRole('button', { name: 'pick' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: '#pick' })).toBeNull();
    });

    it('offers no link where Discord would not show one', () => {
        renderPicker(false);

        expect(screen.getByRole('button', { name: 'ticketChannelId' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: '#ticketChannelId' })).toBeNull();
    });
});
