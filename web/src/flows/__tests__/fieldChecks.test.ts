/**
 * The live checks skip a field its `visibleWhen` hides.
 *
 * The case that matters is a field the author edited and then hid by switching its
 * sibling: the value is still there, over its limit, and nothing on screen can show it.
 * A complaint about it would mark the card red over a field the author cannot see.
 */

import { describe, expect, it } from 'vitest';
import type { FlowNode, NodeDescriptor } from '../../api/types';
import { liveFieldIssues } from '../fieldChecks';

const DESCRIPTOR: NodeDescriptor = {
    type: 'action.test',
    kind: 'action',
    label: 'Test',
    description: 'A block with a field that only sometimes applies.',
    group: 'actions',
    icon: '🫥',
    configFields: [
        {
            key: 'mode',
            label: 'Mode',
            control: 'segmented',
            defaultValue: 'plain',
            options: [
                { value: 'plain', label: 'Plain' },
                { value: 'copy', label: 'Copy' },
            ],
        },
        { key: 'message', label: 'Message', control: 'longText', visibleWhen: { field: 'mode', equals: ['copy'] } },
    ],
    fieldChecks: { message: [{ rule: 'maxLength', limit: 5, message: 'Keep it under five.' }] },
    handles: [{ label: 'Next', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
};

const nodeWith = (data: Record<string, unknown>): FlowNode => ({
    id: 'node',
    type: 'action.test',
    position: { x: 0, y: 0 },
    data,
});

const edited = new Map([['node', new Set(['message'])]]);

describe('a live check on a field that may be hidden', () => {
    it('says nothing about an over-long value once the field is hidden', () => {
        expect(liveFieldIssues([nodeWith({ mode: 'plain', message: 'far too long' })], [DESCRIPTOR], edited)).toEqual([]);
    });

    it('still checks it while it is shown', () => {
        expect(liveFieldIssues([nodeWith({ mode: 'copy', message: 'far too long' })], [DESCRIPTOR], edited)).toEqual([
            { nodeId: 'node', field: 'message', message: 'Keep it under five.' },
        ]);
    });
});
