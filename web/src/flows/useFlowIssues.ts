/**
 * What is wrong with the canvas, as the author should see it right now.
 *
 * Two sources, merged by `visibleIssues`:
 *
 *  - **The server's last answer** — on open, from every save, and from the re-check
 *    asked whenever focus leaves the inspector. It is the authority, and the only one
 *    that sees everything: graph rules, declared resources, a block's `.refine()`.
 *  - **Live checks on the fields edited since** — each block's rules as the SDK carries
 *    them, generated from its schema with the server's sentences (`liveFieldIssues.ts`),
 *    run on every keystroke. They are what clear a mark as the author fixes it, rather
 *    than one blur later.
 *
 * An edited field's server complaint is dropped, since it describes a value that is
 * gone; every other field keeps the server's word, so fixing one of three problems does
 * not hide the other two. When the server answers, it speaks for every field edited
 * before the question was asked — and only those: a field typed into while the answer
 * was on its way is still ahead of it.
 *
 * Only the newest question's answer is taken: a re-check still on its way when a save
 * answers describes an older canvas than the save does, so it is dropped.
 */

import { zFlowBlockFieldRules } from '@brattybot/web-sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { checkFlow } from '../api/flows';
import type { FlowGraph, FlowValidationIssue, NodeDescriptor } from '../api/types';
import { fieldOwning, liveFieldIssues } from './liveFieldIssues';
import { shouldAcceptResponse } from './resourceSaveQueue';
import { visibleIssues } from './validationIssues';

interface FlowIssuesInput {
    /** Undefined until a guild is selected; nothing is asked before then. */
    readonly guildId: string | undefined;
    readonly flowId: string | undefined;
    /** The canvas as it stands — what a re-check sends, and what live checks read. */
    readonly graph: FlowGraph;
    /** Every block's descriptor, for the fields it draws and when each is shown. */
    readonly catalog: readonly NodeDescriptor[];
}

/** Which edits an answer covers: every one made up to this point. */
export type EditMark = number;

export interface FlowIssues {
    /** What to show, on the cards and under the fields. */
    readonly issues: readonly FlowValidationIssue[];
    /**
     * The server answered some other way — the flow or a draft opened, a save landed or
     * was refused. Replaces its last answer, and drops any re-check still on its way.
     *
     * `asOf` is the {@link FlowIssues.editMark} taken when the question left; edits made
     * after it stay live. Without it the answer covers every edit, which is right for a
     * canvas just loaded.
     */
    readonly setIssues: (issues: readonly FlowValidationIssue[], asOf?: EditMark) => void;
    /** Where the edits stand now, for a caller about to ask the server something. */
    readonly editMark: () => EditMark;
    /** The author changed these `node.data` keys on this node. */
    readonly markEdited: (nodeId: string, configKeys: readonly string[]) => void;
    /**
     * Ask again about the canvas, once the edit in progress has landed.
     *
     * Asks from an effect rather than from the caller's stack: wired to `blur`, a control
     * that commits its value as it loses focus would otherwise have the old value sent.
     * Asks nothing when the canvas is the one last asked about, so moving between fields
     * without changing anything costs no request.
     */
    readonly recheck: () => void;
}

/** An edited field, as one string: node ids are free-form, so the separator is one no id holds. */
const editKey = (nodeId: string, field: string): string => `${nodeId}\u0000${field}`;

export function useFlowIssues({ guildId, flowId, graph, catalog }: FlowIssuesInput): FlowIssues {
    const [serverIssues, setServerIssues] = useState<readonly FlowValidationIssue[]>([]);
    /** Each edited field, with the edit number it was last changed at. */
    const [edits, setEdits] = useState<ReadonlyMap<string, { nodeId: string; field: string; at: EditMark }>>(
        () => new Map()
    );
    const editCountRef = useRef(0);
    /** Bumped by `recheck`; the effect below asks once per bump. */
    const [recheckTick, setRecheckTick] = useState(0);
    /** Monotonic question number, for the reason `shouldAcceptResponse` gives. */
    const issuedRef = useRef(0);
    /** The canvas last asked about, serialised — unknown after any other answer. */
    const askedRef = useRef<string | undefined>(undefined);
    /** The canvas the server's answer on hand describes, when a re-check gave it. */
    const answeredRef = useRef<string | undefined>(undefined);

    const latestRef = useRef({ guildId, flowId, graph, catalog });
    latestRef.current = { guildId, flowId, graph, catalog };

    /** How far the answer on hand reaches into the edits. */
    const appliedAsOfRef = useRef<EditMark>(0);

    /**
     * The server has spoken for every edit up to `asOf`; all of them when absent.
     *
     * An answer about an older canvas than the one on hand is dropped. A save sent before
     * the author fixed a field can answer after the re-check that saw the fix; taken, it
     * would mark the fixed field again, from a value that is gone.
     */
    const answer = useCallback((issues: readonly FlowValidationIssue[], asOf: EditMark | undefined) => {
        if (asOf !== undefined && asOf < appliedAsOfRef.current) return;
        appliedAsOfRef.current = asOf ?? editCountRef.current;
        setServerIssues(issues);
        setEdits((current) => {
            if (asOf === undefined) return current.size === 0 ? current : new Map();
            const ahead = [...current].filter(([, edit]) => edit.at > asOf);
            return ahead.length === current.size ? current : new Map(ahead);
        });
    }, []);

    const setIssues = useCallback(
        (next: readonly FlowValidationIssue[], asOf?: EditMark) => {
            if (asOf !== undefined && asOf < appliedAsOfRef.current) return;
            issuedRef.current += 1;
            askedRef.current = undefined;
            answeredRef.current = undefined;
            answer(next, asOf);
        },
        [answer]
    );

    const editMark = useCallback(() => editCountRef.current, []);

    const markEdited = useCallback((nodeId: string, configKeys: readonly string[]) => {
        const node = latestRef.current.graph.nodes.find((candidate) => candidate.id === nodeId);
        const descriptor = node && latestRef.current.catalog.find((entry) => entry.type === node.type);
        if (!descriptor) return;

        const fields = new Set(
            configKeys.map((key) => fieldOwning(descriptor, key)).filter((field): field is string => !!field)
        );
        if (fields.size === 0) return;

        editCountRef.current += 1;
        const at = editCountRef.current;
        setEdits((current) => {
            const next = new Map(current);
            for (const field of fields) next.set(editKey(nodeId, field), { nodeId, field, at });
            return next;
        });
    }, []);

    const recheck = useCallback(() => setRecheckTick((tick) => tick + 1), []);

    useEffect(() => {
        if (recheckTick === 0) return;
        const { guildId: guild, flowId: flow, graph: canvas } = latestRef.current;
        if (!guild || !flow) return;

        const serialised = JSON.stringify(canvas);
        if (serialised === answeredRef.current) {
            // Edited and put back: the answer on hand already describes this canvas,
            // so it speaks for every edit without asking again.
            appliedAsOfRef.current = editCountRef.current;
            setEdits((current) => (current.size === 0 ? current : new Map()));
            return;
        }
        if (serialised === askedRef.current) return;
        askedRef.current = serialised;
        issuedRef.current += 1;
        const issued = issuedRef.current;
        const asOf = editCountRef.current;

        checkFlow(guild, flow, canvas)
            .then((found) => {
                if (!shouldAcceptResponse(issued, issuedRef.current)) return;
                answeredRef.current = serialised;
                answer(found, asOf);
            })
            .catch((err: unknown) => {
                if (!shouldAcceptResponse(issued, issuedRef.current)) return;
                // A structurally broken graph is refused with its issues, exactly as a
                // save of it would be — and those are the answer, so they are shown.
                if (err instanceof ApiError && err.issues.length > 0) {
                    answeredRef.current = serialised;
                    answer(err.issues, asOf);
                    return;
                }
                // Anything else (a dropped connection, a 500) says nothing about the
                // graph. The server's last answer and the live checks stay as they are
                // rather than being cleared, which would claim every problem fixed; and
                // the question is forgotten, so the next blur asks again. No
                // notification: one per blur would be one per field visited, and Save
                // still reports properly.
                askedRef.current = undefined;
            });
    }, [recheckTick, answer]);

    const issues = useMemo(() => {
        const edited = new Map<string, Set<string>>();
        for (const { nodeId, field } of edits.values()) {
            const fields = edited.get(nodeId) ?? new Set<string>();
            fields.add(field);
            edited.set(nodeId, fields);
        }
        return visibleIssues(
            serverIssues,
            edited,
            liveFieldIssues(graph.nodes, catalog, edited, zFlowBlockFieldRules.shape)
        );
    }, [serverIssues, edits, graph, catalog]);

    return { issues, setIssues, editMark, markEdited, recheck };
}
