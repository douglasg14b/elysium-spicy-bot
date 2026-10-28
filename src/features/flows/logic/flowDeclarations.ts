import { MalformedJourneyError, resolveFlowJourney } from '../../provisioning';
import { flowsInJourney } from './journeyMembership';
import type { ReadinessScope } from './readinessScope';

/**
 * The journey a flow belongs to, as readiness needs it: its key, what it declares, and its
 * other flows — a {@link ReadinessScope} for this flow, with the journey's key beside it.
 */
export interface FlowDeclarations extends ReadinessScope {
    readonly flowId: string;
    /** `null` for a flow attached to no journey, which declares nothing and shares with nobody. */
    readonly journeyKey: string | null;
}

/**
 * The resources a flow declares, for `flowReadinessIssues`, with the key of the journey
 * declaring them and that journey's other flows (whose posted buttons a trigger here may name).
 *
 * Resolved through the flow's journey attachment rather than by assuming the journey
 * is keyed on the flow's own id, so a flow sharing a journey with others sees what that
 * journey declares. A flow attached to nothing has no journey row at all, which is the
 * normal state and not an error — hence no declarations rather than a refusal, and no
 * further read. The other flows are the journey's by the one membership rule
 * (`flowsInJourney`), this flow left out.
 *
 * Ownership is deliberately *not* checked here. The declarations only decide which picker
 * fields are allowed to be empty pending an install, and which messages a Button Click may
 * name; they create nothing, so the positive ownership check the install route performs
 * would cost a flow its readiness without protecting anything.
 *
 * **Throws** `MalformedJourneyError` when the journey row is stored malformed —
 * `journeysRepo` validates on read — and whatever the driver throws when the read itself
 * fails. Callers go through {@link readDeclarations}, which tells the two apart.
 */
export async function flowDeclarations(guildId: string, flowId: string): Promise<FlowDeclarations> {
    const resolved = await resolveFlowJourney(guildId, flowId);
    if (!resolved) {
        return { flowId, journeyKey: null, declarations: [], journeyFlows: [] };
    }

    const { journeyKey, resources } = resolved.journey;
    const members = await flowsInJourney(guildId, journeyKey);
    return {
        flowId,
        journeyKey,
        declarations: resources,
        journeyFlows: members
            .filter((member) => member.flowId !== flowId)
            .map(({ flowId: memberId, name, graph }) => ({ flowId: memberId, name, graph })),
    };
}

export type DeclarationsLookup =
    | ({ readonly ok: true } & FlowDeclarations)
    | { readonly ok: false; readonly error: string };

/**
 * {@link flowDeclarations}, or the one sentence every caller gives when it cannot
 * be answered.
 *
 * Named rather than left to become a bare 500: the author would otherwise be told to
 * "try again in a second" on a graph that is fine, forever, with nothing on screen
 * pointing at the journey row that is actually broken.
 *
 * Deliberately **not** recovered from by treating the flow as declaring nothing. That
 * would turn a corrupt row into "every picked resource is undeclared", blaming the
 * author's graph for a data problem they cannot see or fix.
 *
 * **Only a malformed row is answered here.** Anything else — a dropped connection, a
 * locked database — propagates as the ordinary 500 it is. Catching everything used to
 * tell an operator their journey was corrupt whenever the driver hiccupped, which sent
 * them to inspect a row that was fine.
 *
 * @param lookup - The declarations' source; the real one unless a test stands in for it.
 */
export async function readDeclarations(
    guildId: string,
    flowId: string,
    lookup: (guildId: string, flowId: string) => Promise<FlowDeclarations> = flowDeclarations
): Promise<DeclarationsLookup> {
    try {
        return { ok: true, ...(await lookup(guildId, flowId)) };
    } catch (cause) {
        if (!(cause instanceof MalformedJourneyError)) {
            throw cause;
        }
        // The journey's key only, so the operator knows which row to look at; what the
        // validator said about it goes to the log, never into a response body.
        console.error(`[flows] Flow ${flowId}'s journey is stored malformed:`, cause);
        return {
            ok: false,
            error:
                `This flow's declared resources (journey "${cause.journeyKey}") are stored in a state the ` +
                "server can't read, so whether it's ready to go live can't be checked.",
        };
    }
}
