import { screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { BlockConfigField } from '@brattybot/web-sdk';
import { NO_UPLOADS } from '../../__tests__/support/noUploads';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { renderControl } from '../controls/renderControl';
import type { ControlContext, ServerTimeZone } from '../controls/types';
import { ALL_REQUIREMENTS_AVAILABLE } from '../variables';

/**
 * The two clock-shaped controls, drawn through the same dispatcher the inspector uses:
 * a time of day round-trips 24-hour storage through hour, minute and AM/PM, and says
 * which zone it is in (or asks for one); days of the week sit Monday first and are
 * written in week order.
 */

const TIME_FIELD: BlockConfigField = { key: 'time', label: 'Time', control: 'timeOfDay', defaultValue: '09:00' };
const DAYS_FIELD: BlockConfigField = { key: 'days', label: 'Days', control: 'daysOfWeek' };

function contextWith(serverTimeZone?: ServerTimeZone): ControlContext {
    return {
        roles: [],
        channels: [],
        ticketTypes: [],
        variables: [],
        requirements: ALL_REQUIREMENTS_AVAILABLE,
        declaredResources: [],
        setConfigKey: () => undefined,
        uploads: NO_UPLOADS,
        ...(serverTimeZone ? { serverTimeZone } : {}),
    };
}

function renderField(field: BlockConfigField, value: unknown, serverTimeZone?: ServerTimeZone) {
    const onChange = vi.fn();
    const rendered = renderWithProviders(
        <MemoryRouter>{renderControl(field, value, onChange, contextWith(serverTimeZone))}</MemoryRouter>
    );
    return { ...rendered, onChange };
}

function inputNamed(name: string): HTMLInputElement {
    return screen.getByRole('textbox', { name }) as HTMLInputElement;
}

function radioNamed(name: string): HTMLInputElement {
    return screen.getByRole('radio', { name }) as HTMLInputElement;
}

function chipNamed(name: string): HTMLInputElement {
    return screen.getByRole('checkbox', { name }) as HTMLInputElement;
}

describe('the time-of-day control', () => {
    it('shows a stored 00:00 as 12:00 AM, and switching to PM writes 12:00', async () => {
        const { user, onChange } = renderField(TIME_FIELD, '00:00');

        expect(inputNamed('Time hour').value).toBe('12');
        expect(inputNamed('Time minute').value).toBe('00');
        expect(radioNamed('AM').checked).toBe(true);

        await user.click(screen.getByText('PM'));

        expect(onChange).toHaveBeenLastCalledWith('12:00');
    });

    it('shows a stored 12:30 as 12:30 PM, and switching to AM writes 00:30', async () => {
        const { user, onChange } = renderField(TIME_FIELD, '12:30');

        expect(inputNamed('Time hour').value).toBe('12');
        expect(inputNamed('Time minute').value).toBe('30');
        expect(radioNamed('PM').checked).toBe(true);

        await user.click(screen.getByText('AM'));

        expect(onChange).toHaveBeenLastCalledWith('00:30');
    });

    it('writes the hour and minute picked, any minute at all', async () => {
        const { user, onChange } = renderField(TIME_FIELD, '09:00');

        await user.click(inputNamed('Time hour'));
        await user.click(screen.getByRole('option', { name: '4' }));
        expect(onChange).toHaveBeenLastCalledWith('04:00');

        await user.click(inputNamed('Time minute'));
        await user.click(screen.getByRole('option', { name: '37' }));
        expect(onChange).toHaveBeenLastCalledWith('09:37');
    });

    it("says which zone the time is in once the server's has loaded", () => {
        renderField(TIME_FIELD, '09:00', { timeZone: 'America/New_York', defaultTimeZone: 'America/Los_Angeles' });

        expect(screen.queryByText('Server time: America/New_York')).not.toBeNull();
        expect(screen.queryByText(/Not set/)).toBeNull();
    });

    it('asks for a zone while none is picked, linking to Server Settings', () => {
        renderField(TIME_FIELD, '09:00', { timeZone: null, defaultTimeZone: 'America/Los_Angeles' });

        const ask = screen.getByText(/Not set: using Pacific Time until you pick one in/);
        expect(within(ask).getByRole('link', { name: 'Server Settings' }).getAttribute('href')).toBe('/settings');
        expect(screen.queryByText(/Server time/)).toBeNull();
    });

    it('says nothing about the zone while the setting has not loaded, or failed to', () => {
        renderField(TIME_FIELD, '09:00');

        expect(screen.queryByText(/Server time/)).toBeNull();
        expect(screen.queryByText(/Not set/)).toBeNull();
    });
});

describe('the days-of-week control', () => {
    it('offers the days Monday first, none picked', () => {
        renderField(DAYS_FIELD, []);

        const chips = screen.getAllByRole('checkbox') as HTMLInputElement[];
        expect(chips.map((chip) => chip.value)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
        expect(chips.some((chip) => chip.checked)).toBe(false);
    });

    it('writes the days in week order, whatever order they were picked in', async () => {
        const { user, onChange } = renderField(DAYS_FIELD, ['fri']);

        await user.click(chipNamed('Mon'));

        expect(onChange).toHaveBeenLastCalledWith(['mon', 'fri']);
    });

    it('unpicks a day on a second click', async () => {
        const { user, onChange } = renderField(DAYS_FIELD, ['mon', 'wed']);

        expect(chipNamed('Wed').checked).toBe(true);
        await user.click(chipNamed('Wed'));

        expect(onChange).toHaveBeenLastCalledWith(['mon']);
    });
});
