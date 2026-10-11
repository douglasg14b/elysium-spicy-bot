import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BlockConfigField, ResourceDeclaration, TicketTypeView } from '../../../api/types';
import { renderWithProviders } from '../../../__tests__/support/renderWithProviders';
import { ALL_REQUIREMENTS_AVAILABLE } from '../../variables';
import { TicketTypePickerControl } from '../TicketTypePickerControl';
import type { ControlContext } from '../types';

/**
 * The ticket-type picker: the guild's own declared types by label, stored by key, and a
 * key the guild no longer declares shown for what it is rather than as nothing.
 */

const PERMISSIONS: TicketTypeView['permissions'] = {
    subject: { view: true, send: true, readHistory: true, manageMessages: false },
    opener: { view: true, send: true, readHistory: true, manageMessages: false },
    staff: { view: true, send: true, readHistory: true, manageMessages: true },
};

/** Types this guild declared itself — the seeded two are nowhere in sight, and nothing misses them. */
const TYPES: TicketTypeView[] = [
    { type: 'aftercare', label: 'Aftercare Check-in', nameTemplate: 'aftercare-{{####}}', permissions: PERMISSIONS, autoClaimOnOpen: false },
    { type: 'punishment-review', label: 'Punishment Review', nameTemplate: 'review-{{####}}', permissions: PERMISSIONS, autoClaimOnOpen: true },
];

type TicketTypeField = Extract<BlockConfigField, { control: 'ticketTypePicker' }>;

const REQUIRED: TicketTypeField = { key: 'ticketType', label: 'Ticket type', control: 'ticketTypePicker' };
const OPTIONAL: TicketTypeField = { ...REQUIRED, optional: true };

/** A journey's declared ticket type — keyed like one the guild already has, on purpose. */
const DECLARED: ResourceDeclaration = {
    key: 'aftercare',
    kind: 'ticketType',
    defaultName: 'Aftercare (journey)',
    ticketType: { nameTemplate: 'care-{{####}}', permissions: PERMISSIONS, autoClaimOnOpen: false },
};

function renderPicker(
    options: {
        field?: TicketTypeField;
        value?: string;
        ticketTypes?: TicketTypeView[];
        declaredResources?: ResourceDeclaration[];
        config?: Record<string, unknown>;
    } = {}
) {
    const onChange = vi.fn();
    const setConfigKey = vi.fn();
    const context: ControlContext = {
        roles: [],
        channels: [],
        ticketTypes: options.ticketTypes ?? TYPES,
        variables: [],
        requirements: ALL_REQUIREMENTS_AVAILABLE,
        declaredResources: options.declaredResources ?? [],
        setConfigKey,
    };

    const rendered = renderWithProviders(
        <TicketTypePickerControl
            field={options.field ?? REQUIRED}
            value={options.value ?? ''}
            onChange={onChange}
            context={context}
            config={options.config ?? {}}
        />
    );
    return { ...rendered, onChange, setConfigKey };
}

/** Mantine's clear button, which carries no accessible name of its own. */
function clearButton(): Element | null {
    return document.querySelector('.mantine-InputClearButton-root');
}

describe('the ticket-type picker', () => {
    it('offers the guild’s own types by label and stores the key', async () => {
        const { user, onChange } = renderPicker();

        await user.click(screen.getByRole('textbox', { name: 'Ticket type' }));
        expect(screen.getByRole('option', { name: 'Aftercare Check-in' })).toBeTruthy();
        await user.click(screen.getByRole('option', { name: 'Punishment Review' }));

        expect(onChange).toHaveBeenCalledWith('punishment-review');
    });

    it('shows a key the guild no longer declares as not available here, and says why', () => {
        renderPicker({ value: 'retired-type' });

        expect((screen.getByRole('textbox', { name: 'Ticket type' }) as HTMLInputElement).value).toBe(
            'retired-type — not available here'
        );
        expect(screen.getByText(/doesn.t declare a .retired-type. ticket type any more/)).toBeTruthy();
    });

    it('lets an optional pick be cleared, which removes the key — and a required one cannot be', async () => {
        const required = renderPicker({ value: 'aftercare' });
        expect(clearButton()).toBeNull();
        required.unmount();

        const { user, onChange } = renderPicker({ field: OPTIONAL, value: 'aftercare' });
        const clear = clearButton();
        if (!clear) throw new Error('An optional ticket-type pick offered no way to clear it.');
        await user.click(clear);

        expect(onChange).toHaveBeenCalledWith(undefined);
    });

    it('says so when the guild has no ticket types at all', () => {
        renderPicker({ ticketTypes: [] });

        expect(screen.getByText(/no ticket types yet/)).toBeTruthy();
    });
});

describe('a ticket type the journey declares', () => {
    it('is offered beside the guild’s own of the same key, and picking it writes the sidecar and removes the field', async () => {
        // Same key on both sides: without the `resource:` value prefix Mantine would be
        // handed two options with one value.
        const { user, onChange, setConfigKey } = renderPicker({ field: OPTIONAL, declaredResources: [DECLARED] });

        await user.click(screen.getByRole('textbox', { name: 'Ticket type' }));
        expect(screen.getByRole('option', { name: 'Aftercare Check-in' })).toBeTruthy();
        await user.click(screen.getByRole('option', { name: 'Aftercare (journey)' }));

        expect(setConfigKey).toHaveBeenCalledWith('ticketTypeKey', 'aftercare');
        // Removed, not blanked — an optional field's schema refuses ''.
        expect(onChange).toHaveBeenCalledWith(undefined);
    });

    it('clears the sidecar when the guild’s own type is picked instead', async () => {
        const { user, onChange, setConfigKey } = renderPicker({
            declaredResources: [DECLARED],
            config: { ticketTypeKey: 'aftercare' },
        });

        await user.click(screen.getByRole('textbox', { name: 'Ticket type' }));
        await user.click(screen.getByRole('option', { name: 'Punishment Review' }));

        expect(setConfigKey).toHaveBeenCalledWith('ticketTypeKey', undefined);
        expect(onChange).toHaveBeenCalledWith('punishment-review');
    });

    it('shows a waiting pick as the declared type, says it arrives at install, and does not call it stale', () => {
        renderPicker({ declaredResources: [DECLARED], config: { ticketTypeKey: 'aftercare' } });

        expect((screen.getByRole('textbox', { name: 'Ticket type' }) as HTMLInputElement).value).toBe('Aftercare (journey)');
        expect(screen.getByText(/Wired in when this flow.s resources are installed/)).toBeTruthy();
        expect(screen.queryByText(/any more/)).toBeNull();
    });
});
