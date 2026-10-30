import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BlockConfigField, NodeDescriptor } from '@brattybot/web-sdk';
import { NO_JOURNEY } from '../../__tests__/support/noJourney';
import { NO_UPLOADS } from '../../__tests__/support/noUploads';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { NodeInspector } from '../NodeInspector';
import { ALL_REQUIREMENTS_AVAILABLE, describeUnavailableRequirement, type RequirementAvailability } from '../variables';

/**
 * The checkbox control as the inspector draws it: ticking writes a boolean, and where the run
 * cannot carry what ticking needs (`requiresWhenOn`) an unticked box is disabled and says why —
 * while a ticked one stays clickable, since unticking is how the author makes the node valid.
 * A hand-built descriptor, as `channelAvailability.test.tsx` uses.
 */

const LABEL = 'Only the person who clicked sees it';

const BOX: BlockConfigField = {
    key: 'ephemeral',
    label: LABEL,
    description: 'Answers their button press privately.',
    control: 'toggle',
    defaultValue: false,
    requiresWhenOn: ['interaction'],
};

const SEND: NodeDescriptor = {
    type: 'action.send',
    label: 'Send',
    kind: 'action',
    description: '',
    group: 'actions',
    icon: '🧪',
    configFields: [BOX],
    handles: [{ label: 'Next', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
};

function renderInspector(requirements: RequirementAvailability, config: Record<string, unknown> = {}) {
    const onChange = vi.fn();
    const rendered = renderWithProviders(
        <NodeInspector
            descriptor={SEND}
            nodeType={SEND.type}
            label={SEND.label}
            config={config}
            roles={[]}
            channels={[]}
            ticketTypes={[]}
            variables={[]}
            requirements={requirements}
            declaredResources={[]}
            uploads={NO_UPLOADS}
            {...NO_JOURNEY}
            issues={[]}
            unconnectedExits={[]}
            onChange={onChange}
            onDelete={vi.fn()}
        />
    );
    return { ...rendered, onChange };
}

const box = (): HTMLInputElement => screen.getByRole('checkbox', { name: LABEL });

describe('the checkbox control', () => {
    it('shows its default when the node holds nothing, and writes a boolean on a click', async () => {
        const { user, onChange } = renderInspector(ALL_REQUIREMENTS_AVAILABLE);

        expect(box().checked).toBe(false);
        await user.click(box());

        expect(onChange).toHaveBeenCalledWith({ ephemeral: true });
    });

    it('shows a stored tick, and unticking writes false', async () => {
        const { user, onChange } = renderInspector(ALL_REQUIREMENTS_AVAILABLE, { ephemeral: true });

        expect(box().checked).toBe(true);
        await user.click(box());

        expect(onChange).toHaveBeenCalledWith({ ephemeral: false });
    });
});

describe('the checkbox where the run has no button press', () => {
    const NO_PRESS: RequirementAvailability = { ...ALL_REQUIREMENTS_AVAILABLE, interaction: 'afterParking' };

    it('disables an unticked box, saying why on hover', async () => {
        const { user, onChange } = renderInspector(NO_PRESS);

        expect(box().disabled).toBe(true);
        expect(screen.getByTitle(describeUnavailableRequirement('interaction', 'afterParking'))).toBeTruthy();
        await user.click(box());
        expect(onChange).not.toHaveBeenCalled();
    });

    it('leaves a ticked box clickable, so the author can untick it', async () => {
        const { user, onChange } = renderInspector(NO_PRESS, { ephemeral: true });

        expect(box().disabled).toBe(false);
        await user.click(box());

        expect(onChange).toHaveBeenCalledWith({ ephemeral: false });
    });
});
