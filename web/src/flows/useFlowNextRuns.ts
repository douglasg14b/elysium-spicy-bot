import { useCallback, useEffect, useRef, useState } from 'react';
import { getFlowNextRuns, type FlowNextRuns } from '@brattybot/web-sdk';
import { anyNextRunPassed, nodeDataKey } from './nextRun';

/** A node of the saved flow, as the next-run line compares a card against it. */
export interface SavedNode {
    readonly id: string;
    /** Its config as the canvas holds it — defaults backfilled — so an untouched node matches. */
    readonly data: Record<string, unknown>;
}

export interface FlowNextRunsState {
    /**
     * When the saved flow's nodes next start a run, by node id. `null` before the first
     * answer, after one that failed, and while a change is being asked about again.
     */
    readonly nextRuns: FlowNextRuns | null;
    /** Each saved node's config by id, as `nodeDataKey` reads it. */
    readonly savedNodeData: ReadonlyMap<string, string>;
    /** Ask again, keeping what is shown until the answer lands — for an open, or a poll. */
    readonly refresh: () => Promise<void>;
    /**
     * The saved flow changed — a save that wrote it, a switch on or off. Clears what is
     * shown and asks again: the times on screen describe the flow before the change, and a
     * card must not count down to one of them while the answer is on its way, or for good
     * if it fails.
     */
    readonly invalidate: () => void;
    /** These nodes are now the saved flow — from the flow at load, or a save that wrote it, never a draft. */
    readonly markSaved: (nodes: readonly SavedNode[]) => void;
}

/**
 * The cards' next-run countdown for one flow: what the server lists, and the saved config
 * each card is compared against to tell a countdown from "worked out when you save".
 *
 * Never in the way: a failed fetch is dropped and the cards show none. Only the newest
 * request's answer lands, so a save and a toggle in quick succession — or another flow
 * opened meanwhile — cannot leave an older answer on screen. A direct SDK call rather
 * than a query for that reason: the request counter owns the ordering, as the builder's
 * other ordered reads do. While any listed time has
 * passed it asks again once a minute: the tick that fires a schedule moves it on, and the
 * countdown should follow even if it stays overdue for a while first.
 */
export function useFlowNextRuns(guildId: string | undefined, flowId: string | undefined): FlowNextRunsState {
    const [nextRuns, setNextRuns] = useState<FlowNextRuns | null>(null);
    const [savedNodeData, setSavedNodeData] = useState<ReadonlyMap<string, string>>(() => new Map());
    /** Which fetch is the newest, so an older answer landing late is dropped. */
    const request = useRef(0);

    // Another flow's countdown, or an answer still on its way for one, is not this one's.
    useEffect(() => {
        request.current += 1;
        setNextRuns(null);
        setSavedNodeData(new Map());
    }, [guildId, flowId]);

    const refresh = useCallback(async () => {
        if (!guildId || !flowId) return;
        request.current += 1;
        const asked = request.current;
        try {
            const { data: answer } = await getFlowNextRuns({ path: { guildId, flowId } });
            if (asked === request.current) setNextRuns(answer);
        } catch {
            // A countdown is a nicety; a builder that would not open without one would not
            // be. The cards simply show none.
        }
    }, [guildId, flowId]);

    const invalidate = useCallback(() => {
        setNextRuns(null);
        void refresh();
    }, [refresh]);

    const markSaved = useCallback((nodes: readonly SavedNode[]) => {
        setSavedNodeData(new Map(nodes.map((node) => [node.id, nodeDataKey(node.data)])));
    }, []);

    useEffect(() => {
        if (!nextRuns || Object.keys(nextRuns.nextRuns).length === 0) return;
        const timer = setInterval(() => {
            if (anyNextRunPassed(nextRuns, new Date())) void refresh();
        }, 60_000);
        return () => clearInterval(timer);
    }, [nextRuns, refresh]);

    return { nextRuns, savedNodeData, refresh, invalidate, markSaved };
}
