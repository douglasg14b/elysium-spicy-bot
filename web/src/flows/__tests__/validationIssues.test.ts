/**
 * Where a rejected save's complaints end up on screen.
 *
 * The rule these exist to hold is **nothing is dropped**. Before this, a save
 * failure was one joined sentence and the author had to guess which of a dozen
 * blocks it meant; the way to reintroduce that is not to lose the placement but to
 * lose an issue that placement could not find a home for, which would show a clean
 * form beside a message saying the save failed.
 */

import { describe, expect, it } from 'vitest';
import type { FlowValidationIssue } from '../../api/types';
import {
    describeUnplacedIssue,
    issuesByNode,
    placeIssues,
    summarizeIssues,
} from '../validationIssues';

describe('issuesByNode', () => {
    it('groups every issue under the node that caused it', () => {
        const issues: FlowValidationIssue[] = [
            { nodeId: 'a', field: 'channelId', message: 'one' },
            { nodeId: 'b', field: 'roleId', message: 'two' },
            { nodeId: 'a', field: 'title', message: 'three' },
        ];

        const grouped = issuesByNode(issues);

        expect(grouped.get('a')).toHaveLength(2);
        expect(grouped.get('b')).toHaveLength(1);
    });

    it('leaves out issues that blame no node', () => {
        // A dangling edge is nobody's node. It has to reach the author some other
        // way, so silently attributing it to one would be worse than omitting it.
        const grouped = issuesByNode([{ message: 'Edge e1 references unknown source node' }]);

        expect(grouped.size).toBe(0);
    });
});

describe('placeIssues', () => {
    const fields = ['channelId', 'title', 'fields'];

    it('hands an issue to the control whose field it names', () => {
        const placed = placeIssues(
            [{ nodeId: 'a', field: 'channelId', message: 'Pick a channel.' }],
            fields
        );

        expect(placed.byField.get('channelId')).toBe('Pick a channel.');
        expect(placed.nodeLevel).toEqual([]);
    });

    it('keeps both messages when two rules fail on one field', () => {
        // Showing one would have the author fix it and be refused again for the
        // reason they were never told.
        const placed = placeIssues(
            [
                { nodeId: 'a', field: 'title', message: 'Too long.' },
                { nodeId: 'a', field: 'title', message: 'Unknown token.' },
            ],
            fields
        );

        expect(placed.byField.get('title')).toContain('Too long.');
        expect(placed.byField.get('title')).toContain('Unknown token.');
        expect(placed.nodeLevel).toEqual([]);
    });

    it('sends a dotted path to node level, since no single control owns it', () => {
        // `fields.0.name` is one embed field's name, not the `fields` control — the
        // list control cannot show a message against one of its rows, so the
        // inspector lists it instead of dropping it.
        const placed = placeIssues(
            [{ nodeId: 'a', field: 'fields.0.name', message: 'Too long.' }],
            fields
        );

        expect(placed.byField.size).toBe(0);
        expect(placed.nodeLevel).toHaveLength(1);
    });

    it('sends an issue with no field at all to node level', () => {
        const placed = placeIssues([{ nodeId: 'a', message: 'unknown node type "x"' }], fields);

        expect(placed.nodeLevel).toHaveLength(1);
    });

    it('sends an issue naming a field this block does not draw to node level', () => {
        // What a config key left behind by an older build looks like. There is no
        // control to put it under, and hiding it would refuse the save forever with
        // nothing on screen to explain why.
        const placed = placeIssues(
            [{ nodeId: 'a', field: 'legacyKey', message: 'Unrecognized key.' }],
            fields
        );

        expect(placed.byField.size).toBe(0);
        expect(placed.nodeLevel).toHaveLength(1);
    });

    it('places or lists every issue, never neither', () => {
        const issues: FlowValidationIssue[] = [
            { nodeId: 'a', field: 'channelId', message: 'one' },
            { nodeId: 'a', field: 'fields.0.name', message: 'two' },
            { nodeId: 'a', message: 'three' },
            { nodeId: 'a', field: 'nope', message: 'four' },
        ];

        const placed = placeIssues(issues, fields);

        expect(placed.byField.size + placed.nodeLevel.length).toBe(issues.length);
    });
});

describe('describeUnplacedIssue', () => {
    it('names the field, which is the only clue the author has left', () => {
        expect(
            describeUnplacedIssue({ field: 'fields.0.name', message: 'Too long.' })
        ).toBe('fields.0.name: Too long.');
    });

    it('says only the message when there is no field', () => {
        expect(describeUnplacedIssue({ message: 'unknown node type' })).toBe('unknown node type');
    });
});

describe('summarizeIssues', () => {
    it('counts problems and the blocks they are on', () => {
        const summary = summarizeIssues([
            { nodeId: 'a', field: 'channelId', message: 'one' },
            { nodeId: 'a', field: 'title', message: 'two' },
            { nodeId: 'b', field: 'roleId', message: 'three' },
        ]);

        expect(summary).toContain('3 problems');
        expect(summary).toContain('2 blocks');
    });

    it('reads as singular for one problem on one block', () => {
        const summary = summarizeIssues([{ nodeId: 'a', field: 'channelId', message: 'one' }]);

        expect(summary).toContain('1 problem ');
        expect(summary).toContain('1 block.');
    });

    it('spells out the issues no card is carrying', () => {
        // A mixed set. "Marked on the canvas" alone would send the author looking
        // for a red block that does not exist for the second of these.
        const summary = summarizeIssues([
            { nodeId: 'a', field: 'channelId', message: 'one' },
            { message: 'Edge e1 references unknown source node.' },
        ]);

        expect(summary).toContain('canvas');
        expect(summary).toContain('Edge e1');
    });

    it('falls back to the messages when nothing names a node', () => {
        // Nothing is marked on the canvas in this case, so pointing at it would send
        // the author looking for a red card that does not exist.
        const summary = summarizeIssues([{ message: 'Edge e1 references unknown source node.' }]);

        expect(summary).toBe('Edge e1 references unknown source node.');
        expect(summary).not.toContain('canvas');
    });
});
