/**
 * The live checks, run against the rules the SDK ships for a real block
 * (`action.setVariable`: `textValue` holds at most 1000 characters, and is shown only
 * while `valueType` is `text`).
 *
 * The case that matters most is a field the author edited and then hid by switching its
 * sibling: the value is still there, over its limit, and nothing on screen can show it.
 * A complaint about it would mark the card red over a field the author cannot see.
 *
 * Whether these rules agree with the server is the root gate's question
 * (`src/features/flows/logic/__tests__/blockFieldRules.test.ts`); this is about what the
 * builder does with them.
 */

import { zFlowBlockFieldRules } from '@brattybot/web-sdk';
import { describe, expect, it } from 'vitest';
import type { FlowNode, NodeDescriptor } from '../../api/types';
import { liveFieldIssues } from '../liveFieldIssues';

/** The rules the SDK ships, as `useFlowIssues` hands them over. */
const RULES = zFlowBlockFieldRules.shape;

const SET_VARIABLE: NodeDescriptor = {
    type: 'action.setVariable',
    kind: 'action',
    label: 'Set Variable',
    description: 'Remembers a value for later blocks.',
    group: 'actions',
    icon: '📝',
    configFields: [
        { key: 'variableName', label: 'Variable name', control: 'text' },
        {
            key: 'valueType',
            label: 'Value type',
            control: 'select',
            defaultValue: 'text',
            options: [
                { value: 'text', label: 'Text' },
                { value: 'number', label: 'Number' },
            ],
        },
        { key: 'textValue', label: 'Text', control: 'text', visibleWhen: { field: 'valueType', equals: ['text'] } },
    ],
    handles: [{ label: 'Next', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
};

const TOO_LONG = 'x'.repeat(1001);

const nodeWith = (data: Record<string, unknown>, type = 'action.setVariable'): FlowNode => ({
    id: 'node',
    type,
    position: { x: 0, y: 0 },
    data,
});

const editedTextValue = new Map([['node', new Set(['textValue'])]]);

/** The live complaints about one node, with `edited` marked as edited. */
const issuesAbout = (node: FlowNode, edited: ReadonlyMap<string, ReadonlySet<string>> = editedTextValue, descriptor = SET_VARIABLE) =>
    liveFieldIssues([node], [descriptor], edited, RULES);

describe('a live check on a field that may be hidden', () => {
    it('checks it, in the server’s words, while it is shown', () => {
        expect(issuesAbout(nodeWith({ valueType: 'text', textValue: TOO_LONG }))).toEqual([
            { nodeId: 'node', field: 'textValue', message: 'No more than 1000 characters.' },
        ]);
    });

    it('says nothing about an over-long value once the field is hidden', () => {
        expect(issuesAbout(nodeWith({ valueType: 'number', textValue: TOO_LONG }))).toEqual([]);
    });
});

describe('which fields it speaks for', () => {
    it('only the edited ones', () => {
        const data = { variableName: '1abc', valueType: 'text', textValue: TOO_LONG };
        expect(issuesAbout(nodeWith(data), new Map([['node', new Set(['variableName'])]]))).toEqual([
            {
                nodeId: 'node',
                field: 'variableName',
                message:
                    'A name must start with a letter and use only letters, numbers and underscores — ' +
                    'that is what {{var.name}} can address.',
            },
        ]);
    });

    it('nothing for a block type the SDK has no rules for', () => {
        const unknown: NodeDescriptor = { ...SET_VARIABLE, type: 'constructor' };
        expect(issuesAbout(nodeWith({ textValue: TOO_LONG }, 'constructor'), editedTextValue, unknown)).toEqual([]);
    });
});
