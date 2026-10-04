/**
 * Which nodes the canvas marks as unable to run, and — mostly — which it leaves alone.
 *
 * The restraint is the substance here. Every case below that expects an *empty* set is
 * a state where the honest answer is "unreachable" and saying so would be noise: a node
 * dropped from the palette a moment ago, a flow with no trigger yet, a card already red
 * for a different reason. An advisory that fires during ordinary authoring gets ignored,
 * and then it is not an advisory.
 *
 * `web/` has no jsdom, so this module is where the decision has to live to be testable
 * at all — the component may only render the answer.
 */

import { describe, expect, it } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { NodeDescriptor } from '../../api/types';
import { unreachableNodeIds, type ReachabilityNode } from '../unreachableNodes';

function descriptor(kind: NodeDescriptor['kind']): NodeDescriptor {
    return {
        type: kind === 'trigger' ? 'trigger.buttonClick' : 'action.test',
        kind,
        label: 'Test',
        description: 'A block that exists to be walked past.',
        group: kind === 'trigger' ? 'triggers' : 'actions',
        icon: '🎲',
        configFields: [],
        handles: [{ label: 'Next', tone: 'neutral' }],
        outputs: [],
        requires: [],
        capabilities: [],
        canSuspend: false,
    };
}

function node(id: string, kind: NodeDescriptor['kind'] = 'action'): ReachabilityNode {
    return { id, data: { descriptor: descriptor(kind) } };
}

/** A block this build cannot draw — an older graph naming a type that has since gone. */
function unknownNode(id: string): ReachabilityNode {
    return { id, data: { descriptor: undefined } };
}

function edge(source: string, target: string): Edge {
    return { id: `${source}->${target}`, source, target };
}

const ids = (result: ReadonlySet<string>): string[] => [...result].sort();

describe('unreachableNodeIds', () => {
    it('marks a wired cluster that no trigger can reach', () => {
        // The case this exists for. Two nodes wired to each other look exactly like
        // working flow, and nothing else on the screen says they never run.
        const result = unreachableNodeIds(
            [node('trigger', 'trigger'), node('a'), node('orphan-1'), node('orphan-2')],
            [edge('trigger', 'a'), edge('orphan-1', 'orphan-2')]
        );

        expect(ids(result)).toEqual(['orphan-1', 'orphan-2']);
    });

    it('says nothing about a node with no edges at all', () => {
        // Dropped from the palette seconds ago. The author is looking right at it, and
        // amber here is the noise that teaches them to stop reading amber.
        const result = unreachableNodeIds(
            [node('trigger', 'trigger'), node('a'), node('just-dropped')],
            [edge('trigger', 'a')]
        );

        expect(ids(result)).toEqual([]);
    });

    it('says nothing when the flow has no trigger yet', () => {
        // Every node is unreachable, which is true and useless: the flow cannot run for
        // one reason, and repeating it per card is not how to say so.
        const result = unreachableNodeIds([node('a'), node('b')], [edge('a', 'b')]);

        expect(ids(result)).toEqual([]);
    });

    it('leaves a clean graph clean', () => {
        const result = unreachableNodeIds(
            [node('trigger', 'trigger'), node('a'), node('b')],
            [edge('trigger', 'a'), edge('a', 'b')]
        );

        expect(ids(result)).toEqual([]);
    });

    it('follows a branch through every path, not just the first', () => {
        const result = unreachableNodeIds(
            [node('trigger', 'trigger'), node('left'), node('right')],
            [edge('trigger', 'left'), edge('trigger', 'right')]
        );

        expect(ids(result)).toEqual([]);
    });

    it('reaches a node through a block this build cannot draw', () => {
        // An unknown block still passes a run through, so what is behind it runs too.
        // Deciding otherwise would mark a whole tail as dead because one block was
        // renamed in a later build.
        const result = unreachableNodeIds(
            [node('trigger', 'trigger'), unknownNode('mystery'), node('tail')],
            [edge('trigger', 'mystery'), edge('mystery', 'tail')]
        );

        expect(ids(result)).toEqual([]);
    });

    it('never marks an undrawable node itself, even when it is genuinely cut off', () => {
        // It already renders as a red broken card. Stacking an amber advisory on a red
        // error tells the author nothing they do not have.
        const result = unreachableNodeIds(
            [node('trigger', 'trigger'), node('a'), unknownNode('lost'), node('after-lost')],
            [edge('trigger', 'a'), edge('lost', 'after-lost')]
        );

        expect(ids(result)).toEqual(['after-lost']);
    });

    it('terminates on a cycle rather than hanging', () => {
        // The builder does not prevent cycles and a graph holding one must still open.
        const result = unreachableNodeIds(
            [node('trigger', 'trigger'), node('a'), node('b')],
            [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'a')]
        );

        expect(ids(result)).toEqual([]);
    });

    it('marks a cycle that hangs off no trigger', () => {
        const result = unreachableNodeIds(
            [node('trigger', 'trigger'), node('a'), node('loop-1'), node('loop-2')],
            [
                edge('trigger', 'a'),
                edge('loop-1', 'loop-2'),
                edge('loop-2', 'loop-1'),
            ]
        );

        expect(ids(result)).toEqual(['loop-1', 'loop-2']);
    });

    it('does not treat an edge into a node as making it reachable', () => {
        // Direction matters: `orphan` feeds the trigger's branch, and nothing feeds
        // `orphan`. A walk that ignored direction would call it fine.
        const result = unreachableNodeIds(
            [node('trigger', 'trigger'), node('a'), node('orphan')],
            [edge('trigger', 'a'), edge('orphan', 'a')]
        );

        expect(ids(result)).toEqual(['orphan']);
    });

    it('counts a second trigger as its own entry point', () => {
        const result = unreachableNodeIds(
            [node('t1', 'trigger'), node('t2', 'trigger'), node('a'), node('b')],
            [edge('t1', 'a'), edge('t2', 'b')]
        );

        expect(ids(result)).toEqual([]);
    });

    it('never marks a trigger, even one wired to nothing', () => {
        // A trigger is its own entry point by definition, so it is reachable whatever
        // the edges say. `connected` would exclude a bare one anyway; this pins the
        // intent rather than relying on that.
        const result = unreachableNodeIds(
            [node('t1', 'trigger'), node('t2', 'trigger'), node('a')],
            [edge('t1', 'a'), edge('t2', 'a')]
        );

        expect(ids(result)).toEqual([]);
    });

    it('handles an empty graph', () => {
        expect(ids(unreachableNodeIds([], []))).toEqual([]);
    });
});
