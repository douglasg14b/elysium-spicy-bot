/**
 * Turning a drift report into what the dialog says, with no JSX anywhere in it.
 *
 * The same split `publishedSummary.ts` and `installSummary.ts` take, for the same
 * reason: `web/` runs without jsdom, so any decision left inside a component is a
 * decision no test can reach. Everything here is a pure function over the wire shape.
 */

import type { DriftedResource, JourneyDrift, OrphanedResource, RepairedResource } from '../api/types';

/**
 * The headline, which is the only line most operators will read.
 *
 * States the **denominator**. "2 drifted" makes an operator wonder what else was
 * looked at; "2 of 7 checked" is an answer. This is the same reason `cleanKeys` is
 * carried over the wire at all rather than being a number the server throws away.
 */
export function driftHeadline(drift: JourneyDrift): string {
    const checked = drift.drifted.length + drift.cleanKeys.length + drift.unchecked.length;

    if (checked === 0 && drift.orphans.length === 0) {
        return 'Nothing installed to check yet.';
    }

    if (drift.drifted.length === 0) {
        return checked === 1
            ? 'The one thing this journey installed is still exactly as declared.'
            : `All ${checked} things this journey installed are still exactly as declared.`;
    }

    return drift.drifted.length === 1
        ? `1 of ${checked} no longer matches what this journey declares.`
        : `${drift.drifted.length} of ${checked} no longer match what this journey declares.`;
}

/**
 * Whether the dialog has anything worth an operator's attention.
 *
 * Unchecked resources count. A staff-only channel whose permissions could not be
 * compared is not a clean result, and reporting the journey as healthy while one sits
 * there unexamined is the false-clean the whole feature exists to prevent.
 */
export function hasFindings(drift: JourneyDrift): boolean {
    return (
        drift.drifted.length > 0 || drift.orphans.length > 0 || drift.unchecked.length > 0
    );
}

/**
 * The keys a repair should start with selected.
 *
 * Everything repairable, because that is what an operator pressing a repair button
 * means — reconcile the server to the declaration. The unrepairable ones are still
 * shown and still explained; they are simply not offered, since an offer that cannot
 * be honoured is worse than none.
 */
export function repairableKeys(drift: JourneyDrift): string[] {
    return drift.drifted.filter((resource) => resource.repairable).map((res) => res.resourceKey);
}

/** Whether anything here can actually be repaired, which gates the button entirely. */
export function hasRepairable(drift: JourneyDrift): boolean {
    return drift.drifted.some((resource) => resource.repairable);
}

/**
 * Why a drifted resource is shown but not offered a repair.
 *
 * Two reasons and they are genuinely different, so they get different sentences: an
 * adopted resource is one we promised never to touch, and a wrong-type binding needs a
 * decision only an operator can take. Collapsing them into "cannot be repaired" would
 * hide that the first is a promise being kept and the second is a job to do.
 *
 * Returns null when the resource *is* repairable, so a caller can render nothing.
 *
 * ## Why the reason is derived here and the decision is not
 *
 * `repairable` comes from the server and is never inferred — a client guessing it would
 * offer a repair the server refuses. This function only picks the *sentence* for a
 * decision already made, which is a weaker claim, and it is deliberately arranged so
 * that being wrong is survivable: the `wrongType` branch is the one visible in the
 * drift kinds, and everything else falls through to adoption, which is the more
 * conservative thing to tell an operator.
 *
 * **If a third reason for withholding a repair ever appears, move this to the server**
 * as a `withheldReason` beside `repairable`. It was not moved now because the wire cost
 * — a field, two `*_KEYS` entries and a gate row — buys nothing while there are two
 * reasons and one of them is structurally visible.
 */
export function whyNotRepairable(resource: DriftedResource): string | null {
    if (resource.repairable) return null;

    if (resource.drift.some((detail) => detail.kind === 'wrongType')) {
        return 'Left alone — this points at something of the wrong type now, which needs you to decide what it should be.';
    }

    return 'Left alone — this was adopted rather than created here, so it is never modified.';
}

/** The label for the repair button, which names what it will touch. */
export function repairLabel(selectedCount: number): string {
    return selectedCount === 1 ? 'Repair 1 resource' : `Repair ${selectedCount} resources`;
}

export interface RepairReport {
    readonly color: 'brand' | 'orange' | 'red';
    readonly title: string;
    readonly message: string;
}

/**
 * What to tell an operator after a repair, from the per-item results.
 *
 * A partial run is the interesting case and the one this exists for. `partiallyRepaired`
 * means a resource had several drifts and a later one threw after an earlier one had
 * already been written — so the honest report is neither "done" nor "failed", and the
 * first explanation is named rather than counted.
 */
export function summariseRepair(results: readonly RepairedResource[]): RepairReport {
    const repaired = results.filter((result) => result.outcome === 'repaired');
    /*
     * Partiality is carried by `repaired`, not by an outcome of its own.
     *
     * The engine's vocabulary is three values. When a repair throws after an earlier
     * drift on the same resource has already been written, `applyDriftRepair` emits
     * `failed` *with* the landed kinds in `repaired` — so that array is the
     * discriminator, and reading the outcome alone loses the distinction entirely.
     */
    const isPartial = (result: RepairedResource): boolean =>
        result.outcome === 'failed' && (result.repaired?.length ?? 0) > 0;

    const partial = results.filter(isPartial);
    const failed = results.filter((result) => result.outcome === 'failed' && !isPartial(result));
    const refused = results.filter((result) => result.outcome === 'refused');

    if (results.length === 0) {
        return {
            color: 'orange',
            title: 'Nothing to do',
            // Not an error: a rebuild found the drift already resolved, which is what
            // happens when an operator fixed it by hand while reading the report.
            message: 'Nothing was changed — the drift had already been resolved.',
        };
    }

    if (failed.length === 0 && partial.length === 0 && refused.length === 0) {
        const count = repaired.length;
        return {
            color: 'brand',
            title: 'Back in line',
            message: `${count} resource${count === 1 ? '' : 's'} put back to what the journey declares.`,
        };
    }

    const stuck = [...partial, ...failed, ...refused];
    const firstReason = stuck[0]?.explanation ?? 'Discord said no.';
    // A partially repaired resource counts as done: something really was put back, and
    // saying otherwise is wrong about a change the operator can see in their server.
    const done = repaired.length + partial.length;

    return {
        color: failed.length > 0 || partial.length > 0 ? 'orange' : 'brand',
        title: partial.length > 0 ? 'Partly repaired' : 'Some left alone',
        message: `${done} repaired, ${stuck.length} not: ${firstReason}`,
    };
}

/**
 * What to tell an operator after forgetting a leftover record.
 *
 * The live-object case gets its own sentence rather than being rounded to the tidier
 * one. Dropping a record behind an object that is still there means something remains
 * in their server that nothing will mention again, and that is precisely when they may
 * want to go and look at it.
 */
export function summariseForget(orphan: {
    readonly name: string;
    readonly objectRemains: boolean;
}): RepairReport {
    return {
        color: 'brand',
        title: 'Record removed',
        message: orphan.objectRemains
            ? `Stopped tracking “${orphan.name}”. It is still in your server — nothing will manage it from now on.`
            : `Stopped tracking “${orphan.name}”. Nothing was left behind.`,
    };
}

/**
 * The orphans an operator can act on here, and the ones that are merely reported.
 *
 * Every orphan can be forgotten — the row is ours either way. The split exists because
 * a never-settled row with a live object behind it is the one case where forgetting
 * genuinely loses information, so it is worth separating for a warning rather than
 * being listed beside the routine ones.
 */
export function riskyOrphans(orphans: readonly OrphanedResource[]): OrphanedResource[] {
    return orphans.filter((orphan) => orphan.neverSettled && orphan.stillInGuild);
}
