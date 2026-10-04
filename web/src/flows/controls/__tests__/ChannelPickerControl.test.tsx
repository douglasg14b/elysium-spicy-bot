import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BlockConfigField } from '../../../api/types';
import { renderWithProviders } from '../../../__tests__/support/renderWithProviders';
import type { AvailableVariable } from '../../variables';
import { ChannelPickerControl } from '../PickerControls';
import type { ControlContext } from '../types';

/**
 * The channel picker offering a channel an earlier block finds at run time.
 *
 * Rendered and clicked rather than asserted on the option list, because what has to
 * hold is what lands in the config: the token in the field, and no resource key left
 * beside it for install to write a snowflake over.
 */

const FIELD: Extract<BlockConfigField, { control: 'channelPicker' }> = {
    key: 'channelId',
    label: 'Channel',
    control: 'channelPicker',
};

const TICKET_CHANNEL: AvailableVariable = {
    name: 'ticketChannelId',
    producerLabel: 'Has Open Ticket?',
    producerIcon: '🎫',
    valueKind: 'channel',
};

function renderPicker(options: { variables: AvailableVariable[]; value?: string; config?: Record<string, unknown> }) {
    const onChange = vi.fn();
    const setConfigKey = vi.fn();
    const context: ControlContext = {
        roles: [],
        channels: [{ id: 'c1', name: 'lobby', type: 'text', parentId: null, parentName: null }],
        ticketTypes: [],
        variables: options.variables,
        actorAvailable: true,
        declaredResources: [],
        setConfigKey,
    };

    const rendered = renderWithProviders(
        <ChannelPickerControl
            field={FIELD}
            value={options.value ?? ''}
            onChange={onChange}
            context={context}
            config={options.config ?? {}}
        />
    );
    return { ...rendered, onChange, setConfigKey };
}

describe('the channel picker and earlier blocks', () => {
    it('stores the token, and clears any resource key, when a found channel is picked', async () => {
        const { user, onChange, setConfigKey } = renderPicker({
            variables: [TICKET_CHANNEL],
            config: { channelIdKey: 'old-resource' },
        });

        await user.click(screen.getByRole('textbox', { name: 'Channel' }));
        await user.click(screen.getByRole('option', { name: '🎫 ticketChannelId · from Has Open Ticket?' }));

        expect(onChange).toHaveBeenCalledWith('{{var.ticketChannelId}}');
        expect(setConfigKey).toHaveBeenCalledWith('channelIdKey', undefined);
    });

    it('offers only values that are channels', async () => {
        const { user } = renderPicker({
            variables: [TICKET_CHANNEL, { name: 'ticketId', producerLabel: 'Has Open Ticket?', producerIcon: '🎫' }],
        });

        await user.click(screen.getByRole('textbox', { name: 'Channel' }));

        expect(screen.queryByRole('option', { name: /ticketId ·/ })).toBeNull();
        expect(screen.getByRole('option', { name: /ticketChannelId/ })).toBeTruthy();
    });

    it('warns, and still shows what it holds, when nothing above records the picked value', () => {
        renderPicker({ variables: [], value: '{{var.ticketChannelId}}' });

        expect(screen.getByRole('textbox', { name: 'Channel' })).toHaveProperty(
            'value',
            '{{var.ticketChannelId}} — not found above'
        );
        expect(screen.getByText(/Nothing above this block records \{\{var\.ticketChannelId\}\}/)).toBeTruthy();
    });
});
