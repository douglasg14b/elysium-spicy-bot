import { z } from '@hono/zod-openapi';
import type { FlowDraftEntity } from '../../features/flows/data/flowDraftsSchema';
import { flowEdgeSchema, flowGraphSchema, flowNodeSchema, type FlowGraph } from '../../features/flows/data/flowGraph';
import type { FlowEntity } from '../../features/flows/data/flowsSchema';
import { describeIssue, type FlowValidationIssue } from '../../features/flows/engine/nodeDataValidation';
import { flowReadinessIssues } from '../../features/flows/logic/flowReadiness';
import { JOURNEY_INSTALL_STATES } from '../../features/provisioning/logic/journeyInstallState';
import type { FlowJourneyIndexEntry, FlowJourneyMembership } from './flowJourneyIndex';
import {
    errorBodyResponse,
    ErrorBodySchema,
    GUILD_SCOPED_BODY_ERRORS,
    GUILD_SCOPED_ERRORS,
    GuildPathSchema,
    jsonResponse,
    type ChecksHold,
    type MismatchedChecks,
    type SchemaMatches,
} from './openApi';

/**
 * The flow shapes the browser receives and sends.
 *
 * Each is a zod schema, and the schema **is** the contract: `flowRoutes` declares it on
 * its routes, `router.openapi` type-checks every `c.json(...)` against it, and the OpenAPI
 * spec the dashboard SDK is generated from names it as a component. The `.openapi('Name')`
 * ids are the names the dashboard imports by, so renaming one renames a generated type.
 *
 * The builders below are typed by `z.infer` of their schema, so a member the schema does
 * not describe is a compile error where the body is built, not a field the spec never
 * mentions. Where a domain type is sent as it is — a graph, an issue, a journey's
 * membership — the domain type stays where it lives and the schema is held to it both
 * ways by a {@link SchemaMatches} check.
 *
 * `src/features/**` imports neither hono nor `@hono/zod-openapi`: `flowGraphSchema` is
 * plain zod, and is rebuilt and named here, in the web layer, rather than there. Every
 * schema in this file is made with `@hono/zod-openapi`'s `z` — see `FlowGraphSchema` for
 * why a schema made anywhere else cannot be named.
 */

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
 * `flowGraphSchema`, with the graph, its nodes and its edges named for the spec.
 *
 * Rebuilt from the feature's own field schemas rather than named in place, for two
 * reasons:
 *
 *  - **`.openapi()` only exists on a schema created after `@hono/zod-openapi` loaded.**
 *    Zod copies its prototype methods onto each schema as the schema is built, and the
 *    library adds `openapi` to that prototype on import. The feature's schemas are built
 *    whenever `flows` loads — before the web layer in the bot, and before this file in a
 *    test that imports the graph first — so calling it on them works or throws depending
 *    on import order.
 *  - **`.openapi('Name')` returns a named copy**, so naming `flowNodeSchema` would leave
 *    the copy `flowGraphSchema` holds anonymous, and every generated type would inline it.
 *
 * Each object below is new and made with this module's `z`, over the feature's own field
 * schemas — so the rules are `flowGraphSchema`'s, and the check holds the result to
 * `FlowGraph` both ways.
 */
const FlowNodeSchema = z.object(flowNodeSchema.shape).openapi('FlowNode');
const FlowEdgeSchema = z.object(flowEdgeSchema.shape).openapi('FlowEdge');

export const FlowGraphSchema = z
    .object({
        ...flowGraphSchema.shape,
        nodes: z.array(FlowNodeSchema),
        edges: z.array(FlowEdgeSchema),
    })
    .openapi('FlowGraph');

/**
 * One problem with a graph — on a node, on one of its fields, or on the graph as a whole.
 * The shape `ApiError.issues` carries in the dashboard SDK, from a refusal's body.
 */
export const FlowValidationIssueSchema = z
    .object({
        nodeId: z.string().optional(),
        /** Dotted path into the node's config, e.g. `fields.0.name`. */
        field: z.string().optional(),
        message: z.string(),
    })
    .openapi('FlowValidationIssue', {
        description:
            'One problem with a graph. `nodeId` names the node it is on and `field` the dotted path ' +
            'into its config (e.g. `fields.0.name`); a problem with the graph as a whole has neither.',
    });

export const FlowValidationIssuesSchema = z.array(FlowValidationIssueSchema).readonly();

/**
 * The 400 a flow route sends when it refuses a request: the sentence every refusal
 * carries, plus the issues behind it when the refusal is about a graph.
 *
 * One schema because the spec holds one per status, and two different things answer 400
 * on these routes. The request validator refuses a body that is the wrong shape — a
 * missing name, a malformed graph — with the sentence alone. The route refuses a graph
 * too broken to store, or a switch-on the graph is not ready for, with `issues` as well.
 * `issues` is empty when nothing on the canvas is wrong — the install refusal, where the
 * flow waits on its resources rather than on a fix.
 */
export const FlowRefusalSchema = ErrorBodySchema.extend({
    issues: FlowValidationIssuesSchema.optional(),
}).openapi('FlowRefusal');

/** The path of every route about one flow, drafts included. */
export const FlowPathSchema = GuildPathSchema.extend({
    flowId: z.string(),
});

/*
 * What the flow and draft routes refuse with, beyond the middleware's own answers. Here
 * rather than in `flowRoutes.ts` because `flowDraftRoutes.ts` shares them and is imported
 * by it. One entry per status in the spec, so a status two causes share names both. Not
 * `as const`: see `openApi.ts`.
 */

/** The 404 of a route that looks the flow up first. */
export const FLOW_NOT_FOUND = errorBodyResponse('The bot is not in this server, or the flow is not in it.');

/** The 500 of a route that judges readiness and cannot read the flow's journey to do it. */
export const DECLARATIONS_UNREADABLE = errorBodyResponse(
    "The flow's journey could not be read, so its readiness cannot be judged; the sentence names the cause. Or something else failed unexpectedly."
);

/** The 400 of a route that takes a graph: the body, the graph, or the server id was refused. */
export const GRAPH_REFUSED = jsonResponse(
    'The body was refused, the graph is too broken to store (`issues` says where), or the server id is missing.',
    FlowRefusalSchema
);

/** A route about one flow that reads no body. */
export const FLOW_ERRORS = {
    ...GUILD_SCOPED_ERRORS,
    404: FLOW_NOT_FOUND,
};

/** A route about one flow that takes a graph. */
export const FLOW_GRAPH_BODY_ERRORS = {
    ...GUILD_SCOPED_BODY_ERRORS,
    400: GRAPH_REFUSED,
    404: FLOW_NOT_FOUND,
};

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
export function invalidGraphBody(errors: readonly string[]): z.infer<typeof FlowRefusalSchema> {
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
export const FlowSchema = z
    .object({
        flowId: z.string(),
        name: z.string(),
        enabled: z.boolean(),
        graph: FlowGraphSchema,
        issues: FlowValidationIssuesSchema,
        createdAt: z.string(),
        updatedAt: z.string(),
    })
    .openapi('Flow', {
        description:
            'A flow with its graph. `issues` describes the stored graph: empty means it is ready to ' +
            'go live, and a switched-off flow may hold an unfinished one.',
    });

export type FlowDetailBody = z.infer<typeof FlowSchema>;

/**
 * Which journey a flow sits in, as its list row reports it. `FlowJourneyMembership` in
 * `flowJourneyIndex.ts` is the type the index builds; this is that type on the wire.
 */
export const FlowJourneyMembershipSchema = z
    .object({
        journeyKey: z.string(),
        name: z.string(),
        resourceCount: z.number(),
        memberCount: z.number(),
        installState: z.enum(JOURNEY_INSTALL_STATES),
        installedCount: z.number(),
        installedKeys: z.array(z.string()).readonly(),
    })
    .openapi('FlowJourneyMembership', {
        description:
            'The journey a flow sits in, present for every flow that resolves to one. Group rows on ' +
            '`memberCount > 1`, not on this being present: 1 is the implicit journey a lone flow ' +
            'gets. `installState` says install has run over the declared resources, read from the ' +
            'binding table — not that every channel still exists. `installedKeys` are the keys with ' +
            'a live binding, which must stop following their resource name.',
    });

/**
 * Each schema above that states a domain type the routes send as it is, against that type.
 * Gathered here so `__tests__/flowBody.test-d.ts` can assert them; see {@link SchemaMatches}.
 */
type FlowBodyChecks = ChecksHold<{
    FlowGraph: SchemaMatches<typeof FlowGraphSchema, FlowGraph>;
    FlowValidationIssue: SchemaMatches<typeof FlowValidationIssueSchema, FlowValidationIssue>;
    FlowJourneyMembership: SchemaMatches<typeof FlowJourneyMembershipSchema, FlowJourneyMembership>;
}>;

/** The checks in {@link FlowBodyChecks} that fail, or `never`. Asserted `never` in `__tests__/flowBody.test-d.ts`. */
export type FlowBodyMismatch = MismatchedChecks<FlowBodyChecks>;

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
export const FlowSummarySchema = z
    .object({
        flowId: z.string(),
        name: z.string(),
        enabled: z.boolean(),
        nodeCount: z.number(),
        issueCount: z.number(),
        // A union rather than `.nullable()`: the generator copies a named schema's name onto
        // its nullable variant, so the component itself would become nullable and every
        // membership in the SDK would read `| null`.
        journey: z.union([FlowJourneyMembershipSchema, z.null()]),
        createdAt: z.string(),
        updatedAt: z.string(),
    })
    .openapi('FlowSummary', {
        description:
            'One row of the flows list, without the graph. `issueCount` above 0 means the flow is ' +
            'incomplete: saved, but refused if switched on.',
    });

export type FlowSummaryBody = z.infer<typeof FlowSummarySchema>;

/**
 * One operator's draft, without its graph — the body of `PUT drafts/mine`.
 *
 * `mine` is the caller's own, answered by the server so the page does not need to know
 * who it is signed in as. `flowSavedSince` is `true` when the flow was saved after this
 * draft was started, so loading it would put back what that save changed.
 */
export const FlowDraftSummarySchema = z
    .object({
        draftId: z.number(),
        authorId: z.string(),
        authorName: z.string(),
        mine: z.boolean(),
        name: z.string(),
        baseUpdatedAt: z.string(),
        flowSavedSince: z.boolean(),
        createdAt: z.string(),
        updatedAt: z.string(),
    })
    .openapi('FlowDraftSummary', {
        description:
            "One operator's draft of a flow, without its graph. `mine` is the caller's own; " +
            '`flowSavedSince` means the flow was saved after the draft was started.',
    });

export type FlowDraftSummaryBody = z.infer<typeof FlowDraftSummarySchema>;

/**
 * A draft with what the builder needs to load it: the graph, and its readiness issues
 * judged against the flow's declarations — so the cards come up marked the way they
 * would after a save.
 */
export const FlowDraftSchema = FlowDraftSummarySchema.extend({
    graph: FlowGraphSchema,
    issues: FlowValidationIssuesSchema,
}).openapi('FlowDraft', {
    description: "One operator's draft of a flow, with its graph and that graph's readiness issues.",
});

export type FlowDraftBody = z.infer<typeof FlowDraftSchema>;

/**
 * The body of a successful `PUT /flows/:flowId`.
 *
 * Always the flow as it now stands — for `draft` that is the untouched live row and its
 * issues, which is what the enable switch and the flows list must keep describing. The
 * `draft` arm adds the draft the graph went to, whose `issues` are the ones the canvas
 * should show, since that is the graph on it, and `uninstalled`: the declared resources
 * it picks that are not in the server yet. Either being non-empty is why it is a draft.
 *
 * Each arm is named, because the spec's discriminator maps every `savedAs` value to a
 * component and an anonymous arm has no name to map to — and each has a description of
 * its own, because an `.extend()`ed schema otherwise carries its parent's into the SDK.
 */
const FlowSavedToFlowSchema = FlowSchema.extend({
    savedAs: z.literal('flow'),
}).openapi('FlowSavedToFlow', {
    description: "The save landed on the flow. The saver's own draft, if they had one, is gone.",
});

const FlowSavedAsDraftSchema = FlowSchema.extend({
    savedAs: z.literal('draft'),
    draft: FlowDraftSchema,
    uninstalled: z.array(z.string()).readonly(),
}).openapi('FlowSavedAsDraft', {
    description:
        'The flow is live and the graph was incomplete or waits on its install, so it went to the ' +
        "saver's draft and the flow is untouched. `draft.issues` are what the canvas shows; " +
        '`uninstalled` names the declared resources the graph picks that are not in the server yet.',
});

export const FlowSaveResultSchema = z
    .discriminatedUnion('savedAs', [FlowSavedToFlowSchema, FlowSavedAsDraftSchema])
    .openapi('FlowSaveResult');

export type FlowSaveBody = z.infer<typeof FlowSaveResultSchema>;

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
