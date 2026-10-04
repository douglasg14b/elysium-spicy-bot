/**
 * What the inspector may offer an author, and what it must not.
 *
 * The cases worth proving are the ones the discriminator exists for — an
 * `authored` output resolving through its field rather than to its field name —
 * and the shape of "upstream", which is reachability rather than adjacency.
 */

import { describe, expect, it } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { BlockConfigField, BlockOutputDeclaration, NodeDescriptor } from '@brattybot/web-sdk';
import {
    actorAvailableAt,
    ancestorsOf,
    availableVariablesAt,
    effectiveFieldValue,
    isFieldVisible,
    pickerVariableOf,
    resolveOutputValueKind,
    referencedVariables,
    resolveOutputName,
    tokensIn,
    variableToken,
    type VariableSourceNode,
} from '../variables';

function descriptorWith(outputs: BlockOutputDeclaration[], canSuspend = false): NodeDescriptor {
    return {
        type: 'action.test',
        kind: 'action',
        label: 'Test',
        description: 'A block that exists to write something.',
        group: 'actions',
        icon: '🎲',
        configFields: [],
        handles: [{ label: 'Next', tone: 'neutral' }],
        outputs,
        requires: [],
        capabilities: [],
        canSuspend,
    };
}

/** A block that parks the run — a delay, a prompt, a wait. */
function suspendingNode(id: string): VariableSourceNode {
    return { id, data: { label: `Node ${id}`, config: {}, descriptor: descriptorWith([], true) } };
}

/** A block this build cannot draw, e.g. one the server added after this bundle. */
function unknownNode(id: string): VariableSourceNode {
    return { id, data: { label: `Node ${id}`, config: {}, descriptor: undefined } };
}

function node(
    id: string,
    outputs: BlockOutputDeclaration[],
    config: Record<string, unknown> = {},
    label = `Node ${id}`
): VariableSourceNode {
    return { id, data: { label, config, descriptor: descriptorWith(outputs) } };
}

function edge(source: string, target: string): Edge {
    return { id: `${source}->${target}`, source, target };
}

const PICK: BlockOutputDeclaration = {
    naming: 'authored',
    fromField: 'outputKey',
    label: 'The picked option',
};

describe('resolving what one output writes on one node', () => {
    it('reads a fixed output straight off the declaration', () => {
        const fixed: BlockOutputDeclaration = { naming: 'fixed', key: 'ticketId', label: 'Ticket' };
        expect(resolveOutputName(fixed, {})).toBe('ticketId');
    });

    it('reads an authored output through its field, not as its field name', () => {
        // The whole reason for the discriminator. `outputKey` is a field name; the
        // variable is whatever the author typed into it.
        expect(resolveOutputName(PICK, { outputKey: 'dare' })).toBe('dare');
    });

    it('produces nothing for an authored output the author has not named yet', () => {
        expect(resolveOutputName(PICK, {})).toBeUndefined();
        expect(resolveOutputName(PICK, { outputKey: '' })).toBeUndefined();
        expect(resolveOutputName(PICK, { outputKey: 42 })).toBeUndefined();
    });
});

describe('the variables in scope at a node', () => {
    it('offers what an immediately upstream block writes, under its authored name', () => {
        const nodes = [node('a', [PICK], { outputKey: 'dare' }), node('b', [])];
        const found = availableVariablesAt('b', nodes, [edge('a', 'b')]);

        expect(found.map((variable) => variable.name)).toEqual(['dare']);
        expect(found[0].producerLabel).toBe('Node a');
    });

    it('reaches back through blocks that write nothing themselves', () => {
        // Two hops: a condition between the producer and the reader is the ordinary
        // shape of a real flow, and a walk that only looked at direct parents would
        // miss it.
        const nodes = [node('a', [PICK], { outputKey: 'dare' }), node('b', []), node('c', [])];
        const found = availableVariablesAt('c', nodes, [edge('a', 'b'), edge('b', 'c')]);

        expect(found.map((variable) => variable.name)).toEqual(['dare']);
    });

    it('offers nothing written by a block that only runs afterwards', () => {
        const nodes = [node('a', []), node('b', [PICK], { outputKey: 'dare' })];
        expect(availableVariablesAt('a', nodes, [edge('a', 'b')])).toEqual([]);
    });

    it('does not offer a node its own output', () => {
        const nodes = [node('a', [PICK], { outputKey: 'dare' })];
        expect(availableVariablesAt('a', nodes, [])).toEqual([]);
    });

    it('skips an unnamed producer rather than offering the field name', () => {
        // The failure the discriminator prevents: offering `outputKey`, a token
        // nothing ever writes, which would fail at run time.
        const nodes = [node('a', [PICK], {}), node('b', [])];
        expect(availableVariablesAt('b', nodes, [edge('a', 'b')])).toEqual([]);
    });

    it('terminates on a cycle instead of walking it forever', () => {
        const nodes = [node('a', [PICK], { outputKey: 'dare' }), node('b', []), node('c', [])];
        const found = availableVariablesAt('c', nodes, [
            edge('a', 'b'),
            edge('b', 'c'),
            edge('c', 'b'),
        ]);

        expect(found.map((variable) => variable.name)).toEqual(['dare']);
    });

    it('offers both branches of a split, since either could be the one that ran', () => {
        const nodes = [
            node('gate', []),
            node('left', [PICK], { outputKey: 'soft' }),
            node('right', [PICK], { outputKey: 'hard' }),
            node('join', []),
        ];
        const found = availableVariablesAt('join', nodes, [
            edge('gate', 'left'),
            edge('gate', 'right'),
            edge('left', 'join'),
            edge('right', 'join'),
        ]);

        expect(found.map((variable) => variable.name).sort()).toEqual(['hard', 'soft']);
    });

    it('reports one entry per name, crediting the nearest producer', () => {
        const nodes = [
            node('far', [PICK], { outputKey: 'dare' }, 'Far'),
            node('near', [PICK], { outputKey: 'dare' }, 'Near'),
            node('reader', []),
        ];
        const found = availableVariablesAt('reader', nodes, [
            edge('far', 'near'),
            edge('near', 'reader'),
        ]);

        expect(found).toHaveLength(1);
        expect(found[0].producerLabel).toBe('Near');
    });

    it('sees past a block this build cannot draw', () => {
        // An unknown block still passes a run through, so what is behind it is
        // still in scope — dropping the whole ancestry would be the wrong repair.
        const unknown: VariableSourceNode = {
            id: 'mystery',
            data: { label: 'Unknown', config: {}, descriptor: undefined },
        };
        const nodes = [node('a', [PICK], { outputKey: 'dare' }), unknown, node('b', [])];
        const found = availableVariablesAt('b', nodes, [edge('a', 'mystery'), edge('mystery', 'b')]);

        expect(found.map((variable) => variable.name)).toEqual(['dare']);
    });
});

describe('finding the variables a piece of copy references', () => {
    it('reads one out of a token', () => {
        expect(referencedVariables('You got {{var.dare}}, enjoy.')).toEqual(['dare']);
    });

    it('ignores tokens from other namespaces', () => {
        expect(referencedVariables('{{subject.mention}} rolled {{var.dare}}')).toEqual(['dare']);
    });

    it('reports a dotted name, which the engine sees and refuses to resolve', () => {
        // Not silently skipped: copy containing this fails at run time, so the
        // inspector must be able to say so rather than calling it "no reference".
        expect(referencedVariables('{{var.a.b}}')).toEqual([]);
    });

    it('reports each name once however often it is written', () => {
        expect(referencedVariables('{{var.dare}} and again {{var.dare}}')).toEqual(['dare']);
    });

    it('tolerates the whitespace the engine trims', () => {
        expect(referencedVariables('{{ var.dare }}')).toEqual(['dare']);
    });
});

describe('the token an author writes', () => {
    it('spells a name the way copy rendering reads it', () => {
        expect(variableToken('dare')).toBe('{{var.dare}}');
    });
});

describe('every token the engine would see', () => {
    it('reports tokens of any namespace, not just variables', () => {
        // The permissive half of the grammar: a built-in token and a broken one
        // both have to be *seen* before anything can report them.
        expect(tokensIn('Hi {{subject.username}} — {{var.dare}} {{nope}}')).toEqual([
            'subject.username',
            'var.dare',
            'nope',
        ]);
    });

    it('trims the whitespace the engine trims', () => {
        expect(tokensIn('{{ guild.name }}')).toEqual(['guild.name']);
    });

    it('finds nothing in copy with no braces', () => {
        expect(tokensIn('Just a plain title')).toEqual([]);
    });
});

describe('the nodes that can run before a node', () => {
    it('lists nearer ancestors before further ones', () => {
        // The ordering `availableVariablesAt` relies on for "nearest producer
        // wins": stated here because that rule is invisible in its own result.
        const nodes = [node('a', []), node('b', []), node('c', [])];
        const edges = [edge('a', 'b'), edge('b', 'c')];

        expect(ancestorsOf('c', nodes, edges).map((found) => found.id)).toEqual(['b', 'a']);
    });

    it('excludes the node itself', () => {
        expect(ancestorsOf('a', [node('a', [])], []).map((found) => found.id)).toEqual([]);
    });

    it('terminates on a cycle rather than hanging the builder', () => {
        // `b` is its own ancestor here, and still excluded: the start node seeds
        // `seen`, so a loop reaching back to it stops rather than offering the
        // author what this very block writes.
        const nodes = [node('a', []), node('b', [])];
        const edges = [edge('a', 'b'), edge('b', 'a')];

        expect(ancestorsOf('b', nodes, edges).map((found) => found.id)).toEqual(['a']);
    });
});

describe('whether the actor survives to a node', () => {
    it('is available when nothing runs before it', () => {
        expect(actorAvailableAt('a', [node('a', [])], [])).toBe(true);
    });

    it('is available when every block above it runs straight through', () => {
        const nodes = [node('a', []), node('b', [])];
        expect(actorAvailableAt('b', nodes, [edge('a', 'b')])).toBe(true);
    });

    it('is lost after a block that parks the run, however far upstream', () => {
        // Reachability, not adjacency: a delay two hops back still means the run
        // reaching this node may have been woken by the clock.
        const nodes = [suspendingNode('wait'), node('mid', []), node('end', [])];
        const edges = [edge('wait', 'mid'), edge('mid', 'end')];

        expect(actorAvailableAt('end', nodes, edges)).toBe(false);
    });

    it('is lost when any branch above it parks, not only all of them', () => {
        // The over-approximation this shares with variable scope, in the opposite
        // direction: the author is warned on a branch that might not suspend,
        // because the one that does would fail the run.
        const nodes = [node('start', []), suspendingNode('wait'), node('plain', []), node('end', [])];
        const edges = [
            edge('start', 'wait'),
            edge('start', 'plain'),
            edge('wait', 'end'),
            edge('plain', 'end'),
        ];

        expect(actorAvailableAt('end', nodes, edges)).toBe(false);
    });

    it('treats a block it cannot draw as running straight through', () => {
        // The documented asymmetry: for advice rather than enforcement, a chip
        // wrongly offered costs a keystroke and one wrongly withheld costs the
        // author the token they needed.
        const nodes = [unknownNode('mystery'), node('end', [])];

        expect(actorAvailableAt('end', nodes, [edge('mystery', 'end')])).toBe(true);
    });
});

describe('an output written on one branch only', () => {
    const FOUND: BlockOutputDeclaration = {
        naming: 'fixed',
        key: 'ticketChannelId',
        label: 'Ticket channel',
        valueKind: 'channel',
        handle: 'true',
    };

    function branchEdge(source: string, target: string, sourceHandle: string): Edge {
        return { id: `${source}:${sourceHandle}->${target}`, source, target, sourceHandle };
    }

    it('is offered down the branch that writes it, with its kind', () => {
        const nodes = [node('check', [FOUND]), node('post', [])];

        expect(availableVariablesAt('post', nodes, [branchEdge('check', 'post', 'true')])).toEqual([
            expect.objectContaining({ name: 'ticketChannelId', valueKind: 'channel' }),
        ]);
    });

    it('is not offered down the other branch, where it is guaranteed absent', () => {
        const nodes = [node('check', [FOUND]), node('post', [])];

        expect(availableVariablesAt('post', nodes, [branchEdge('check', 'post', 'false')])).toEqual([]);
    });

    it('is offered several blocks further down the branch that writes it', () => {
        const nodes = [node('check', [FOUND]), node('between', []), node('post', [])];
        const edges = [branchEdge('check', 'between', 'true'), edge('between', 'post')];

        expect(availableVariablesAt('post', nodes, edges).map((variable) => variable.name)).toEqual([
            'ticketChannelId',
        ]);
    });

    it('is offered where both branches converge, because one of them writes it', () => {
        // Over-approximating at a merge, as everything else here does: the author
        // may well have the other branch write the same name.
        const nodes = [node('check', [FOUND]), node('a', []), node('b', []), node('post', [])];
        const edges = [
            branchEdge('check', 'a', 'true'),
            branchEdge('check', 'b', 'false'),
            edge('a', 'post'),
            edge('b', 'post'),
        ];

        expect(availableVariablesAt('post', nodes, edges).map((variable) => variable.name)).toEqual([
            'ticketChannelId',
        ]);
    });
});

describe('a picker holding one variable', () => {
    it.each([
        ['{{var.ticketChannelId}}', 'ticketChannelId'],
        ['  {{ var.ticketChannelId }} ', 'ticketChannelId'],
        ['#{{var.ticketChannelId}}', undefined],
        ['{{var.a}}{{var.b}}', undefined],
        ['{{subject.id}}', undefined],
        ['123456789012345678', undefined],
    ])('reads %j as %s', (value, expected) => {
        expect(pickerVariableOf(value)).toBe(expected);
    });
});

/** A `select` deciding both a sibling's visibility and an output's kind. */
const VALUE_TYPE: BlockConfigField = {
    key: 'valueType',
    label: 'Value',
    control: 'select',
    defaultValue: 'text',
    options: [
        { value: 'text', label: 'Text' },
        { value: 'time', label: 'Current time' },
    ],
};

const NOTE: BlockConfigField = {
    key: 'note',
    label: 'Note',
    control: 'text',
    visibleWhen: { field: 'valueType', equals: ['text'] },
};

const TYPED: BlockOutputDeclaration = {
    naming: 'authored',
    fromField: 'outputKey',
    label: 'The value',
    valueKindFrom: { field: 'valueType', kinds: { time: 'time' } },
};

describe('the browser’s reading of a field’s current value', () => {
    it('is the stored value, or the default when nothing or an empty string is stored', () => {
        expect(effectiveFieldValue(VALUE_TYPE, { valueType: 'time' })).toBe('time');
        expect(effectiveFieldValue(VALUE_TYPE, {})).toBe('text');
        expect(effectiveFieldValue(VALUE_TYPE, { valueType: '' })).toBe('text');
    });

    it('hides a field by its sibling’s value or default, whatever the field itself holds', () => {
        const fields = [VALUE_TYPE, NOTE];

        expect(isFieldVisible(NOTE, fields, {})).toBe(true);
        expect(isFieldVisible(NOTE, fields, { valueType: 'time', note: 'still here' })).toBe(false);
        // A sibling this descriptor does not declare cannot explain a hidden field.
        expect(isFieldVisible(NOTE, [NOTE], { valueType: 'time' })).toBe(true);
    });

    it('resolves a derived kind from the choice, the default, or to none', () => {
        expect(resolveOutputValueKind(TYPED, [VALUE_TYPE], { valueType: 'time' })).toBe('time');
        expect(resolveOutputValueKind(TYPED, [VALUE_TYPE], {})).toBeUndefined();
        expect(resolveOutputValueKind({ naming: 'fixed', key: 'c', label: 'C', valueKind: 'channel' }, [], {})).toBe(
            'channel'
        );
    });

    it('offers a variable at the kind its producer resolves to on that node', () => {
        const producer = (id: string, valueType: string): VariableSourceNode => ({
            id,
            data: {
                label: `Node ${id}`,
                config: { outputKey: `${id}Value`, valueType },
                descriptor: { ...descriptorWith([TYPED]), configFields: [VALUE_TYPE] },
            },
        });
        const nodes = [producer('a', 'time'), producer('b', 'text'), node('reader', [])];
        const edges = [edge('a', 'b'), edge('b', 'reader')];

        expect(availableVariablesAt('reader', nodes, edges).map(({ name, valueKind }) => ({ name, valueKind }))).toEqual([
            { name: 'bValue', valueKind: undefined },
            { name: 'aValue', valueKind: 'time' },
        ]);
    });
});
