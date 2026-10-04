/**
 * Which nodes the canvas warns will run more than once per event.
 *
 * The case this exists for is the one a review caught after the dispatchers were fixed
 * to start every matching trigger: two triggers converging on one action node means
 * that action runs twice, which is two messages or — worse — two tickets. Running twice
 * is sometimes intended, so this is an advisory; what an author could not do before was
 * *see* it.
 *
 * As with `unreachableNodes`, the restraint matters as much as the detection. Every
 * empty-result case below is a shape where "converging" is either false or useless.
 */

import { describe, expect, it } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { NodeDescriptor } from '../../api/types';
import {
    convergingTriggerCounts,
    describeConvergence,
    type ConvergenceNode,
} from '../convergingTriggers';

function descriptor(kind: NodeDescriptor['kind']): NodeDescriptor {
    return {
        type: kind === 'trigger' ? 'trigger.memberJoin' : 'action.test',
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

function node(id: string, kind: NodeDescriptor['kind'] = 'action'): ConvergenceNode {
    return { id, data: { descriptor: descriptor(kind) } };
}

function unknownNode(id: string): ConvergenceNode {
    return { id, data: { descriptor: undefined } };
}

function edge(source: string, target: string): Edge {
    return { id: `${source}->${target}`, source, target };
}

describe('convergingTriggerCounts', () => {
    it('counts a node two triggers both reach', () => {
        // The shape the review found: `trigger.memberJoin` has an empty config schema,
        // so two of them both match every join, and converging is the only way they
        // can differ. One `assign` node here is one role add done twice.
        const result = convergingTriggerCounts(
            [node('t1', 'trigger'), node('t2', 'trigger'), node('assign')],
            [edge('t1', 'assign'), edge('t2', 'assign')]
        );

        expect(result.get('assign')).toBe(2);
    });

    it('counts every node downstream of the convergence, not just the join point', () => {
        // The second message is as duplicated as the first.
        const result = convergingTriggerCounts(
            [node('t1', 'trigger'), node('t2', 'trigger'), node('assign'), node('announce')],
            [edge('t1', 'assign'), edge('t2', 'assign'), edge('assign', 'announce')]
        );

        expect(result.get('assign')).toBe(2);
        expect(result.get('announce')).toBe(2);
    });

    it('reports three triggers as three, not merely as "more than one"', () => {
        // "Runs twice" and "runs four times" are different amounts of trouble.
        const result = convergingTriggerCounts(
            [node('t1', 'trigger'), node('t2', 'trigger'), node('t3', 'trigger'), node('assign')],
            [edge('t1', 'assign'), edge('t2', 'assign'), edge('t3', 'assign')]
        );

        expect(result.get('assign')).toBe(3);
    });

    it('says nothing about a node only one trigger reaches', () => {
        const result = convergingTriggerCounts(
            [node('t1', 'trigger'), node('t2', 'trigger'), node('a'), node('b')],
            [edge('t1', 'a'), edge('t2', 'b')]
        );

        expect(result.size).toBe(0);
    });

    it('says nothing when the flow has only one trigger', () => {
        // A diamond off one trigger still runs each node once: the run takes one path
        // through a condition, and even a genuine re-entry is the executor's business.
        // One trigger cannot converge with itself.
        const result = convergingTriggerCounts(
            [node('t1', 'trigger'), node('left'), node('right'), node('join')],
            [
                edge('t1', 'left'),
                edge('t1', 'right'),
                edge('left', 'join'),
                edge('right', 'join'),
            ]
        );

        expect(result.size).toBe(0);
    });

    it('says nothing when there are no triggers at all', () => {
        const result = convergingTriggerCounts([node('a'), node('b')], [edge('a', 'b')]);

        expect(result.size).toBe(0);
    });

    it('never reports a trigger, even when two other triggers both reach it', () => {
        /*
         * An entry point is not a step. Nothing *enters* a trigger, so paths arriving
         * at one do not make it run twice — its own run count is decided by the
         * dispatcher, which starts it once per event.
         *
         * `t3` is reached by both `t1` and `t2`, so a version without the exemption
         * would report it. An earlier draft of this test only had one path reaching
         * `t2`, which meant it passed whether the exemption existed or not.
         */
        const result = convergingTriggerCounts(
            [node('t1', 'trigger'), node('t2', 'trigger'), node('t3', 'trigger'), node('a')],
            [edge('t1', 't3'), edge('t2', 't3'), edge('t3', 'a')]
        );

        expect(result.has('t3')).toBe(false);
        // The node *after* the converged-on trigger is still reported: three runs pass
        // through it — one per trigger — and that is the fact worth stating.
        expect(result.get('a')).toBe(3);
    });

    it('counts through a block this build cannot draw', () => {
        // An unknown block still passes a run through, so what is after it is still
        // reached twice.
        const result = convergingTriggerCounts(
            [node('t1', 'trigger'), node('t2', 'trigger'), unknownNode('mystery'), node('tail')],
            [edge('t1', 'mystery'), edge('t2', 'mystery'), edge('mystery', 'tail')]
        );

        expect(result.get('tail')).toBe(2);
    });

    it('counts a trigger once however many paths it takes to the node', () => {
        // Two edges from one trigger into one node is one run reaching it, not two.
        // Counting paths rather than triggers would call a diamond a duplicate.
        const result = convergingTriggerCounts(
            [node('t1', 'trigger'), node('t2', 'trigger'), node('left'), node('right'), node('join')],
            [
                edge('t1', 'left'),
                edge('t1', 'right'),
                edge('left', 'join'),
                edge('right', 'join'),
                edge('t2', 'join'),
            ]
        );

        expect(result.get('join')).toBe(2);
    });

    it('terminates on a cycle rather than hanging', () => {
        const result = convergingTriggerCounts(
            [node('t1', 'trigger'), node('t2', 'trigger'), node('a'), node('b')],
            [edge('t1', 'a'), edge('t2', 'a'), edge('a', 'b'), edge('b', 'a')]
        );

        expect(result.get('a')).toBe(2);
        expect(result.get('b')).toBe(2);
    });

    it('handles an empty graph', () => {
        expect(convergingTriggerCounts([], []).size).toBe(0);
    });
});

describe('describeConvergence', () => {
    it('states the consequence rather than the topology', () => {
        // "Two triggers reach this" describes edges the author is looking at already.
        // How many times it runs is the part they did not know.
        expect(describeConvergence(2)).toContain('runs 2 times per event');
    });
});
