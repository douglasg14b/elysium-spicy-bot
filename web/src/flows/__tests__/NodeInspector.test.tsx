import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FlowValidationIssue, NodeDescriptor } from '../../api/types';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { NodeInspector } from '../NodeInspector';

/**
 * The inspector draws only the fields that apply, places a hidden field's issue at node
 * level, and repeats the card's warning about a forgotten exit.
 *
 * Rendered rather than asserted on the field list, because what has to hold is what the
 * author sees: no control for a field that does not apply, and nothing the server said
 * dropped because its control is gone.
 */

const DESCRIPTOR: NodeDescriptor = {
    type: 'action.test',
    kind: 'action',
    label: 'Sometimes',
    description: 'Shows a field only when it applies.',
    group: 'actions',
    icon: '🫥',
    configFields: [
        {
            key: 'mode',
            label: 'Mode',
            control: 'select',
            defaultValue: 'plain',
            options: [
                { value: 'plain', label: 'Plain' },
                { value: 'copy', label: 'Copy' },
            ],
        },
        { key: 'note', label: 'Note', control: 'text', visibleWhen: { field: 'mode', equals: ['copy'] } },
    ],
    fieldChecks: {},
    handles: [{ label: 'Next', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
};

function renderInspector(options: {
    config: Record<string, unknown>;
    issues?: FlowValidationIssue[];
    unconnectedExits?: string[];
}) {
    return renderWithProviders(
        <NodeInspector
            descriptor={DESCRIPTOR}
            nodeType={DESCRIPTOR.type}
            label={DESCRIPTOR.label}
            config={options.config}
            roles={[]}
            channels={[]}
            ticketTypes={[]}
            variables={[]}
            actorAvailable
            declaredResources={[]}
            issues={options.issues ?? []}
            unconnectedExits={options.unconnectedExits ?? []}
            onChange={vi.fn()}
            onDelete={vi.fn()}
        />
    );
}

describe('the inspector and fields that only sometimes apply', () => {
    it('shows a field while its sibling holds a value that shows it', () => {
        renderInspector({ config: { mode: 'copy' } });

        expect(screen.getByRole('textbox', { name: 'Note' })).toBeTruthy();
    });

    it('hides it by the sibling’s value, even with a value of its own', () => {
        renderInspector({ config: { mode: 'plain', note: 'still held' } });

        expect(screen.queryByRole('textbox', { name: 'Note' })).toBeNull();
    });

    it('hides it by the sibling’s default when the sibling holds nothing', () => {
        renderInspector({ config: {} });

        expect(screen.queryByRole('textbox', { name: 'Note' })).toBeNull();
    });

    it('lists a server issue on a hidden field at node level rather than dropping it', () => {
        renderInspector({
            config: { mode: 'plain', note: 'still held' },
            issues: [{ nodeId: 'node', field: 'note', message: 'That is far too long.' }],
        });

        expect(screen.getByText("This block can't go live yet")).toBeTruthy();
        expect(screen.getByText('note: That is far too long.')).toBeTruthy();
    });

    it('says which exit a run would stop at', () => {
        renderInspector({ config: {}, unconnectedExits: ['No record'] });

        expect(screen.getByText("No record isn't connected — runs that land here just stop.")).toBeTruthy();
    });
});
