import { z } from 'zod';
import type { FlowDraftEntity } from '../../features/flows/data/flowDraftsSchema';
import type { FlowGraph } from '../../features/flows/data/flowGraph';
import type { FlowEntity } from '../../features/flows/data/flowsSchema';
import { describeIssue, type FlowValidationIssue } from '../../features/flows/engine/nodeDataValidation';
import { flowReadinessIssues } from '../../features/flows/logic/flowReadiness';
import type { FlowJourneyIndexEntry, FlowJourneyMembership } from './flowJourneyIndex';

/**
 * A flow's name as a request carries it — on the flow, and on a draft of it, which holds
 * the name the canvas had so a rename is part of the unsaved work. One schema so the two
 * cannot come to accept different names.
 */
export const flowNameSchema = z
    .string()
    .min(1, 'Give the flow a name.')
    .max(100, 'Flow names cap at 100 characters.');

/**
 * The flow version a canvas descends from, as a request states it: the `updatedAt` the
 * builder was given when it loaded the flow, or the `baseUpdatedAt` of a draft it loaded
 * instead — both ISO strings this server wrote. See `FlowDraftInput.baseUpdatedAt`.
 */
export const flowDraftBaseSchema = z.iso.datetime();

/**
 * The 400 body for a graph too broken to store at all — on the flow or on a draft.
 *
 * `error` stays, and stays first: every existing client reads it, `ApiError` falls
 * back to it, and a notification with no room for a list still needs a sentence.
 * `issues` is the same information in the shape every other graph complaint takes;
 * a structural error blames no node, because a dangling edge or a duplicate id is a
 * fact about the graph rather than about any one block.
 *
 * Only structural failures reach this. An incomplete graph is stored and its issues
 * ride the 200; the refusals that are about readiness write their own sentence,
 * because theirs is about the flow being live rather than about the graph.
 */
export function invalidGraphBody(errors: readonly string[]): {
    error: string;
    issues: readonly FlowValidationIssue[];
} {
    const issues = errors.map((message) => ({ message }));
    return { error: issues.map(describeIssue).join('; '), issues };
}

/**
 * A single flow on the wire — the body of GET, POST and a successful PUT.
 *
 * `issues` describes the **stored** graph, on every route that returns one: the builder
 * reads it on open so an incomplete flow's cards are already red, and after a save so the
 * canvas matches what the server now holds. Empty means ready. See `flowReadinessIssues`
 * for the three states a graph can be in.
 */
export interface FlowDetailBody {
    readonly flowId: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly graph: FlowGraph;
    readonly issues: readonly FlowValidationIssue[];
    readonly createdAt: string;
    readonly updatedAt: string;
}

/**
 * One row of the flows list: metadata plus a node count, no graph.
 *
 * `journey` is present for every flow that resolves to one — including the implicit
 * single-flow case, whose `memberCount` is 1. The page decides from that number whether
 * to render a group at all; the server deliberately does not pre-judge it, because
 * "which journey is this flow in" and "should the operator be shown the concept" are
 * different questions and only the second is a layout choice.
 *
 * `issueCount` is a count rather than the list: the row has room for a chip, and the
 * list is what the builder shows once the operator opens the flow to fix it.
 */
export interface FlowSummaryBody {
    readonly flowId: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly nodeCount: number;
    readonly issueCount: number;
    readonly journey: FlowJourneyMembership | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/**
 * Where a graph save landed — the discriminant of {@link FlowSaveBody}.
 *
 *  - `flow`: on the flow row. The saver's own draft, if they had one, is gone with it.
 *  - `draft`: on the saver's draft only, because the flow is live and the graph is
 *    incomplete or waiting on its install. The flow row — its graph, its name — is
 *    exactly as it was.
 */
export const FLOW_SAVE_TARGETS = ['flow', 'draft'] as const;
export type FlowSaveTarget = (typeof FLOW_SAVE_TARGETS)[number];

/**
 * One operator's draft, without its graph — the body of `PUT drafts/mine`.
 *
 * `mine` is the caller's own, answered by the server so the page does not need to know
 * who it is signed in as. `flowSavedSince` is `true` when the flow was saved after this
 * draft was started, so loading it would put back what that save changed.
 */
export interface FlowDraftSummaryBody {
    readonly draftId: number;
    readonly authorId: string;
    readonly authorName: string;
    readonly mine: boolean;
    readonly name: string;
    readonly baseUpdatedAt: string;
    readonly flowSavedSince: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/**
 * A draft with what the builder needs to load it: the graph, and its readiness issues
 * judged against the flow's declarations — so the cards come up marked the way they
 * would after a save.
 */
export interface FlowDraftBody extends FlowDraftSummaryBody {
    readonly graph: FlowGraph;
    readonly issues: readonly FlowValidationIssue[];
}

/**
 * The body of a successful `PUT /flows/:flowId`.
 *
 * Always the flow as it now stands — for `draft` that is the untouched live row and its
 * issues, which is what the enable switch and the flows list must keep describing. The
 * `draft` arm adds the draft the graph went to, whose `issues` are the ones the canvas
 * should show, since that is the graph on it, and `uninstalled`: the declared resources
 * it picks that are not in the server yet. Either being non-empty is why it is a draft.
 */
export type FlowSaveBody =
    | (FlowDetailBody & { readonly savedAs: 'flow' })
    | (FlowDetailBody & {
          readonly savedAs: 'draft';
          readonly draft: FlowDraftBody;
          readonly uninstalled: readonly string[];
      });

/** A stored flow as {@link FlowDetailBody}, with the readiness issues its caller computed. */
export function flowDetail(flow: FlowEntity, issues: readonly FlowValidationIssue[]): FlowDetailBody {
    return {
        flowId: flow.flowId,
        name: flow.name,
        enabled: flow.enabled,
        graph: flow.graph,
        issues,
        createdAt: new Date(flow.createdAt).toISOString(),
        updatedAt: new Date(flow.updatedAt).toISOString(),
    };
}

/**
 * A stored draft as {@link FlowDraftSummaryBody}, as `viewerId` sees it.
 *
 * @param flowUpdatedAt - The flow's `updatedAt` now, which `flowSavedSince` is judged
 * against. Compared as instants, not strings, because the two columns come back through
 * the date plugin as `Date`s on one dialect and could be formatted differently on another.
 */
export function flowDraftSummary(
    draft: FlowDraftEntity,
    viewerId: string,
    flowUpdatedAt: Date | string
): FlowDraftSummaryBody {
    return {
        draftId: draft.id,
        authorId: draft.authorId,
        authorName: draft.authorName,
        mine: draft.authorId === viewerId,
        name: draft.name,
        baseUpdatedAt: new Date(draft.baseUpdatedAt).toISOString(),
        flowSavedSince: new Date(flowUpdatedAt).getTime() > new Date(draft.baseUpdatedAt).getTime(),
        createdAt: new Date(draft.createdAt).toISOString(),
        updatedAt: new Date(draft.updatedAt).toISOString(),
    };
}

/** A stored draft as {@link FlowDraftBody}, with the readiness issues its caller computed. */
export function flowDraft(
    draft: FlowDraftEntity,
    viewerId: string,
    flowUpdatedAt: Date | string,
    issues: readonly FlowValidationIssue[]
): FlowDraftBody {
    return { ...flowDraftSummary(draft, viewerId, flowUpdatedAt), graph: draft.graph, issues };
}

/**
 * A stored flow as {@link FlowSummaryBody}, judged against its entry in the list's
 * journey index — so a row's `issueCount` costs no query of its own.
 */
export function flowSummary(flow: FlowEntity, entry: FlowJourneyIndexEntry | undefined): FlowSummaryBody {
    return {
        flowId: flow.flowId,
        name: flow.name,
        enabled: flow.enabled,
        nodeCount: flow.graph.nodes.length,
        // A flow in no journey declares nothing, exactly as `declaredResourceKeys` answers.
        issueCount: flowReadinessIssues(flow.graph, entry?.declaredKeys ?? new Set<string>()).length,
        journey: entry?.membership ?? null,
        createdAt: new Date(flow.createdAt).toISOString(),
        updatedAt: new Date(flow.updatedAt).toISOString(),
    };
}

/**
 * The wire-shape member lists `flowWireShapeDrift.test.ts` compares against the browser's
 * copy in `web/src/api/types.ts`.
 *
 * Data rather than a type import for the reason `TICKET_SUMMARY_KEYS` gives: a single
 * `import type` from `src/` into `web/src/` pulls the bot tree into the browser project's
 * compilation. `satisfies` holds each list to its interface, and the check below fails to
 * compile when the interface gains a member the list does not name.
 */
export const FLOW_DETAIL_KEYS = [
    'flowId',
    'name',
    'enabled',
    'graph',
    'issues',
    'createdAt',
    'updatedAt',
] as const satisfies readonly (keyof FlowDetailBody)[];

export const FLOW_SUMMARY_KEYS = [
    'flowId',
    'name',
    'enabled',
    'nodeCount',
    'issueCount',
    'journey',
    'createdAt',
    'updatedAt',
] as const satisfies readonly (keyof FlowSummaryBody)[];

export const FLOW_DRAFT_SUMMARY_KEYS = [
    'draftId',
    'authorId',
    'authorName',
    'mine',
    'name',
    'baseUpdatedAt',
    'flowSavedSince',
    'createdAt',
    'updatedAt',
] as const satisfies readonly (keyof FlowDraftSummaryBody)[];

export const FLOW_DRAFT_KEYS = [
    ...FLOW_DRAFT_SUMMARY_KEYS,
    'graph',
    'issues',
] as const satisfies readonly (keyof FlowDraftBody)[];

/** One list per arm of {@link FlowSaveBody}: `keyof` a union names only what the arms share. */
export const FLOW_SAVED_TO_FLOW_KEYS = [
    ...FLOW_DETAIL_KEYS,
    'savedAs',
] as const satisfies readonly (keyof Extract<FlowSaveBody, { savedAs: 'flow' }>)[];

export const FLOW_SAVED_AS_DRAFT_KEYS = [
    ...FLOW_DETAIL_KEYS,
    'savedAs',
    'draft',
    'uninstalled',
] as const satisfies readonly (keyof Extract<FlowSaveBody, { savedAs: 'draft' }>)[];

/** Fails to compile if a flow wire shape gains a member absent from its list above. */
type FlowKeyListsAreComplete =
    | Exclude<keyof FlowDetailBody, (typeof FLOW_DETAIL_KEYS)[number]>
    | Exclude<keyof FlowSummaryBody, (typeof FLOW_SUMMARY_KEYS)[number]>
    | Exclude<keyof FlowDraftSummaryBody, (typeof FLOW_DRAFT_SUMMARY_KEYS)[number]>
    | Exclude<keyof FlowDraftBody, (typeof FLOW_DRAFT_KEYS)[number]>
    | Exclude<keyof Extract<FlowSaveBody, { savedAs: 'flow' }>, (typeof FLOW_SAVED_TO_FLOW_KEYS)[number]>
    | Exclude<keyof Extract<FlowSaveBody, { savedAs: 'draft' }>, (typeof FLOW_SAVED_AS_DRAFT_KEYS)[number]>
    // The vocabulary, both ways: a `savedAs` arm the list does not name, or a name no arm has.
    | Exclude<FlowSaveBody['savedAs'], FlowSaveTarget>
    | Exclude<FlowSaveTarget, FlowSaveBody['savedAs']>;

/**
 * Do not delete as unused: removing it erases the guard above. The tuple wrapper is
 * load-bearing — a bare `extends never` distributes and is vacuously true.
 */
const flowKeyListsAreComplete: [FlowKeyListsAreComplete] extends [never]
    ? true
    : ['A flow wire-shape key list is missing', FlowKeyListsAreComplete] = true;
void flowKeyListsAreComplete;
