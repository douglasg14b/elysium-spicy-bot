import { MalformedJourneyError, resolveFlowJourney } from '../../provisioning';

/**
 * The resource keys a flow declares, for `flowReadinessIssues`.
 *
 * Resolved through the flow's journey attachment rather than by assuming the journey
 * is keyed on the flow's own id, so a flow sharing a journey with others sees the keys
 * that journey declares. A flow attached to nothing has no journey row at all, which
 * is the normal state and not an error — hence the empty set rather than a refusal.
 *
 * Ownership is deliberately *not* checked here. This set only decides which picker
 * fields are allowed to be empty pending an install; it creates nothing, so the
 * positive ownership check the install route performs would cost a flow its readiness
 * without protecting anything.
 *
 * **Throws** `MalformedJourneyError` when the journey row is stored malformed —
 * `journeysRepo` validates on read — and whatever the driver throws when the read itself
 * fails. Callers go through {@link readDeclaredKeys}, which tells the two apart.
 */
export async function declaredResourceKeys(guildId: string, flowId: string): Promise<ReadonlySet<string>> {
    const resolved = await resolveFlowJourney(guildId, flowId);
    return new Set((resolved?.journey.resources ?? []).map((resource) => resource.key));
}

export type DeclaredKeysLookup =
    | { readonly ok: true; readonly keys: ReadonlySet<string> }
    | { readonly ok: false; readonly error: string };

/**
 * {@link declaredResourceKeys}, or the one sentence every caller gives when it cannot
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
 * @param lookup - The keys' source; the real one unless a test stands in for it.
 */
export async function readDeclaredKeys(
    guildId: string,
    flowId: string,
    lookup: (guildId: string, flowId: string) => Promise<ReadonlySet<string>> = declaredResourceKeys
): Promise<DeclaredKeysLookup> {
    try {
        return { ok: true, keys: await lookup(guildId, flowId) };
    } catch (cause) {
        if (!(cause instanceof MalformedJourneyError)) {
            throw cause;
        }
        // The message only — no stack, which would be the one thing in a repo error
        // worth keeping out of a response body.
        const reason = cause.message;
        return {
            ok: false,
            error:
                "This flow's declared resources are stored in a state the server can't read, " +
                `so whether it's ready to go live can't be checked: ${reason}`,
        };
    }
}
