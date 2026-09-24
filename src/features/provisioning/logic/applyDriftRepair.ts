import {
    ChannelType,
    PermissionsBitField,
    type Guild,
    type PermissionOverwriteOptions,
} from 'discord.js';
import { resourceBindingsRepo, type ResourceBindingsRepo } from '../data/resourceBindingsRepo';
import type { JourneyDriftPlan } from './journeyDriftPlan';
import type { ResourceDriftKind, ResourceDriftReport } from './resourceDrift';
import type { ResourceKind } from './resourceDeclaration';

/**
 * Put a drifted resource back to what its journey declared.
 *
 * ## The direction, and why there is only one
 *
 * Repair reconciles **the guild to the declaration** — rename it back, move it back,
 * reapply the overwrites. The other direction ("they renamed it deliberately, so
 * update the declaration") is deliberately not built. A declaration the guild can
 * silently edit is not a declaration, and the two directions want different
 * confirmations anyway: one says *undo this change*, the other says *this change is
 * now the spec*. Conflating them behind one button is how an operator accepts a
 * permission weakening by clicking the thing that sounded like a fix.
 *
 * ## What it will not repair
 *
 * **`wrongType` is never repaired automatically.** If the binding now resolves to a
 * voice channel where a category was declared, the fix is not a rename — it is a
 * re-bind or a recreate, and which of those is right depends on what the operator
 * meant. Refused with an explanation.
 *
 * **An adopted resource is never repaired without an explicit override.** Adoption is
 * the promise that we do not touch structure that predates us, and `buildUnpublishPlan`
 * already refuses to delete on that ground. Drift is still *detected* on an adopted
 * resource — a staff-only channel going public matters regardless of who made it — but
 * acting on it is the operator's call, not ours.
 */

/**
 * What became of one approved repair.
 *
 * Mirrors {@link UnpublishOutcome} rather than inventing a third vocabulary for the
 * same three things: it worked, we declined, or Discord said no.
 */
const REPAIR_OUTCOMES = ['repaired', 'refused', 'failed'] as const;
export type RepairOutcome = (typeof REPAIR_OUTCOMES)[number];

export interface RepairedResource {
    readonly resourceKey: string;
    readonly kind: ResourceKind;
    readonly name: string;
    readonly outcome: RepairOutcome;
    /** What was actually put back, for `repaired`. Empty when nothing needed doing. */
    readonly repaired?: readonly ResourceDriftKind['kind'][];
    /** Set for `refused` and `failed`: what to tell the operator. */
    readonly explanation?: string;
}

export interface ApplyDriftRepairResult {
    readonly results: readonly RepairedResource[];
    /**
     * Why the whole run was refused before it started, if it was.
     *
     * Distinct from a per-item `failed` because it is the only outcome that guarantees
     * **nothing was touched**. Mirrors `ApplyUnpublishPlanResult.refusal`.
     */
    readonly refusal?: string;
}

export interface ApplyDriftRepairInput {
    readonly guild: Guild;
    readonly plan: JourneyDriftPlan;
    /**
     * The resource keys the operator actually approved.
     *
     * Per-key rather than "apply the whole plan", because a drift report is a list of
     * independent findings and an operator may well want the rename fixed and the
     * permissions left alone. A key absent from this set is simply not acted on — it
     * is not a refusal, because nothing was asked.
     */
    readonly approvedKeys: ReadonlySet<string>;
    /**
     * The overwrites to reapply per resource key, compiled by the caller.
     *
     * Passed in rather than recompiled here for the same reason the comparison takes
     * them: compiling needs a guild and a permission context this module has no business
     * holding. A key missing from this map whose drift includes `permissions` is
     * refused rather than guessed at.
     */
    readonly compiledOverwrites?: ReadonlyMap<string, readonly PermissionOverwriteWrite[]>;
    /** Overridable for tests; production uses the module singleton. */
    readonly repo?: Pick<ResourceBindingsRepo, 'renameBinding'>;
    /** Shown in the Discord audit log against every change. */
    readonly reason?: string;
}

/** One overwrite as `compilePermissionIntents` produces it. */
export interface PermissionOverwriteWrite {
    readonly id: string;
    readonly allow: readonly bigint[];
    readonly deny: readonly bigint[];
}

/**
 * One compiled overwrite as `permissionOverwrites.edit` wants it.
 *
 * The two `discord.js` entry points disagree about vocabulary, and the difference is
 * what forces this: `set` takes bit arrays (which is why `applyInstallPlan` can hand
 * the compiler's output straight to `channels.create`), while `edit` takes a map of
 * permission *names* to booleans. `PermissionsBitField.toArray()` does the translation
 * rather than a table here, because a hand-written table is one `discord.js` release
 * away from being silently wrong about a flag nobody tests.
 *
 * A flag absent from the map is left **untouched** — that is precisely what makes this
 * an edit rather than a replacement, and it is the property the per-id choice above
 * depends on.
 */
function toOverwriteOptions(overwrite: PermissionOverwriteWrite): PermissionOverwriteOptions {
    const options: Record<string, boolean> = {};

    for (const name of new PermissionsBitField(overwrite.allow as bigint[]).toArray()) {
        options[name] = true;
    }
    for (const name of new PermissionsBitField(overwrite.deny as bigint[]).toArray()) {
        options[name] = false;
    }

    return options as PermissionOverwriteOptions;
}

/**
 * Carry out approved repairs.
 *
 * ## Per-item failures do not abort the run
 *
 * Same reasoning as `applyUnpublishPlan`: these are independent findings, and a rename
 * that fails must not strand a permission fix that would have succeeded. Unlike
 * install, nothing here depends on anything earlier.
 *
 * ## Every repair re-checks before it acts
 *
 * A plan is reviewed by a human and confirmation takes time. `applyUnpublishPlan`
 * re-runs `survivorsOf` immediately before each category delete for exactly this
 * reason, and the hazard is the same here with a gentler consequence: an operator who
 * fixed the rename by hand while reading the report must not have it "repaired" to the
 * value it already holds, and — more importantly — a resource somebody has since
 * deleted must not be renamed into existence or reported as fixed.
 */
export async function applyDriftRepair(
    input: ApplyDriftRepairInput
): Promise<ApplyDriftRepairResult> {
    const { guild, plan, approvedKeys } = input;
    const repo = input.repo ?? resourceBindingsRepo;
    const reason = input.reason ?? `Repaired drift in journey "${plan.journeyKey}"`;

    if (plan.guildId !== guild.id) {
        return {
            results: [],
            refusal: `This drift report was built for guild ${plan.guildId} but is being applied to ${guild.id}. Refusing to change anything.`,
        };
    }

    const results: RepairedResource[] = [];

    for (const report of plan.drifted) {
        if (!approvedKeys.has(report.resourceKey)) continue;

        const refusal = refuseReason(report);
        if (refusal) {
            results.push({ ...describe(report), outcome: 'refused', explanation: refusal });
            continue;
        }

        try {
            const repaired = await repairOne({ guild, report, input, reason, repo });
            results.push({ ...describe(report), outcome: 'repaired', repaired });
        } catch (error) {
            results.push({
                ...describe(report),
                outcome: 'failed',
                explanation:
                    error instanceof Error
                        ? error.message
                        : `Discord refused the change to **${report.name}**.`,
            });
        }
    }

    return { results };
}

function describe(report: ResourceDriftReport): Pick<
    RepairedResource,
    'resourceKey' | 'kind' | 'name'
> {
    return { resourceKey: report.resourceKey, kind: report.kind, name: report.name };
}

/**
 * Why this resource will not be repaired, if it will not be.
 *
 * Both reasons are promises rather than limitations, which is why they are stated to
 * the operator rather than silently skipped.
 */
function refuseReason(report: ResourceDriftReport): string | undefined {
    if (!report.repairable) {
        return `**${report.name}** was adopted rather than created by this journey, so it is left exactly where it is. Change it yourself if the drift was not intended.`;
    }

    const wrongType = report.drift.find((entry) => entry.kind === 'wrongType');
    if (wrongType) {
        return `This binding no longer points at a ${report.kind}. That cannot be repaired automatically — re-bind the resource to the right object, or remove it and install again.`;
    }

    return undefined;
}

interface RepairOneInput {
    readonly guild: Guild;
    readonly report: ResourceDriftReport;
    readonly input: ApplyDriftRepairInput;
    readonly reason: string;
    readonly repo: Pick<ResourceBindingsRepo, 'renameBinding'>;
}

/**
 * Apply every approved drift on one resource, returning what was actually put back.
 *
 * Returns the kinds *repaired* rather than the kinds *found*, because they come apart
 * whenever the operator fixed something by hand between the preview and the confirm.
 * Reporting the found set there would claim credit for work somebody else did — the
 * same distinction `applyUnpublishPlan` draws with its `deletedHere` flag, and for the
 * same reason: this report is the only evidence the operator gets.
 */
async function repairOne(context: RepairOneInput): Promise<ResourceDriftKind['kind'][]> {
    const { guild, report, input, reason } = context;
    const repaired: ResourceDriftKind['kind'][] = [];

    for (const drift of report.drift) {
        switch (drift.kind) {
            case 'renamed': {
                const channel = guild.channels.cache.get(report.discordId);
                const role = guild.roles.cache.get(report.discordId);

                // Re-checked rather than trusted. If it already holds the declared
                // name the operator fixed it by hand, and renaming it again is a
                // no-op that would report as work done.
                if (channel && channel.name !== drift.declared) {
                    await channel.setName(drift.declared, reason);
                    repaired.push('renamed');
                } else if (role && role.name !== drift.declared) {
                    await role.setName(drift.declared, reason);
                    repaired.push('renamed');
                }
                break;
            }

            case 'reparented': {
                const channel = guild.channels.cache.get(report.discordId);

                // Only a text channel is ever declared with a parent, and only those
                // carry `setParent`. Narrowed on the type rather than asserted, so a
                // binding pointing at something else lands in the no-op below instead
                // of throwing inside a repair the operator was told would work.
                if (
                    channel?.type === ChannelType.GuildText &&
                    channel.parentId !== drift.declaredParentId
                ) {
                    /*
                     * `lockPermissions: false` is the load-bearing half.
                     *
                     * Discord's default on a move is to *sync* the channel's overwrites
                     * to its new category, which would silently overwrite the very
                     * permission model this feature exists to protect — repairing a
                     * move by destroying the access rules is worse than the drift.
                     */
                    await channel.setParent(drift.declaredParentId, {
                        lockPermissions: false,
                        reason,
                    });
                    repaired.push('reparented');
                }
                break;
            }

            case 'permissions': {
                const overwrites = input.compiledOverwrites?.get(report.resourceKey);
                if (!overwrites) {
                    // Refused rather than guessed. Writing a permission model this
                    // module inferred would be the one failure worse than the drift.
                    throw new Error(
                        `No compiled permission model was supplied for "${report.resourceKey}", so its overwrites cannot be repaired without guessing at them.`
                    );
                }

                const channel = guild.channels.cache.get(report.discordId);
                if (channel && 'permissionOverwrites' in channel) {
                    /*
                     * Edited per id, never `set`.
                     *
                     * `permissionOverwrites.set` replaces the whole list, deleting
                     * every overwrite not in it — which is the exact inverse of the
                     * comparison's rule that an id the declaration never mentioned is
                     * not drift. A repair using `set` would *perform* the removal that
                     * the detection deliberately declines to even report, so an
                     * operator fixing a rename would silently revoke a colleague's
                     * hand-added access. The two halves have to agree about what the
                     * declaration governs, and it governs only the ids it names.
                     *
                     * `edit` takes the same `allow`/`deny` bit arrays that
                     * `compilePermissionIntents` produces and that `applyInstallPlan`
                     * hands to `channels.create`, so repair writes the identical model
                     * install would have written.
                     */
                    for (const overwrite of overwrites) {
                        await channel.permissionOverwrites.edit(
                            overwrite.id,
                            toOverwriteOptions(overwrite),
                            { reason }
                        );
                    }
                    repaired.push('permissions');
                }
                break;
            }

            case 'wrongType':
                // Unreachable: refused before this function is called. The arm exists
                // so a new drift kind cannot be added without deciding what repairing
                // it means.
                break;
        }
    }

    // The binding's cached name is diagnostics-only, but a stale one makes every later
    // report describe the resource by a name nobody uses. Updated last, so a failed
    // guild write never leaves the row claiming a change that did not happen.
    if (repaired.includes('renamed')) {
        const renamed = report.drift.find((entry) => entry.kind === 'renamed');
        if (renamed?.kind === 'renamed') {
            await context.repo.renameBinding({
                discordId: report.discordId,
                name: renamed.declared,
            });
        }
    }

    return repaired;
}

