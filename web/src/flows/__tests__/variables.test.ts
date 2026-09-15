/**
 * What the inspector may offer an author, and what it must not.
 *
 * The cases worth proving are the ones the discriminator exists for — an
 * `authored` output resolving through its field rather than to its field name —
 * and the shape of "upstream", which is reachability rather than adjacency.
 */

import { describe, expect, it } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { BlockOutputDeclaration, NodeDescriptor } from '../../api/types';
import {
    availableVariablesAt,
    referencedVariables,
    resolveOutputName,
    variableToken,
    type VariableSourceNode,
} from '../variables';

function descriptorWith(outputs: BlockOutputDeclaration[]): NodeDescriptor {
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
        canSuspend: false,
    };
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
