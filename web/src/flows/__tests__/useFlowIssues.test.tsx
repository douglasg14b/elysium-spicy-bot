import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph, FlowValidationIssue, NodeDescriptor } from '../../api/types';
import { FLOW_GRAPH_VERSION } from '../../api/types';

const checkFlow = vi.fn<(guildId: string, flowId: string, graph: FlowGraph) => Promise<FlowValidationIssue[]>>();
vi.mock('../../api/flows', () => ({ checkFlow: (...args: Parameters<typeof checkFlow>) => checkFlow(...args) }));

const { useFlowIssues } = await import('../useFlowIssues');

/**
 * The ordering rules the e2e suite cannot reach: whose answer wins when a re-check and
 * a save are both on their way, when nothing is asked at all, what a failed ask leaves
 * on screen, and which fields the live checks speak for. The happy path — type into a
 * field, its mark goes — is `e2e/flowIncomplete.test.tsx`.
 */

const REQUIRED = 'Fill this in.';

const SEND_DM: NodeDescriptor = {
    type: 'action.sendDM',
    kind: 'action',
    label: 'Send DM',
    description: '',
    group: 'actions',
    icon: '✉️',
    configFields: [{ key: 'message', label: 'Message', control: 'longText', maxLength: 2000 }],
    handles: [],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
};

const STALE: FlowValidationIssue = { nodeId: 'dm', field: 'message', message: REQUIRED };
const OTHER: FlowValidationIssue = { nodeId: 'other', field: 'message', message: REQUIRED };
const FROM_SAVE: FlowValidationIssue = { nodeId: 'other', message: 'From the save' };

function graphSaying(message: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'dm', type: 'action.sendDM', position: { x: 0, y: 0 }, data: { message } },
            { id: 'other', type: 'action.sendDM', position: { x: 0, y: 100 }, data: { message: '' } },
        ],
        edges: [],
    };
}

function renderIssues(initialGraph: FlowGraph) {
    return renderHook(
        ({ graph }) => useFlowIssues({ guildId: 'guild', flowId: 'flow', graph, catalog: [SEND_DM] }),
        { initialProps: { graph: initialGraph } }
    );
}

/** A `checkFlow` answer the test settles by hand. */
function pendingCheck() {
    let settle: { resolve: (issues: FlowValidationIssue[]) => void; reject: (error: Error) => void } | undefined;
    checkFlow.mockImplementationOnce(
        () =>
            new Promise((resolve, reject) => {
                settle = { resolve, reject };
            })
    );
    return () => settle!;
}

beforeEach(() => {
    checkFlow.mockReset();
});

describe('checking a field as it is typed into', () => {
    it('drops the server’s mark on the first keystroke, and brings it back when emptied', () => {
        const hook = renderIssues(graphSaying(''));
        act(() => hook.result.current.setIssues([STALE, OTHER]));

        act(() => hook.result.current.markEdited('dm', ['message']));
        hook.rerender({ graph: graphSaying('H') });
        // The other DM is untouched, so the server still speaks for it.
        expect(hook.result.current.issues).toEqual([OTHER]);

        hook.rerender({ graph: graphSaying('') });
        expect(hook.result.current.issues).toEqual([OTHER, STALE]);
    });

    it('ignores a key no drawn field owns', () => {
        const hook = renderIssues(graphSaying(''));
        act(() => hook.result.current.setIssues([STALE]));

        act(() => hook.result.current.markEdited('dm', ['somethingElse']));
        hook.rerender({ graph: graphSaying('H') });

        expect(hook.result.current.issues).toEqual([STALE]);
    });

    it('keeps checking a field typed into while an answer was on its way', async () => {
        const hook = renderIssues(graphSaying('Hi'));
        const settle = pendingCheck();
        act(() => hook.result.current.markEdited('dm', ['message']));
        act(() => hook.result.current.recheck());
        await waitFor(() => expect(checkFlow).toHaveBeenCalledTimes(1));

        // Emptied after the question left: the answer, about "Hi", is not about this.
        act(() => hook.result.current.markEdited('dm', ['message']));
        hook.rerender({ graph: graphSaying('') });
        await act(async () => settle().resolve([]));

        expect(hook.result.current.issues).toEqual([STALE]);
    });
});

describe('re-checking the canvas', () => {
    it('drops a re-check that a save answered after', async () => {
        const hook = renderIssues(graphSaying(''));
        const settle = pendingCheck();

        act(() => hook.result.current.recheck());
        await waitFor(() => expect(checkFlow).toHaveBeenCalledTimes(1));
        act(() => hook.result.current.setIssues([FROM_SAVE]));
        await act(async () => settle().resolve([]));

        expect(hook.result.current.issues).toEqual([FROM_SAVE]);
    });

    it('ignores a save that answers about a canvas older than a re-check already did', async () => {
        const hook = renderIssues(graphSaying(''));
        // Save leaves with the field empty...
        const sentAsOf = hook.result.current.editMark();
        // ...the author fills it in and moves on, and the re-check sees the fix...
        act(() => hook.result.current.markEdited('dm', ['message']));
        hook.rerender({ graph: graphSaying('Hi') });
        checkFlow.mockResolvedValue([]);
        act(() => hook.result.current.recheck());
        await waitFor(() => expect(checkFlow).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(hook.result.current.issues).toEqual([]));

        // ...and only then does the save answer, about the empty field.
        act(() => hook.result.current.setIssues([STALE], sentAsOf));

        expect(hook.result.current.issues).toEqual([]);
    });

    it('asks nothing when the canvas is the one it last asked about', async () => {
        const hook = renderIssues(graphSaying('Hi'));
        checkFlow.mockResolvedValue([]);

        act(() => hook.result.current.recheck());
        await waitFor(() => expect(checkFlow).toHaveBeenCalledTimes(1));
        act(() => hook.result.current.recheck());
        hook.rerender({ graph: graphSaying('Hi') });
        act(() => hook.result.current.recheck());

        expect(checkFlow).toHaveBeenCalledTimes(1);
    });

    it('keeps the marks it had when the ask fails, and asks again next time', async () => {
        const hook = renderIssues(graphSaying('Hi'));
        act(() => hook.result.current.setIssues([STALE]));
        const settle = pendingCheck();

        act(() => hook.result.current.recheck());
        await waitFor(() => expect(checkFlow).toHaveBeenCalledTimes(1));
        await act(async () => settle().reject(new Error('offline')));
        expect(hook.result.current.issues).toEqual([STALE]);

        checkFlow.mockResolvedValue([]);
        act(() => hook.result.current.recheck());
        await waitFor(() => expect(hook.result.current.issues).toEqual([]));
        expect(checkFlow).toHaveBeenCalledTimes(2);
    });
});
