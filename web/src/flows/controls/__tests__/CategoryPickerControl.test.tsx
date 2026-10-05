import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BlockConfigField, ResourceDeclaration } from '../../../api/types';
import { renderWithProviders } from '../../../__tests__/support/renderWithProviders';
import { ALL_REQUIREMENTS_AVAILABLE } from '../../variables';
import { CategoryPickerControl } from '../PickerControls';
import type { ControlContext } from '../types';

/**
 * The category picker: categories only, real or declared, and what lands in the config.
 *
 * Clicked rather than asserted on an option list, because what has to hold is the pair
 * the server binds — the snowflake in the field and the declaration in its sidecar.
 */

const FIELD: Extract<BlockConfigField, { control: 'categoryPicker' }> = {
    key: 'categoryId',
    label: 'Category',
    control: 'categoryPicker',
};

const DECLARED_CATEGORY: ResourceDeclaration = { key: 'tickets', kind: 'category', defaultName: 'Tickets' };

function renderPicker(options: { declaredResources?: ResourceDeclaration[]; config?: Record<string, unknown> } = {}) {
    const onChange = vi.fn();
    const setConfigKey = vi.fn();
    const context: ControlContext = {
        roles: [],
        channels: [
            { id: 'cat-1', name: 'Dungeon', type: 'category', parentId: null, parentName: null },
            { id: 'c1', name: 'lobby', type: 'text', parentId: 'cat-1', parentName: 'Dungeon' },
        ],
        ticketTypes: [],
        variables: [],
        requirements: ALL_REQUIREMENTS_AVAILABLE,
        declaredResources: options.declaredResources ?? [],
        setConfigKey,
    };

    const rendered = renderWithProviders(
        <CategoryPickerControl field={FIELD} value="" onChange={onChange} context={context} config={options.config ?? {}} />
    );
    return { ...rendered, onChange, setConfigKey };
}

describe('the category picker', () => {
    it('offers categories and never a channel, and stores the id with no sidecar', async () => {
        const { user, onChange, setConfigKey } = renderPicker({ config: { categoryIdKey: 'old-resource' } });

        await user.click(screen.getByRole('textbox', { name: 'Category' }));

        expect(screen.queryByRole('option', { name: /lobby/ })).toBeNull();
        await user.click(screen.getByRole('option', { name: 'Dungeon' }));

        expect(onChange).toHaveBeenCalledWith('cat-1');
        expect(setConfigKey).toHaveBeenCalledWith('categoryIdKey', undefined);
    });

    it('offers a category the flow declares, storing its key beside an empty id', async () => {
        const { user, onChange, setConfigKey } = renderPicker({
            declaredResources: [DECLARED_CATEGORY, { key: 'lounge', kind: 'textChannel', defaultName: 'lounge' }],
        });

        await user.click(screen.getByRole('textbox', { name: 'Category' }));

        // A declared text channel is not a category, so it is not on offer.
        expect(screen.queryByRole('option', { name: 'lounge' })).toBeNull();
        await user.click(screen.getByRole('option', { name: 'Tickets' }));

        expect(setConfigKey).toHaveBeenCalledWith('categoryIdKey', 'tickets');
        expect(onChange).toHaveBeenCalledWith('');
    });

    it('says plainly when the picked category is not created yet', () => {
        renderPicker({ declaredResources: [DECLARED_CATEGORY], config: { categoryIdKey: 'tickets' } });

        expect(screen.getByText(/Not created yet/)).toBeTruthy();
    });
});
