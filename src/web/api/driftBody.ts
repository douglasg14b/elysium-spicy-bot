import {
    describeDrift,
    describeOrphan,
    type JourneyDriftPlan,
    type OrphanedBinding,
} from '../../features/provisioning';

/**
 * The drift report as the browser receives it.
 *
 * A separate module for the same reason `publishedBody.ts` is one: the wire shape is a
 * contract two codebases are written against, and burying it in a route handler makes
 * it something you have to read a request to discover.
 *
 * ## Why the sentences are written here
 *
 * `describeDrift` and `describeOrphan` run **server-side** and their output travels as
 * `explanation`, rather than the browser re-deriving prose from the structured fields.
 * That follows `PublishedResource.explanation`, which already works this way, and it
 * matters more here: the drift vocabulary is subtle (an adopted resource that drifted
 * is reported and *not* repairable; a never-settled row with a live object is neither
 * "gone" nor "ours"), and a second implementation in the browser would be a second
 * place for those distinctions to be got wrong. The structured fields travel too, so
 * the client can still group, count and decide what to enable — it just does not have
 * to author the wording.
 *
 * Both functions return Discord-flavour markdown with `**bold**` segments, which the
 * browser renders through `withEmphasis`.
 */

/** One way a resource differs, paired with the sentence describing it. */
export interface DriftDetailBody {
    /** `renamed` | `reparented` | `wrongType` | `permissions`. */
    readonly kind: string;
    /** Server-authored prose. Markdown with `**bold**` segments. */
    readonly explanation: string;
}

export interface DriftResourceBody {
    readonly resourceKey: string;
    readonly name: string;
    /** What the journey declares this to be, for the row's icon and noun. */
    readonly kind: string;
    /**
     * Every way this resource differs, each with its own sentence.
     *
     * A list rather than one explanation, because `describeDrift` describes a single
     * drift and a resource can hold several — a channel that was renamed *and* dragged
     * out of its category has two independent findings, and joining them into a
     * paragraph would lose the ability to show them as the separate things they are.
     */
    readonly drift: readonly DriftDetailBody[];
    /**
     * Whether repair may touch this resource at all.
     *
     * Taken straight from the engine's own `ResourceDriftReport.repairable` rather than
     * re-derived from `kinds`, because the reasons it is false are not all visible
     * there: `wrongType` is a drift kind, but adoption is a property of the *binding*.
     * A client inferring "repairable unless wrongType" would offer a repair on an
     * adopted resource and the server would then refuse it — an offer that cannot be
     * honoured is worse than none, because the operator has already decided by the time
     * they find out.
     *
     * A display hint only. `repairDrift` re-derives the same fact from the database via
     * `withAdoptionReasserted` and does not trust what comes back over the wire.
     */
    readonly repairable: boolean;
}

export interface OrphanBody {
    readonly bindingId: number;
    readonly resourceKey: string;
    readonly kind: string;
    readonly name: string;
    readonly stillInGuild: boolean;
    readonly neverSettled: boolean;
    /** Server-authored prose. Markdown with `**bold**` segments. */
    readonly explanation: string;
}

export interface DriftBody {
    readonly journeyKey: string;
    readonly drifted: readonly DriftResourceBody[];
    /** Resources compared and found to match. Carried so the client can say "checked 6". */
    readonly cleanKeys: readonly string[];
    readonly unchecked: readonly {
        readonly resourceKey: string;
        readonly name: string;
        readonly reason: string;
    }[];
    readonly orphans: readonly OrphanBody[];
}

/*
 * The member lists the drift gate compares, and the compile-time guards that keep each
 * list honest about its own interface.
 *
 * The same machinery `ticketRoutes.ts` uses, and it is here because this file's absence
 * of it cost something real: `RepairOutcome` was mirrored in the browser with a fourth
 * member the server cannot emit, so every partial repair was reported to the operator
 * as a flat failure. Two clean typechecks and 43 tests said nothing, because each
 * workspace compiles only against its own copy.
 *
 * `satisfies` rejects a name that is not a member; `KeyListsComplete` below rejects a
 * member missing from a list. So the arrays cannot silently fall behind the interfaces,
 * and the test only has to compare arrays.
 */
export const DRIFT_DETAIL_KEYS = ['kind', 'explanation'] as const satisfies readonly (keyof DriftDetailBody)[];

export const DRIFT_RESOURCE_KEYS = [
    'resourceKey',
    'name',
    'kind',
    'drift',
    'repairable',
] as const satisfies readonly (keyof DriftResourceBody)[];

export const ORPHAN_KEYS = [
    'bindingId',
    'resourceKey',
    'kind',
    'name',
    'stillInGuild',
    'neverSettled',
    'explanation',
] as const satisfies readonly (keyof OrphanBody)[];

export const UNCHECKED_KEYS = [
    'resourceKey',
    'name',
    'reason',
] as const satisfies readonly (keyof DriftBody['unchecked'][number])[];

export const DRIFT_BODY_KEYS = [
    'journeyKey',
    'drifted',
    'cleanKeys',
    'unchecked',
    'orphans',
] as const satisfies readonly (keyof DriftBody)[];

type KeyListsComplete =
    | Exclude<keyof DriftDetailBody, (typeof DRIFT_DETAIL_KEYS)[number]>
    | Exclude<keyof DriftResourceBody, (typeof DRIFT_RESOURCE_KEYS)[number]>
    | Exclude<keyof OrphanBody, (typeof ORPHAN_KEYS)[number]>
    | Exclude<keyof DriftBody['unchecked'][number], (typeof UNCHECKED_KEYS)[number]>
    | Exclude<keyof DriftBody, (typeof DRIFT_BODY_KEYS)[number]>;

/**
 * Do not delete as unused: removing this erases the guards above.
 *
 * The tuple wrapper is load-bearing, for the reason `ticketRoutes.ts` records: a bare
 * `KeyListsComplete extends never` distributes over the union and is vacuously true for
 * an empty one, so it would pass whatever the lists said.
 */
type _KeyListsAreComplete = [KeyListsComplete] extends [never] ? true : never;
const _keyListsAreComplete: _KeyListsAreComplete = true;
void _keyListsAreComplete;

export function driftBody(
    plan: JourneyDriftPlan,
    orphans: readonly OrphanedBinding[]
): DriftBody {
    return {
        journeyKey: plan.journeyKey,
        drifted: plan.drifted.map((report) => ({
            resourceKey: report.resourceKey,
            name: report.name,
            kind: report.kind,
            // `detail`, not `kind`: the loop variable is a whole `ResourceDriftKind`
            // sitting beside `report.kind`, which is a `ResourceKind`. Naming both
            // `kind` made `kind.kind` read as a typo and hid the argument order of
            // `describeDrift` — the one call here a future edit could plausibly invert.
            drift: report.drift.map((detail) => ({
                kind: detail.kind,
                explanation: describeDrift(detail, report.kind),
            })),
            repairable: report.repairable,
        })),
        cleanKeys: plan.cleanKeys,
        unchecked: plan.unchecked.map((entry) => ({
            resourceKey: entry.resourceKey,
            name: entry.name,
            reason: entry.reason,
        })),
        orphans: orphans.map((orphan) => ({
            bindingId: orphan.bindingId,
            resourceKey: orphan.resourceKey,
            kind: orphan.kind,
            name: orphan.name,
            stillInGuild: orphan.stillInGuild,
            neverSettled: orphan.neverSettled,
            explanation: describeOrphan(orphan),
        })),
    };
}
