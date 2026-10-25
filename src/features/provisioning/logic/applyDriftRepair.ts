import {
    ChannelType,
    PermissionsBitField,
    type Guild,
    type PermissionOverwriteOptions,
} from 'discord.js';
import { resourceBindingsRepo, type ResourceBindingsRepo } from '../data/resourceBindingsRepo';
import { journeyOwner } from '../data/resourceBindingsSchema';
import { describeOtherHolder, type GuildOwnership } from './bindingOwner';
import {
    DISCORD_UNKNOWN_CHANNEL,
    DISCORD_UNKNOWN_MESSAGE,
    describeDiscordError,
    discordErrorCode,
} from './discordErrors';
import type { JourneyDriftPlan } from './journeyDriftPlan';
import { lookupMessageChannel } from './lookupBoundMessage';
import type { MessageEditPreparation } from './prepareMessageEdit';
import { describeWithheldRepair, type ResourceDriftKind, type ResourceDriftReport } from './resourceDrift';
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
 *
 * ## A message is edited, never reposted
 *
 * An `outOfDate` message is brought up to its declaration by one edit of the same message,
 * so it keeps its id and its place in the channel (`prepareMessageEdit` builds it). One
 * deleted since the check is reported, not posted again: posting is install's.
 */

/**
 * What became of one approved repair.
 *
 * Mirrors {@link UnpublishOutcome} rather than inventing a third vocabulary for the
 * same three things: it worked, we declined, or Discord said no.
 */
/** Exported for the wire-shape drift gate, which compares it against the browser's copy. */
export const REPAIR_OUTCOMES = ['repaired', 'refused', 'failed'] as const;
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
    /**
     * Each approved out-of-date message's edit, prepared by the caller, by resource key — or
     * why it is refused.
     *
     * Prepared outside for the reason the overwrites are: it reads the declaration and the
     * guild's uploads, which this module does not hold. A key whose drift is `outOfDate` and
     * that is missing here, or prepared as refused, is refused with nothing touched.
     */
    readonly messageEdits?: ReadonlyMap<string, MessageEditPreparation>;
    /** Overridable for tests; production uses the module singleton. */
    readonly repo?: Pick<ResourceBindingsRepo, 'renameBinding' | 'recordMessageDigest'>;
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

        const refusal = refuseReason(report, input);
        if (refusal) {
            results.push({ ...describe(report), outcome: 'refused', explanation: refusal });
            continue;
        }

        try {
            const { repaired, notes } = await repairOne({ guild, report, input, reason, repo });
            results.push({
                ...describe(report),
                outcome: 'repaired',
                repaired,
                ...(notes.length > 0 ? { explanation: notes.join(' ') } : {}),
            });
        } catch (error) {
            /*
             * A throw mid-repair means the *remaining* drifts were not applied — but
             * anything already written to the guild stays written, and saying nothing
             * about it is the worse failure.
             *
             * So a partial repair is **`failed` carrying a populated `repaired`**, and
             * that array is the only thing distinguishing it from a repair that changed
             * nothing. There is deliberately no fourth outcome: `REPAIR_OUTCOMES`
             * mirrors `UnpublishOutcome` rather than inventing a vocabulary, and the
             * run really did fail — it just failed after doing something.
             *
             * **A reader who takes this as four outcomes gets it wrong**, and one
             * already did: the browser's mirror grew a `partiallyRepaired` member from
             * an earlier draft of this comment, so every partial repair was reported to
             * the operator as a flat failure — the exact misreport the paragraph above
             * exists to prevent. Any consumer must branch on `repaired`, not on a name.
             */
            const partial = error instanceof PartialRepairError ? error.repaired : [];
            // Only a `PartialRepairError`'s message is this module's own wording; anything
            // else is an internal failure whose text must not reach the report.
            if (!(error instanceof PartialRepairError)) {
                console.error(`[provisioning] Repairing ${report.resourceKey} failed:`, error);
            }
            results.push({
                ...describe(report),
                outcome: 'failed',
                ...(partial.length > 0 ? { repaired: partial } : {}),
                explanation:
                    error instanceof PartialRepairError
                        ? error.message
                        : `Something went wrong repairing **${report.name}**, and it was not finished. Try again in a moment.`,
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
 * Re-assert the adoption promise against the rows that actually record provenance.
 *
 * A plan's `repairable` flag is only as trustworthy as whoever handed the plan over.
 * Today that is this process; the moment a route exists it is a client, and
 * `repairable: true` on an adopted resource becomes a *claim* rather than a fact. The
 * promise it guards — we never touch structure that predates us — is the strongest one
 * in this feature and the only one whose breach destroys something the operator did
 * not put under our control.
 *
 * So the flag is recomputed from the bindings rather than trusted. It can only ever
 * take `repairable` **away**, never grant it: a resource this returns as repairable was
 * already repairable in the plan.
 *
 * Pure and separate from the service call that fetches the rows, so the rule itself is
 * testable without a database.
 */
export function withAdoptionReasserted(
    plan: JourneyDriftPlan,
    bindings: readonly { readonly resourceKey: string; readonly state: string }[]
): JourneyDriftPlan {
    const adoptedKeys = new Set(
        bindings
            .filter((binding) => binding.state === 'adopted')
            .map((binding) => binding.resourceKey)
    );

    return {
        ...plan,
        drifted: plan.drifted.map((report) =>
            adoptedKeys.has(report.resourceKey) ? { ...report, repairable: false } : report
        ),
    };
}

/**
 * Re-assert sharing the same way: a report whose object another owner holds is not
 * repairable, whatever the plan says.
 *
 * The sharing promise is the adoption promise made to another owner, so it gets the same
 * treatment — recomputed from the guild's rows rather than trusted from a plan that
 * travelled. Like {@link withAdoptionReasserted}, it can only take `repairable` away.
 */
export function withSharingReasserted(plan: JourneyDriftPlan, ownership: GuildOwnership): JourneyDriftPlan {
    const self = journeyOwner(plan.journeyKey);
    return {
        ...plan,
        drifted: plan.drifted.map((report) => {
            const sharedWith = describeOtherHolder(ownership, report.discordId, self);
            return sharedWith ? { ...report, repairable: false, sharedWith } : report;
        }),
    };
}

/**
 * Why this resource will not be repaired, if it will not be.
 *
 * Both reasons are promises rather than limitations, which is why they are stated to
 * the operator rather than silently skipped. A third, sharing, keeps the same promise to
 * another owner: an object it also holds is not reshaped to this journey's declaration.
 */
function refuseReason(
    report: ResourceDriftReport,
    input: ApplyDriftRepairInput
): string | undefined {
    // Withheld repairs — shared, or adopted (with or without a wrong type) — say what the
    // preview said, from the one function that words and orders them, so the dialog and
    // the repair result cannot disagree about why something was left alone.
    const withheld = describeWithheldRepair(report);
    if (withheld) return `**${report.name}**: ${withheld}`;

    const wrongType = report.drift.find((entry) => entry.kind === 'wrongType');
    if (wrongType) {
        return `This binding no longer points at a ${report.kind}. That cannot be repaired automatically — re-bind the resource to the right object, or remove it and install again.`;
    }

    /*
     * A permission repair with no compiled model is a **refusal**, not a failure, and
     * the distinction is the one this whole vocabulary rests on: `refused` means a
     * promise we chose to keep, `failed` means Discord said no. Guessing at a
     * permission model is the one outcome worse than the drift, so declining to is a
     * choice — and calling it `failed` would read to an operator as transient, worth
     * retrying, when it will never succeed.
     *
     * Checked here rather than thrown from inside the loop so the whole item is
     * refused with **nothing touched**, instead of a rename landing first and then
     * being reported as a total failure.
     */
    const needsPermissions = report.drift.some((entry) => entry.kind === 'permissions');
    if (needsPermissions && !input.compiledOverwrites?.get(report.resourceKey)) {
        return `The permission model for **${report.name}** could not be compiled, so its overwrites cannot be repaired without guessing at them. Nothing was changed.`;
    }

    /*
     * A resource whose permissions were never *checked* must not have them rewritten.
     *
     * `unchecked` exists so a resource is never falsely certified as clean. Repairing
     * permissions the operator was explicitly told went unexamined would defeat that
     * from the apply side — they approved a report that said "not checked", and a write
     * would be acting on a comparison that never happened.
     */
    const uncheckedHere = input.plan.unchecked.find(
        (entry) => entry.resourceKey === report.resourceKey
    );
    if (needsPermissions && uncheckedHere) {
        return `**${report.name}**'s permissions were not checked, so they are not repaired. ${uncheckedHere.reason}`;
    }

    // An out-of-date message whose edit could not be prepared — a declaration Discord would
    // refuse, an upload gone — is refused whole, before its edit is sent.
    if (report.drift.some((entry) => entry.kind === 'outOfDate')) {
        const prepared = input.messageEdits?.get(report.resourceKey);
        if (!prepared) {
            return `**${report.name}**'s edit was not prepared, so it is not repaired. Nothing was changed.`;
        }
        if (prepared.status === 'refused') return prepared.refusal;
    }

    return undefined;
}

/**
 * A repair that failed partway, carrying what had already landed.
 *
 * Exists so the catch can report a rename that succeeded before a later drift threw.
 * Without it a partially-applied repair reports as a total failure, and the operator —
 * whose only evidence is this report — is told nothing happened to a channel that has
 * in fact been renamed.
 */
class PartialRepairError extends Error {
    constructor(
        message: string,
        readonly repaired: readonly ResourceDriftKind['kind'][]
    ) {
        super(message);
        this.name = 'PartialRepairError';
    }
}

interface RepairOneResult {
    /** What actually changed in the guild, not what was found. */
    readonly repaired: readonly ResourceDriftKind['kind'][];
    /**
     * Things worth telling the operator that are not failures.
     *
     * A successful repair whose bookkeeping could not be completed is still a
     * successful repair, but silence about it would make the report claim more than
     * happened.
     */
    readonly notes: readonly string[];
}

interface RepairOneInput {
    readonly guild: Guild;
    readonly report: ResourceDriftReport;
    readonly input: ApplyDriftRepairInput;
    readonly reason: string;
    readonly repo: Pick<ResourceBindingsRepo, 'renameBinding' | 'recordMessageDigest'>;
}

/** A repaired message's answer when the message has gone since the check: install's to post again. */
export const MESSAGE_DELETED_SINCE_CHECK = 'It was deleted since the check — install posts it again.';

/**
 * Apply every approved drift on one resource, returning what was actually put back.
 *
 * Returns the kinds *repaired* rather than the kinds *found*, because they come apart
 * whenever the operator fixed something by hand between the preview and the confirm.
 * Reporting the found set there would claim credit for work somebody else did — the
 * same distinction `applyUnpublishPlan` draws with its `deletedHere` flag, and for the
 * same reason: this report is the only evidence the operator gets.
 */
async function repairOne(context: RepairOneInput): Promise<RepairOneResult> {
    const { guild, report, input, reason } = context;
    const repaired: ResourceDriftKind['kind'][] = [];
    const notes: string[] = [];

    for (const drift of report.drift) {
        try {
            await applyOneDrift({ context, drift, repaired });
        } catch (error) {
            // Only Discord throws in here: its answer is worded by `describeDiscordError`,
            // which logs the whole of it, so the raw text never reaches the report — unless
            // the drift worded it itself, as a message deleted since the check does.
            const refusal =
                error instanceof PartialRepairError
                    ? error.message
                    : `Discord refused the change to **${report.name}**: ${describeDiscordError(error)}.`;

            /*
             * A rename that landed before a later drift failed is still recorded on the
             * row. Skipping it here used to leave the binding naming the old channel
             * forever: a created binding's drift compares against the declaration, so
             * once the guild holds the declared name the rename is never reported again
             * and nothing else ever corrects the row.
             */
            const renameNote = repaired.includes('renamed')
                ? await recordLandedRename(context)
                : undefined;

            // Carry what already landed out through the throw, so a rename that
            // succeeded before a later drift failed is still reported as done.
            throw new PartialRepairError(
                renameNote ? `${refusal} ${renameNote}` : refusal,
                repaired
            );
        }
    }

    if (repaired.includes('renamed')) {
        // Through `recordLandedRename`: the rename has landed, so a database failure here
        // is a note on a successful repair, not a failure of it.
        const note = await recordLandedRename(context);
        if (note) notes.push(note);
    }

    if (repaired.includes('outOfDate')) {
        // The edit has landed, so this too is a note at worst.
        const note = await recordRepairedDigest(context);
        if (note) notes.push(note);
    }

    return { repaired, notes };
}

interface ApplyOneDriftInput {
    readonly context: RepairOneInput;
    readonly drift: ResourceDriftKind;
    readonly repaired: ResourceDriftKind['kind'][];
}

/** One drift, applied. Pushes onto `repaired` only when the guild actually changed. */
async function applyOneDrift({ context, drift, repaired }: ApplyOneDriftInput): Promise<void> {
    const { guild, report, input, reason } = context;

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
                // Absence is refused up front by `refuseReason`, so reaching here with
                // no model would be a programming error rather than an operator one.
                const overwrites = input.compiledOverwrites?.get(report.resourceKey) ?? [];

                /*
                 * **Only the ids the report actually flagged.**
                 *
                 * `overwrites` is the whole compiled model; `drift.differences` is the
                 * subset that diverged. Writing the whole model would re-derive the
                 * repair's own target instead of acting on what the operator approved —
                 * the exact thing `ResourceDriftKind`'s doc comment forbids, and it has
                 * a real consequence: an id the comparison reported as *clean* (because
                 * a colleague loosened it deliberately, and extra grants are not drift)
                 * would be silently reset by a repair approved for something else.
                 */
                const driftedIds = new Set(drift.differences.map((entry) => entry.id));
                const toWrite = overwrites.filter((overwrite) => driftedIds.has(overwrite.id));

                const channel = guild.channels.cache.get(report.discordId);
                if (channel && 'permissionOverwrites' in channel && toWrite.length > 0) {
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
                    for (const overwrite of toWrite) {
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

            case 'outOfDate': {
                // Refused up front by `refuseReason` unless it was prepared.
                const prepared = input.messageEdits?.get(report.resourceKey);
                if (prepared?.status !== 'ready') break;

                /*
                 * No fetch first: the edit is the check, as uninstall's delete is. A message
                 * deleted since the check — or its channel — answers 10008 or 10003, which is
                 * install's to post again, not something to retry.
                 */
                const channel = await lookupMessageChannel(guild, prepared.channelId);
                if (channel.status === 'gone') throw new PartialRepairError(MESSAGE_DELETED_SINCE_CHECK, repaired);
                try {
                    await channel.channel.messages.edit(prepared.messageId, prepared.edit);
                } catch (error) {
                    const code = discordErrorCode(error);
                    if (code === DISCORD_UNKNOWN_MESSAGE || code === DISCORD_UNKNOWN_CHANNEL) {
                        throw new PartialRepairError(MESSAGE_DELETED_SINCE_CHECK, repaired);
                    }
                    throw error;
                }
                repaired.push('outOfDate');
                break;
            }

            default: {
                const unreachable: never = drift;
                throw new Error(`Unhandled drift kind: ${String(unreachable)}`);
            }
    }
}

/**
 * Record a rename that landed, on the way out of a repair that then failed.
 *
 * The Discord refusal is what the operator needs to see, so a database failure here is
 * folded into the message rather than thrown over it — reported, not swallowed.
 */
async function recordLandedRename(context: RepairOneInput): Promise<string | undefined> {
    try {
        return await syncRenamedBinding(context);
    } catch (error) {
        console.error(
            `[provisioning] Could not record the rename of binding ${context.report.bindingId}:`,
            error
        );
        return `The server was renamed, but **${context.report.name}**'s record could not be updated to match.`;
    }
}

/**
 * Record the fingerprint of what a repair just posted over a message, so the next check
 * reads it as current. Called only once the edit has landed.
 *
 * A failure is a note on a repair that worked, never a failure of it: the message says what
 * the journey declares, and only the record is behind — the next check calls it out of date
 * again, and repairing again is harmless. Guarded by the message id, so a row that moved on to
 * another post meanwhile is left alone.
 */
async function recordRepairedDigest(context: RepairOneInput): Promise<string | undefined> {
    const { report, input, repo } = context;
    const prepared = input.messageEdits?.get(report.resourceKey);
    if (prepared?.status !== 'ready') return undefined;

    try {
        const recorded = await repo.recordMessageDigest({
            id: prepared.bindingId,
            expectedDiscordId: prepared.messageId,
            digest: prepared.digest,
        });
        if (recorded) return undefined;
        return `**${report.name}** was updated, but its record had moved on — posted again meanwhile, most likely — so it was left as it stands.`;
    } catch (error) {
        console.error(`[provisioning] Could not record the repair of message binding ${prepared.bindingId}:`, error);
        return `**${report.name}** was updated, but its record could not be. The next check will call it out of date again; repairing again is harmless.`;
    }
}

/**
 * Refresh the binding's cached name after a successful rename.
 *
 * Called only once the guild write has landed, so the row never claims a change that
 * did not happen — including when a later drift on the same resource fails, which is
 * {@link recordLandedRename}'s job. Returns a note when the row would not take the
 * update.
 */
async function syncRenamedBinding(context: RepairOneInput): Promise<string | undefined> {
    const { report, repo } = context;
    const renamed = report.drift.find((entry) => entry.kind === 'renamed');
    if (renamed?.kind !== 'renamed') return undefined;

    const updated = await repo.renameBinding({
        id: report.bindingId,
        expectedDiscordId: report.discordId,
        name: renamed.declared,
    });

    if (updated) return undefined;

    /*
     * Reported, not swallowed. Zero rows back means the binding moved underneath the
     * repair — re-bound, or torn down, while the operator was reading. The guild write
     * already happened and is correct; what is stale is the expected name, which no
     * lookup uses and which self-heals on the next repair. So this is a note rather than
     * a failure — but discarding it would leave the operator's only evidence claiming a
     * clean repair while the row and the guild disagree.
     */
    return `The server was updated, but **${report.name}**'s record had already moved, so its cached name was left alone.`;
}

