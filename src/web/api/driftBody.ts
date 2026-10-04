import { z } from '@hono/zod-openapi';
import {
    describeDrift,
    describeOrphan,
    type JourneyDriftPlan,
    type OrphanedBinding,
} from '../../features/provisioning';
// From its defining module, not the barrel: `z.enum` reads it while this module loads.
import { RESOURCE_DRIFT_KINDS } from '../../features/provisioning/logic/resourceDrift';

/**
 * The drift report as the browser receives it.
 *
 * A separate module for the same reason `publishedBody.ts` is one: the wire shape is a
 * contract two codebases are written against, and burying it in a route handler makes
 * it something you have to read a request to discover. Schemas, as in `flowBody.ts`: the
 * route declares them and the dashboard SDK is generated from them, and the builder below
 * is typed by `z.infer`.
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
 *
 * A drift's `kind` is the engine's own vocabulary (`RESOURCE_DRIFT_KINDS`), so the browser
 * branches on it with the compiler's help. A resource's `kind` stays a plain string, as
 * `PublishedResource.kind` does: the browser only looks it up for an icon.
 */

/** One way a resource differs, paired with the sentence describing it. */
const DriftDetailSchema = z
    .object({
        kind: z.enum(RESOURCE_DRIFT_KINDS),
        /** Server-authored prose. Markdown with `**bold**` segments. */
        explanation: z.string(),
    })
    .openapi('DriftDetail');

/**
 * A resource that is still declared, still there, and no longer what it was.
 *
 * `drift` is a list rather than one explanation, because `describeDrift` describes a
 * single drift and a resource can hold several — a channel that was renamed *and* dragged
 * out of its category has two independent findings, and joining them into a paragraph
 * would lose the ability to show them as the separate things they are.
 *
 * `repairable` is whether repair may touch this resource at all, taken straight from the
 * engine's own `ResourceDriftReport.repairable` rather than re-derived from the kinds,
 * because the reasons it is false are not all visible there: `wrongType` is a drift kind,
 * but adoption is a property of the *binding*. A client inferring "repairable unless
 * wrongType" would offer a repair on an adopted resource and the server would then refuse
 * it — an offer that cannot be honoured is worse than none, because the operator has
 * already decided by the time they find out. A display hint only: `repairDrift`
 * re-derives the same fact from the database via `withAdoptionReasserted` and does not
 * trust what comes back over the wire.
 */
const DriftedResourceSchema = z
    .object({
        resourceKey: z.string(),
        name: z.string(),
        /** What the journey declares this to be, for the row's icon and noun. */
        kind: z.string(),
        drift: z.array(DriftDetailSchema),
        repairable: z.boolean(),
    })
    .openapi('DriftedResource');

/**
 * A resource the journey installed and no longer declares.
 *
 * `stillInGuild` and `neverSettled` come apart in the case that matters — a crash between
 * creating an object and settling its row leaves a never-settled record with a live object
 * behind it — so both travel rather than one being derived from the other. `bindingId` is
 * the only thing the forget route accepts.
 */
const OrphanedResourceSchema = z
    .object({
        bindingId: z.number(),
        resourceKey: z.string(),
        kind: z.string(),
        name: z.string(),
        stillInGuild: z.boolean(),
        neverSettled: z.boolean(),
        /** Server-authored prose. Markdown with `**bold**` segments. */
        explanation: z.string(),
    })
    .openapi('OrphanedResource');

/** A resource found, but whose permissions could not be compared, and why. */
const UncheckedResourceSchema = z
    .object({
        resourceKey: z.string(),
        name: z.string(),
        reason: z.string(),
    })
    .openapi('UncheckedResource');

/**
 * The answer to "is my server still what I asked for".
 *
 * Drift and orphans arrive together because they are one screen: they are different
 * questions, but an operator asking this one is owed both answers at once. `cleanKeys` is
 * carried so the dialog can say "checked 6, 2 drifted" rather than "2 drifted";
 * `unchecked` is a third state beside clean and drifted, and collapsing it into either is
 * a lie in the direction that costs most.
 */
export const JourneyDriftSchema = z
    .object({
        journeyKey: z.string(),
        drifted: z.array(DriftedResourceSchema),
        cleanKeys: z.array(z.string()).readonly(),
        unchecked: z.array(UncheckedResourceSchema),
        orphans: z.array(OrphanedResourceSchema),
    })
    .openapi('JourneyDrift', {
        description:
            'What a journey installed that no longer matches what it declares (`drifted`), what it ' +
            'checked and found matching (`cleanKeys`), what it could not compare (`unchecked`), and ' +
            'what it installed and no longer declares (`orphans`).',
    });

/** The wire shape of a drift report and its orphans. Fields are copied, never spread. */
export function driftBody(
    plan: JourneyDriftPlan,
    orphans: readonly OrphanedBinding[]
): z.infer<typeof JourneyDriftSchema> {
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
