/**
 * The undo snapshot taken when React Flow deletes something behind our back.
 *
 * The bug this guards: `onEdgesDelete` used to only mark the flow dirty, so the top
 * of the undo stack still described a graph from before some *earlier* change.
 * Pressing undo after a keyboard delete restored the deleted edge — and also
 * reverted whatever had happened since. The two timing cases below are the whole
 * reason this is computed rather than read.
 */

import { describe, expect, it } from 'vitest';
import { graphIncluding } from '../graphHistory';

const node = (id: string) => ({ id });
const edge = (id: string) => ({ id });

describe('graphIncluding', () => {
    it('restores an edge the mirror has already dropped', () => {
        // The effect that syncs live state ran before the delete handler did, so
        // the mirror no longer knows about `e2`. It has to come back.
        const current = { nodes: [node('a'), node('b')], edges: [edge('e1')] };

        const before = graphIncluding(current, { edges: [edge('e2')] });

        expect(before.edges.map((entry) => entry.id).sort()).toEqual(['e1', 'e2']);
        expect(before.nodes.map((entry) => entry.id)).toEqual(['a', 'b']);
    });

    it('does not duplicate an edge the mirror still holds', () => {
        // The opposite flush order: the delete handler ran first, so the mirror is
        // still pre-delete and already contains `e2`. Naively appending would put
        // two edges with one id into the snapshot, and restoring it would leave
        // React Flow rendering a duplicate that no click could remove.
        const current = { nodes: [node('a')], edges: [edge('e1'), edge('e2')] };

        const before = graphIncluding(current, { edges: [edge('e2')] });

        expect(before.edges.map((entry) => entry.id).sort()).toEqual(['e1', 'e2']);
    });

    it('restores a deleted node along with its edges', () => {
        // Deleting a node takes its connections with it, and React Flow's `onDelete`
        // reports both in one call — which is why the page listens to that rather
        // than to the `onNodesDelete`/`onEdgesDelete` pair, who between them would
        // push two snapshots for one keypress.
        const current = { nodes: [node('a')], edges: [] as { id: string }[] };

        const before = graphIncluding(current, {
            nodes: [node('b')],
            edges: [edge('a-b')],
        });

        expect(before.nodes.map((entry) => entry.id).sort()).toEqual(['a', 'b']);
        expect(before.edges.map((entry) => entry.id)).toEqual(['a-b']);
    });

    it('leaves the graph alone when nothing was removed', () => {
        const current = { nodes: [node('a')], edges: [edge('e1')] };

        expect(graphIncluding(current, {})).toEqual(current);
    });
});
