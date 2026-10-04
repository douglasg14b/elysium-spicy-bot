/**
 * The advisory for an exit a block asked to be warned about, left unconnected.
 *
 * The cases are the plan's three plus the edgeless node: warn on the marked exit, never
 * on a plain one, never once it is wired — and never on a block dropped a second ago.
 * Then the same three for an exit that only warns while a field is set: a wait's
 * "Timed out", which no run can take while the wait has no time limit. Then again for
 * one that only warns while a choice holds certain values: a "No record" only some
 * sources reach in an ordinary run.
 */

import { describe, expect, it } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { NodeDescriptor } from '../../api/types';
import {
    describeUnconnectedExit,
    exitWarningsShown,
    unconnectedWarnedExits,
    type ExitWarningNode,
} from '../unconnectedExits';

const CONDITION: NodeDescriptor = {
    type: 'condition.test',
    kind: 'condition',
    label: 'Time Check',
    description: 'A condition with an exit worth a warning.',
    group: 'conditions',
    icon: '⌛',
    configFields: [],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
        { id: 'noRecord', label: 'No record', tone: 'caution', warnIfUnconnected: true },
    ],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
};

/**
 * A wait whose "Timed out" warns only while it has a time limit, and whose limit is
 * hidden unless `mode` says it applies — so "set" must also mean "shown".
 */
const WAIT: NodeDescriptor = {
    type: 'action.test',
    kind: 'action',
    label: 'Wait',
    description: 'A wait with an optional time limit.',
    group: 'actions',
    icon: '⏸️',
    configFields: [
        {
            key: 'mode',
            label: 'Mode',
            control: 'segmented',
            defaultValue: 'limited',
            options: [
                { value: 'limited', label: 'Limited' },
                { value: 'forever', label: 'Forever' },
            ],
        },
        {
            key: 'timeoutMs',
            label: 'Give up after',
            control: 'duration',
            optional: true,
            visibleWhen: { field: 'mode', equals: ['limited'] },
        },
    ],
    handles: [
        { label: 'It happened', tone: 'positive' },
        { id: 'timeout', label: 'Timed out', tone: 'caution', warnIfUnconnected: { whenFieldSet: 'timeoutMs' } },
    ],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: true,
};

const nodes: ExitWarningNode[] = [
    { id: 'check', data: { descriptor: CONDITION, config: {} } },
    { id: 'next', data: { descriptor: undefined, config: {} } },
];

const from = (sourceHandle: string): Edge => ({ id: sourceHandle, source: 'check', target: 'next', sourceHandle });

describe('an exit a block asked to be warned about', () => {
    it('is reported while unconnected, and a plain No is not', () => {
        expect(unconnectedWarnedExits(nodes, [from('true')])).toEqual(new Map([['check', ['No record']]]));
    });

    it('is not reported once something is wired to it', () => {
        expect(unconnectedWarnedExits(nodes, [from('true'), from('noRecord')])).toEqual(new Map());
    });

    it('is not reported on a node with nothing wired at all', () => {
        expect(unconnectedWarnedExits(nodes, [])).toEqual(new Map());
    });

    it('is held back behind a failure or an unreachable node, wherever it is shown', () => {
        expect(exitWarningsShown(['No record'], { failed: false, unreachable: false })).toEqual(['No record']);
        expect(exitWarningsShown(['No record'], { failed: true, unreachable: false })).toEqual([]);
        expect(exitWarningsShown(['No record'], { failed: false, unreachable: true })).toEqual([]);
    });

    it('reads as the consequence: a stop on an ordinary block, a failure on one that woke', () => {
        expect(describeUnconnectedExit('No record', false)).toBe(
            "No record isn't connected — runs that land here just stop."
        );
        expect(describeUnconnectedExit('Timed out', true)).toBe("Timed out isn't connected — runs that land here fail.");
    });
});

describe('an exit that warns only while a field is set', () => {
    /** The wait, with the given config, its default exit wired onward. */
    function waitWith(config: Record<string, unknown>, wired: readonly (string | undefined)[] = [undefined]) {
        const waitNodes: ExitWarningNode[] = [
            { id: 'wait', data: { descriptor: WAIT, config } },
            { id: 'next', data: { descriptor: undefined, config: {} } },
        ];
        const edges: Edge[] = wired.map((sourceHandle, index) => ({
            id: `e${index}`,
            source: 'wait',
            target: 'next',
            ...(sourceHandle === undefined ? {} : { sourceHandle }),
        }));
        return unconnectedWarnedExits(waitNodes, edges);
    }

    it('says nothing while there is no limit, so no run can time out', () => {
        expect(waitWith({})).toEqual(new Map());
        // What a cleared box can leave behind reads as empty too.
        expect(waitWith({ timeoutMs: '' })).toEqual(new Map());
    });

    it('warns once a limit is set and the exit is unconnected', () => {
        expect(waitWith({ timeoutMs: 60_000 })).toEqual(new Map([['wait', ['Timed out']]]));
    });

    it('says nothing once the exit is connected', () => {
        expect(waitWith({ timeoutMs: 60_000 }, [undefined, 'timeout'])).toEqual(new Map());
    });

    it('says nothing while the limit is hidden, whatever it still holds', () => {
        expect(waitWith({ mode: 'forever', timeoutMs: 60_000 })).toEqual(new Map());
    });
});

/**
 * A condition whose "No record" warns only for the sources an ordinary run can reach it
 * from — Time Since's shape. `source` is optionally hidden by `scope`, so "equals" must
 * also mean "shown".
 */
const SINCE: NodeDescriptor = {
    ...CONDITION,
    type: 'condition.since',
    configFields: [
        {
            key: 'scope',
            label: 'Scope',
            control: 'segmented',
            defaultValue: 'member',
            options: [
                { value: 'member', label: 'Member' },
                { value: 'none', label: 'None' },
            ],
        },
        {
            key: 'source',
            label: 'Since',
            control: 'select',
            defaultValue: 'memberMessage',
            options: [
                { value: 'memberMessage', label: "The member's last message" },
                { value: 'memberJoined', label: 'When the member joined' },
                { value: 'runStarted', label: 'When this run started' },
            ],
            visibleWhen: { field: 'scope', equals: ['member'] },
        },
    ],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
        { id: 'noRecord', label: 'No record', tone: 'caution', warnIfUnconnected: { whenField: 'source', equals: ['memberMessage'] } },
    ],
};

describe('an exit that warns only while a choice holds certain values', () => {
    /** The condition, with the given config, its Yes wired onward. */
    function sinceWith(config: Record<string, unknown>, wired: readonly string[] = ['true']) {
        const sinceNodes: ExitWarningNode[] = [
            { id: 'since', data: { descriptor: SINCE, config } },
            { id: 'next', data: { descriptor: undefined, config: {} } },
        ];
        const edges: Edge[] = wired.map((sourceHandle) => ({ id: sourceHandle, source: 'since', target: 'next', sourceHandle }));
        return unconnectedWarnedExits(sinceNodes, edges);
    }

    it('warns for a listed choice, stored or by default', () => {
        expect(sinceWith({ source: 'memberMessage' })).toEqual(new Map([['since', ['No record']]]));
        expect(sinceWith({})).toEqual(new Map([['since', ['No record']]]));
    });

    it('says nothing for a choice it does not list', () => {
        expect(sinceWith({ source: 'runStarted' })).toEqual(new Map());
        expect(sinceWith({ source: 'memberJoined' })).toEqual(new Map());
    });

    it('says nothing once the exit is connected', () => {
        expect(sinceWith({ source: 'memberMessage' }, ['true', 'noRecord'])).toEqual(new Map());
    });

    it('says nothing while the choice is hidden, whatever it still holds', () => {
        expect(sinceWith({ scope: 'none', source: 'memberMessage' })).toEqual(new Map());
    });
});
