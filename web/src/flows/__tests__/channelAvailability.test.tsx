import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { BlockConfigField, FlowContextRequirement, NodeDescriptor } from '@brattybot/web-sdk';
import { NO_JOURNEY } from '../../__tests__/support/noJourney';
import { NO_UPLOADS } from '../../__tests__/support/noUploads';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { NodeInspector } from '../NodeInspector';
import {
    ALL_REQUIREMENTS_AVAILABLE,
    describeUnavailableRequirement,
    requirementsAvailableAt,
    type RequirementAvailability,
    type VariableSourceNode,
} from '../variables';

/**
 * How the builder shows "the channel this happened in" where a run can arrive with no
 * channel: the option is disabled, saying why, and the picker stays the author's way out. A
 * park above does not grey it — resume fetches the channel again. Hand-built descriptors, as
 * `subjectAvailability.test.tsx` uses, so this pins the builder's reading of the declaration.
 */

function descriptor(overrides: Partial<NodeDescriptor> & Pick<NodeDescriptor, 'type' | 'label'>): NodeDescriptor {
    return {
        kind: 'action',
        description: '',
        group: 'actions',
        icon: '🧪',
        configFields: [],
        handles: [{ label: 'Next', tone: 'neutral' }],
        outputs: [],
        requires: [],
        capabilities: [],
        canSuspend: false,
        ...overrides,
    };
}

/** The shared channel choice (`blocks/channelChoice.ts`), as a block taking it serves it. */
const CHANNEL_CHOICE: BlockConfigField = {
    key: 'where',
    label: 'Where',
    control: 'select',
    defaultValue: 'channel',
    options: [
        { value: 'channel', label: 'A channel I pick' },
        { value: 'here', label: 'The channel this happened in', requires: ['channel'] },
    ],
};

const POST = descriptor({
    type: 'action.post',
    label: 'Post',
    configFields: [
        CHANNEL_CHOICE,
        { key: 'channelId', label: 'Channel', control: 'channelPicker', visibleWhen: { field: 'where', equals: ['channel'] } },
    ],
});

function renderInspector(requirements: RequirementAvailability) {
    const onChange = vi.fn();
    const rendered = renderWithProviders(
        <NodeInspector
            descriptor={POST}
            nodeType={POST.type}
            label={POST.label}
            config={{}}
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

describe('the channel choice where a run can arrive with no channel', () => {
    it('disables "The channel this happened in", says why on hover, and leaves the picker', async () => {
        const { user, onChange } = renderInspector({ ...ALL_REQUIREMENTS_AVAILABLE, channel: 'fromTrigger' });

        await user.click(screen.getByRole('textbox', { name: 'Where' }));
        const here = screen.getByRole('option', { name: 'The channel this happened in' });

        expect(here.getAttribute('data-combobox-disabled')).toBe('true');
        expect(screen.getByTitle(describeUnavailableRequirement('channel', 'fromTrigger'))).toBeTruthy();
        await user.click(here);
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole('option', { name: 'A channel I pick' }).getAttribute('data-combobox-disabled')).toBeNull();
    });

    it('offers it where every run has a channel', async () => {
        const { user } = renderInspector(ALL_REQUIREMENTS_AVAILABLE);

        await user.click(screen.getByRole('textbox', { name: 'Where' }));

        expect(
            screen.getByRole('option', { name: 'The channel this happened in' }).getAttribute('data-combobox-disabled')
        ).toBeNull();
    });
});

describe('which runs reaching a node carry a channel', () => {
    const trigger = (type: string, requires: FlowContextRequirement[]): NodeDescriptor =>
        descriptor({ type, label: type, kind: 'trigger', group: 'triggers', requires });
    const canvasNode = (id: string, nodeDescriptor: NodeDescriptor): VariableSourceNode => ({
        id,
        data: { label: nodeDescriptor.label, config: {}, descriptor: nodeDescriptor },
    });
    const WAIT = descriptor({ type: 'action.wait', label: 'Wait', canSuspend: true });

    it('loses it below a trigger that happens nowhere, and keeps it below a button across a wait', () => {
        const below = (triggerDescriptor: NodeDescriptor) => {
            const nodes = [canvasNode('trigger', triggerDescriptor), canvasNode('wait', WAIT), canvasNode('post', POST)];
            const edges: Edge[] = [
                { id: 'e1', source: 'trigger', target: 'wait' },
                { id: 'e2', source: 'wait', target: 'post' },
            ];
            return requirementsAvailableAt('post', nodes, edges).channel;
        };

        expect(below(trigger('trigger.schedule', []))).toBe('fromTrigger');
        expect(below(trigger('trigger.buttonClick', ['subject', 'actor', 'channel', 'interaction']))).toBeNull();
    });
});
