import type { ResourceDeclaration } from '../../provisioning/logic/resourceDeclaration';
import type { FlowGraph } from '../data/flowGraph';

/** Another flow of the journey, as much of it as readiness reads: whose posts a trigger may name. */
export interface ReadinessFlow {
    readonly flowId: string;
    readonly name: string;
    readonly graph: FlowGraph;
}

/**
 * What a flow's readiness is judged against beyond its own graph: which flow it is, what its
 * journey declares, and the journey's other flows.
 *
 * Pure data, loaded before any transaction (`readDeclarations`, or the flows list's own index),
 * because readiness is asked inside `flowsRepo.mutate`'s.
 */
export interface ReadinessScope {
    /**
     * The flow being judged; `null` for one that does not exist yet (create, the seed), which
     * no trigger can have named.
     */
    readonly flowId: string | null;
    /** What the flow's journey declares. Empty for a flow on no journey. */
    readonly declarations: readonly ResourceDeclaration[];
    /**
     * The journey's **other** flows, by the one membership rule — never the flow itself, whose
     * graph is the one being judged (a draft, an unsaved canvas), not the stored one. Empty for
     * a flow on no journey: then only its own posts can be listened to.
     */
    readonly journeyFlows: readonly ReadinessFlow[];
}

/** A scope declaring nothing: a flow that does not exist yet, on no journey. */
export const NEW_FLOW_SCOPE: ReadinessScope = { flowId: null, declarations: [], journeyFlows: [] };
