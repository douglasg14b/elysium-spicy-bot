import type { Guild } from 'discord.js';
import { resourceBindingsRepo, type ResourceBindingsRepo } from '../data/resourceBindingsRepo';
import { existsInGuildAs } from './installPlan';
import type { ResourceKind } from './resourceDeclaration';
import { survivorsOf, type UnpublishItem, type UnpublishPlan } from './unpublishPlan';

/**
 * What became of one item once the plan was carried out.
 *
 * `refused` is carried through from the plan unchanged — it is not a failure and the
 * operator was already shown why. `failed` is the new outcome: the delete was
 * attempted and Discord said no.
 */
const UNPUBLISH_OUTCOMES = ['deleted', 'forgotten', 'refused', 'failed'] as const;
export type UnpublishOutcome = (typeof UNPUBLISH_OUTCOMES)[number];

export interface UnpublishedResource {
    readonly resourceKey: string;
    readonly kind: ResourceKind;
    readonly name: string;
    readonly outcome: UnpublishOutcome;
    /** Set for `refused` and `failed`: what to tell the operator. */
    readonly explanation?: string;
}

export interface ApplyUnpublishPlanResult {
    readonly results: readonly UnpublishedResource[];
    /**
     * Why the whole run was refused before it started, if it was.
     *
     * Distinct from a per-item `failed` because it is not about any one resource, and
     * because it is the only outcome that guarantees **nothing was touched**. Mirrors
     * `InstallPlan.blockers`, which separates guild-level problems from item ones for
     * the same reason.
     */
    readonly refusal?: string;
}

export interface ApplyUnpublishPlanInput {
    readonly guild: Guild;
    readonly plan: UnpublishPlan;
    /** Overridable for tests; production uses the module singleton. */
    readonly repo?: Pick<ResourceBindingsRepo, 'forget'>;
    /** Shown in the Discord audit log against every deletion. */
    readonly reason?: string;
}

/**
 * Carry out an approved unpublish plan.
 *
 * ## The ordering, which looks arbitrary and is not
 *
 * **Delete the Discord object first, then remove the binding row.** This is the exact
 * mirror of install, which records intent *before* mutating, and it is chosen for the
 * same reason read backwards.
 *
 * A crash between the two steps leaves a binding pointing at an object that no longer
 * exists. That state is already handled: `buildInstallPlan` detects it and plans a
 * recreate, and `buildUnpublishPlan` treats it as a `forget`. It is recoverable from
 * either direction.
 *
 * The opposite order — drop the row, then delete the object — fails differently. A
 * crash in between leaves a live channel in the guild with **no record that we made
 * it**. Nothing can find it afterwards to finish the job, no future plan will mention
 * it, and the only recovery is a human noticing a stray channel and guessing. One
 * ordering loses a row that can be reconstructed; the other loses the knowledge that
 * the object was ever ours.
 *
 * ## Per-item failures do not abort the run
 *
 * Unlike `applyInstallPlan`, which stops at the first failure because a journey's
 * later resources depend on its earlier ones, unpublish reports and continues. The
 * dependency runs the other way here: a channel that could not be deleted does not
 * stop a *role* being deleted, and one blocked item must not strand the rest as live
 * objects with no obvious owner. The plan has already refused anything whose deletion
 * would cascade, so continuing cannot destroy a survivor.
 */
export async function applyUnpublishPlan(
    input: ApplyUnpublishPlanInput
): Promise<ApplyUnpublishPlanResult> {
    const { guild, plan } = input;
    const repo = input.repo ?? resourceBindingsRepo;
    const reason = input.reason ?? `Unpublished from journey "${plan.journeyKey}"`;

    const results: UnpublishedResource[] = [];
    /**
     * What this run has actually deleted so far.
     *
     * Feeds the apply-time cascade re-check below. Deliberately holds what *was*
     * deleted rather than what the plan *intended* to delete: a channel whose deletion
     * failed is still in its category, and counting it as gone would let the category
     * delete cascade onto it.
     */
    const deletedIds = new Set<string>();

    for (const item of plan.items) {
        const base = {
            resourceKey: item.resourceKey,
            kind: item.kind,
            name: item.name,
        } as const;

        if (item.action === 'refuse') {
            results.push({ ...base, outcome: 'refused', explanation: item.explanation });
            continue;
        }

        /*
         * Whether *this run* removed something from the guild.
         *
         * Tracked rather than inferred from `item.action`, because the plan says what
         * we meant to do and this says what happened. They come apart whenever the
         * object went away between previewing and confirming: the item is still a
         * `delete`, nothing was deleted, and reporting "deleted" there would claim
         * credit for someone else's cleanup on the one operation where the report is
         * the only evidence the operator gets.
         */
        let deletedHere = false;

        // Re-read the guild rather than trusting the plan. A plan is reviewed by a
        // human and confirmation takes time; the channel can be deleted by hand in
        // between, and that is a `forget`, not a failure — the desired state holds.
        //
        // This mirrors `requireAdoptable` on the install side, which re-checks an
        // adoption for the same reason.
        const stillThere =
            item.action === 'delete' &&
            !!item.discordId &&
            existsInGuildAs(guild, item.kind, item.discordId);

        if (stillThere && item.discordId) {
            /*
             * Re-check the cascade **here**, not only in the plan.
             *
             * Existence was already re-read above because the window between planning
             * and confirming is real. Containment moves through that same window and is
             * far easier to change: dragging a channel into a category takes a second,
             * and the ordering means categories are deleted last, so they sit at the
             * widest point of it.
             *
             * Checking only at plan time would leave the one guard whose failure is
             * unrecoverable open for exactly as long as the operator spends reading.
             */
            if (item.kind === 'category') {
                const survivors = survivorsOf(guild, item.discordId, deletedIds);
                if (survivors.length > 0) {
                    results.push({
                        ...base,
                        outcome: 'refused',
                        explanation: `**${item.name}** was not deleted: since this was planned, it has come to contain ${survivors.map((survivor) => `**${survivor}**`).join(', ')}, and deleting the category would take ${survivors.length === 1 ? 'it' : 'them'} too.`,
                    });
                    continue;
                }
            }

            const failure = await deleteFromGuild(guild, item.kind, item.discordId, reason);
            if (failure) {
                // The guild still holds the object, so the row must stay. Removing it
                // here is precisely the orphan this function's ordering exists to
                // avoid.
                results.push({ ...base, outcome: 'failed', explanation: failure });
                continue;
            }

            deletedIds.add(item.discordId);
            deletedHere = true;
        }

        // Either the object was just deleted, or there was never one to delete. The
        // row goes last in both cases.
        await forgetRow(repo, item, results, base, deletedHere);
    }

    return { results };
}

/**
 * Drop the binding row and record what happened.
 *
 * A failure here is reported rather than thrown: the guild object is already gone, so
 * the destructive half of the operation has succeeded and cannot be undone. Reporting
 * `failed` with the row still present is the honest state — the next unpublish sees a
 * binding pointing at nothing and plans a `forget`, which converges.
 */
async function forgetRow(
    repo: Pick<ResourceBindingsRepo, 'forget'>,
    item: UnpublishItem,
    results: UnpublishedResource[],
    base: { resourceKey: string; kind: ResourceKind; name: string },
    deletedHere: boolean
): Promise<void> {
    try {
        await repo.forget(item.bindingId);
        results.push({
            ...base,
            outcome: deletedHere ? 'deleted' : 'forgotten',
            explanation: item.action === 'forget' ? item.explanation : undefined,
        });
    } catch (error) {
        results.push({
            ...base,
            outcome: 'failed',
            explanation: `The ${item.kind === 'role' ? 'role' : 'channel'} was removed from the server, but its record could not be deleted: ${describeError(error)}. Run this again to clear the leftover record.`,
        });
    }
}

/**
 * Delete one guild object, returning the problem rather than throwing.
 *
 * `undefined` means it is gone. A caught error is returned as text because the caller
 * has to keep going through the rest of the plan, and an exception escaping one item
 * would abandon every item after it.
 */
async function deleteFromGuild(
    guild: Guild,
    kind: ResourceKind,
    discordId: string,
    reason: string
): Promise<string | undefined> {
    try {
        if (kind === 'role') {
            const role = guild.roles.cache.get(discordId);
            if (!role) return undefined;
            await role.delete(reason);
            return undefined;
        }

        const channel = guild.channels.cache.get(discordId);
        if (!channel) return undefined;
        await channel.delete(reason);
        return undefined;
    } catch (error) {
        // A delete that raced a manual one is a success: the object is gone, which is
        // the whole objective. Reporting it as a failure would keep the binding row and
        // tell the operator something broke that did not — and the run would not
        // converge, because the next attempt hits the same race.
        if (isAlreadyGone(error)) {
            return undefined;
        }
        if (isPermissionProblem(error)) {
            return `Discord would not allow it — check the bot's permissions on that ${kind === 'role' ? 'role' : 'channel'}: ${describeError(error)}`;
        }
        return `Discord refused to delete it: ${describeError(error)}`;
    }
}

/** Discord's numeric API error code, when the thrown value carries one. */
function errorCode(error: unknown): number | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code: unknown }).code;
        return typeof code === 'number' ? code : undefined;
    }
    return undefined;
}

/**
 * "It is not there", by code rather than by message text.
 *
 * 10003 `Unknown Channel`, 10004 `Unknown Guild`, 10011 `Unknown Role`. Matched
 * numerically so a reworded message cannot turn this into a failure, and so a genuine
 * permission error is never mistaken for a tidy-up. Mirrors `isUnknownMessage` in
 * `undeployFlowButtons.ts`, which does the same job for 10008.
 */
function isAlreadyGone(error: unknown): boolean {
    const code = errorCode(error);
    return code === 10003 || code === 10004 || code === 10011;
}

/** 50013 `Missing Permissions`, 50001 `Missing Access`. Named so the advice is useful. */
function isPermissionProblem(error: unknown): boolean {
    const code = errorCode(error);
    return code === 50013 || code === 50001;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
