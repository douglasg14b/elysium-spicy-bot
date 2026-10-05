import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { BlockConfigField, FlowContextRequirement, NodeDescriptor } from '../../api/types';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { NodeInspector } from '../NodeInspector';
import { NEEDS_A_MEMBER_NOTE, NodePalette } from '../NodePalette';
import {
    ALL_REQUIREMENTS_AVAILABLE,
    describeUnavailableRequirement,
    flowRunsAboutNobody,
    requirementsAvailableAt,
    type RequirementAvailability,
    type VariableSourceNode,
} from '../variables';

/**
 * How the builder shows what a run about nobody cannot reach: the palette greys the
 * blocks that always need a member, the inspector greys member tokens and disables
 * member options — each saying why — and a block wired to nothing is never greyed by
 * availability. Hand-built descriptors throughout, so this pins the builder's reading
 * of the declarations, not any shipped block.
 */

function descriptor(overrides: Partial<NodeDescriptor> & Pick<NodeDescriptor, 'type' | 'label'>): NodeDescriptor {
    return {
        kind: 'action',
        description: '',
        group: 'actions',
        icon: '🧪',
        configFields: [],
        fieldChecks: {},
        handles: [{ label: 'Next', tone: 'neutral' }],
        outputs: [],
        requires: [],
        capabilities: [],
        canSuspend: false,
        ...overrides,
    };
}

const triggerSupplying = (type: string, label: string, requires: FlowContextRequirement[]): NodeDescriptor =>
    descriptor({ type, label, kind: 'trigger', group: 'triggers', requires });

const NOBODY_TRIGGER = triggerSupplying('trigger.nobody', 'On a Schedule', []);
const MEMBER_TRIGGER = triggerSupplying('trigger.member', 'Member Joins', ['subject', 'actor']);
const ASSIGN_ROLE = descriptor({ type: 'action.assignRole', label: 'Assign Role', requires: ['subject'] });

const SOURCE_FIELD: BlockConfigField = {
    key: 'source',
    label: 'Since',
    control: 'select',
    defaultValue: 'channelMessage',
    options: [
        { value: 'memberMessage', label: "The member's last message", requires: ['subject'] },
        { value: 'channelMessage', label: "Anyone's last message in a channel" },
    ],
};

const TIME_SINCE = descriptor({
    type: 'condition.timeSince',
    label: 'Time Since',
    kind: 'condition',
    group: 'conditions',
    configFields: [SOURCE_FIELD],
});

const SAY = descriptor({
    type: 'action.say',
    label: 'Say',
    configFields: [{ key: 'message', label: 'Message', control: 'longText', rendersTokens: true }],
});

const COUNT_FROM: BlockConfigField = {
    key: 'countFrom',
    label: 'Count from',
    control: 'segmented',
    defaultValue: 'waitStart',
    options: [
        { value: 'waitStart', label: 'The start' },
        { value: 'memberMessage', label: 'Their message', requires: ['subject'] },
    ],
};

const WAIT = descriptor({ type: 'action.wait', label: 'Wait', configFields: [COUNT_FROM] });

const NO_MEMBER: RequirementAvailability = { ...ALL_REQUIREMENTS_AVAILABLE, subject: 'fromTrigger' };

describe('the palette on a flow whose runs are all about nobody', () => {
    const CATALOG = [NOBODY_TRIGGER, MEMBER_TRIGGER, ASSIGN_ROLE, TIME_SINCE];

    function renderPalette(runsAboutNobody: boolean) {
        const onAdd = vi.fn();
        const rendered = renderWithProviders(
            <NodePalette nodeTypes={CATALOG} runsAboutNobody={runsAboutNobody} onAdd={onAdd} />
        );
        return { ...rendered, onAdd };
    }

    it('greys a block that always needs a member, says why, and will not add it', async () => {
        const { user, onAdd } = renderPalette(true);

        const entry = screen.getByRole('button', { name: /Assign Role/ });
        expect(entry.getAttribute('title')).toBe(NEEDS_A_MEMBER_NOTE);
        expect(entry.getAttribute('aria-disabled')).toBe('true');
        expect(entry.getAttribute('draggable')).toBe('false');

        await user.click(entry);
        expect(onAdd).not.toHaveBeenCalled();
    });

    it('never greys a trigger, nor a block that only sometimes needs a member', async () => {
        const { user, onAdd } = renderPalette(true);

        for (const label of ['Member Joins', 'On a Schedule', 'Time Since']) {
            expect(screen.getByRole('button', { name: new RegExp(label) }).getAttribute('aria-disabled')).toBeNull();
        }
        await user.click(screen.getByRole('button', { name: /Member Joins/ }));
        expect(onAdd).toHaveBeenCalledWith(MEMBER_TRIGGER);
    });

    it('greys nothing when the flow is not all about nobody', () => {
        renderPalette(false);

        expect(screen.getByRole('button', { name: /Assign Role/ }).getAttribute('aria-disabled')).toBeNull();
    });

    it('counts a flow as all about nobody only when it has triggers and none supplies a member', () => {
        expect(flowRunsAboutNobody([NOBODY_TRIGGER, ASSIGN_ROLE])).toBe(true);
        // Mixed: the palette stays open, and the server marks the reached node instead.
        expect(flowRunsAboutNobody([NOBODY_TRIGGER, MEMBER_TRIGGER, ASSIGN_ROLE])).toBe(false);
        // No trigger yet: the author may still add a member trigger.
        expect(flowRunsAboutNobody([ASSIGN_ROLE])).toBe(false);
        expect(flowRunsAboutNobody([])).toBe(false);
    });
});

function renderInspector(target: NodeDescriptor, requirements: RequirementAvailability, config: Record<string, unknown> = {}) {
    const onChange = vi.fn();
    const rendered = renderWithProviders(
        <NodeInspector
            descriptor={target}
            nodeType={target.type}
            label={target.label}
            config={config}
            roles={[]}
            channels={[]}
            ticketTypes={[]}
            variables={[]}
            requirements={requirements}
            declaredResources={[]}
            issues={[]}
            unconnectedExits={[]}
            onChange={onChange}
            onDelete={vi.fn()}
        />
    );
    return { ...rendered, onChange };
}

describe('the inspector where a run about nobody can arrive', () => {
    it('greys every subject chip, and leaves the guild chip alone', () => {
        renderInspector(SAY, NO_MEMBER);

        const chip = (name: string) => screen.getByRole('button', { name });
        for (const name of ['subject.mention', 'subject.username', 'subject.id']) {
            expect(chip(name).getAttribute('data-unavailable')).toBe('true');
        }
        expect(chip('guild.name').getAttribute('data-unavailable')).toBeNull();
        // The actor is still there: nothing parked above.
        expect(chip('actor.mention').getAttribute('data-unavailable')).toBeNull();
    });

    it('greys nothing where a member is there', () => {
        renderInspector(SAY, ALL_REQUIREMENTS_AVAILABLE);

        expect(screen.getByRole('button', { name: 'subject.mention' }).getAttribute('data-unavailable')).toBeNull();
    });

    it('disables a dropdown option that needs a member, and says why on hover', async () => {
        const { user, onChange } = renderInspector(TIME_SINCE, NO_MEMBER);

        await user.click(screen.getByRole('textbox', { name: 'Since' }));
        const memberOption = screen.getByRole('option', { name: "The member's last message" });

        expect(memberOption.getAttribute('data-combobox-disabled')).toBe('true');
        expect(screen.getByTitle(describeUnavailableRequirement('subject', 'fromTrigger'))).toBeTruthy();
        await user.click(memberOption);
        expect(onChange).not.toHaveBeenCalled();

        const channelOption = screen.getByRole('option', { name: "Anyone's last message in a channel" });
        expect(channelOption.getAttribute('data-combobox-disabled')).toBeNull();
    });

    it('keeps a member option already picked on show, so the server issue has something to sit beside', () => {
        renderInspector(TIME_SINCE, NO_MEMBER, { source: 'memberMessage' });

        expect((screen.getByRole('textbox', { name: 'Since' }) as HTMLInputElement).value).toBe(
            "The member's last message"
        );
    });

    it('disables a segment that needs a member, and says why on hover', () => {
        renderInspector(WAIT, NO_MEMBER);

        expect((screen.getByRole('radio', { name: 'Their message' }) as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByRole('radio', { name: 'The start' }) as HTMLInputElement).disabled).toBe(false);
        expect(screen.getByTitle(describeUnavailableRequirement('subject', 'fromTrigger')).textContent).toBe(
            'Their message'
        );
    });
});

describe('availability on a block wired to nothing', () => {
    function canvasNode(id: string, nodeDescriptor: NodeDescriptor): VariableSourceNode {
        return { id, data: { label: nodeDescriptor.label, config: {}, descriptor: nodeDescriptor } };
    }

    it('does not grey a loose block on a flow whose runs are all about nobody', () => {
        // The palette greys it on such a flow; availability does not, because nothing
        // reaches it — the same as the server, which never blames an unreachable node.
        const nodes = [canvasNode('schedule', NOBODY_TRIGGER), canvasNode('loose', TIME_SINCE)];
        const edges: Edge[] = [];

        const requirements = requirementsAvailableAt('loose', nodes, edges);

        expect(requirements.subject).toBeNull();
    });

    it('greys it once it is wired below the trigger about nobody', () => {
        const nodes = [canvasNode('schedule', NOBODY_TRIGGER), canvasNode('wired', TIME_SINCE)];
        const edges: Edge[] = [{ id: 'e1', source: 'schedule', target: 'wired' }];

        expect(requirementsAvailableAt('wired', nodes, edges).subject).toBe('fromTrigger');
    });
});
