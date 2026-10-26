import type { Guild } from 'discord.js';
import { uploadSizesFor } from '../../features-system/guild-uploads';
import { journeysRepo } from './data/journeysRepo';
import { resourceBindingsRepo } from './data/resourceBindingsRepo';
import type { ResourceBindingEntity } from './data/resourceBindingsSchema';
import { requireButtonListenerReader } from './buttonListeners';
import { requireTicketTypeProvider } from './ticketTypeProvider';
import { isJourneyBinding, type GuildOwnership } from './logic/bindingOwner';
import { applyInstallPlan, type ApplyInstallPlanResult } from './logic/applyInstallPlan';
import {
    applyUnpublishPlan,
    type ApplyUnpublishPlanResult,
} from './logic/applyUnpublishPlan';
import {
    buildInstallPlan,
    existsInGuildAs,
    type InstallPlan,
    type ResourceChoice,
} from './logic/installPlan';
import { findOrphanedBindings, type OrphanedBinding } from './logic/orphanedBindings';
import {
    buildJourneyDriftPlan,
    compileForComparison,
    resolveDeclaredRoles,
    type JourneyDriftPlan,
} from './logic/journeyDriftPlan';
import {
    applyDriftRepair,
    withAdoptionReasserted,
    withSharingReasserted,
    type ApplyDriftRepairResult,
    type PermissionOverwriteWrite,
} from './logic/applyDriftRepair';
import { buildUnpublishPlan, type UnpublishPlan } from './logic/unpublishPlan';
import { journeyBusyMessage, withJourneyLock } from './logic/journeyOperationLock';
import { isPostedMessageRow, readMessagePresence, readMessageState, type MessageState } from './logic/lookupBoundMessage';
import { prepareMessageEdit, type MessageEditPreparation } from './logic/prepareMessageEdit';
import {
    isDiscordResource,
    nonDiscordResourceKind,
    type JourneyDeclaration,
    type ResourceKind,
} from './logic/resourceDeclaration';

export interface PreviewInstallInput {
    readonly guild: Guild;
    readonly journey: JourneyDeclaration;
    readonly choices?: Readonly<Record<string, ResourceChoice>>;
    /** Who the journey is about, when a resource's permissions name a subject. */
    readonly subjectId?: string;
    readonly staffRoleIds: readonly string[];
}

/**
 * Build the plan an operator reviews. Reads only; mutates nothing.
 *
 * Takes the same permission inputs as the apply, so the preview compiles the exact
 * permission models the apply will. A preview that skipped that could show an
 * applicable plan for a journey that cannot actually be installed.
 */
export async function previewInstall(input: PreviewInstallInput): Promise<InstallPlan> {
    // One read serves all three: this journey's rows decide reuse, every row in the guild
    // fences crash recovery off objects another owner holds, and the same rows name the
    // owner when an adopt would take something already held.
    const { rows, ownership } = await readGuildBindings(input.guild.id);
    // Filtered on owner kind as well as key: a journey keyed `tickets` must not take the
    // ticket feature's category rows as its own. Every kind, ticket types included —
    // those decide reuse too, and only the ownership fences must not see them.
    const existingBindings = rows.filter((binding) => isJourneyBinding(binding, input.journey.journeyKey));
    const boundInGuild = new Set(
        ownership.bindings.flatMap((binding) => (binding.discordId ? [binding.discordId] : []))
    );

    // Read only when the journey declares one, so a journey that does not can install
    // without the ticket feature wired at all.
    const ticketTypes = input.journey.resources.some((resource) => resource.kind === 'ticketType')
        ? await requireTicketTypeProvider().read(input.guild.id)
        : undefined;

    // One fetch per message this journey has posted and still declares, and one read of the
    // sizes of every upload its messages show — none at all for a journey without messages.
    const messagePresence = (await readDeclaredMessageState(input.guild, input.journey, existingBindings)).presence;
    const uploadSizes = await uploadSizesFor(
        input.guild.id,
        input.journey.resources.flatMap((resource) => (resource.kind === 'message' && resource.message ? [resource.message] : []))
    );
    // Who listens to its messages' buttons, for the note naming the ones nobody does — read
    // only when a message has buttons, so a journey without any installs with no reader wired.
    const buttonListeners = input.journey.resources.some((resource) => resource.kind === 'message' && resource.buttons?.length)
        ? await requireButtonListenerReader()(input.guild.id, input.journey.journeyKey)
        : undefined;

    return buildInstallPlan({
        guild: input.guild,
        journey: input.journey,
        existingBindings,
        boundInGuild,
        ownership,
        ticketTypes,
        messagePresence,
        uploadSizes,
        buttonListeners,
        choices: input.choices,
        permissionContext: {
            subjectId: input.subjectId,
            staffRoleIds: input.staffRoleIds,
        },
    });
}

/**
 * Every binding in a guild, with the journey names to describe their owners by.
 *
 * The one read behind every "who already holds this?" question — install's adopt fence,
 * uninstall's forget-instead-of-delete, drift's repair fence, the ticket settings save and
 * the channel directory's `owner` — so each asks it the same way and names owners in the
 * same words.
 *
 * **Discord objects only.** A journey's `ticketType` rows are left out here, once, so no
 * fence built on this — `ownerOf`, `describeOtherHolder`, `boundInGuild`, the uninstall
 * plan's `guildBoundIds`, the channel and role directories' `owner` — can read a type key
 * as a snowflake. A type key may be all digits.
 */
export async function loadGuildOwnership(guildId: string): Promise<GuildOwnership> {
    return (await readGuildBindings(guildId)).ownership;
}

/**
 * One read of a guild's bindings: every row, for a caller that also needs one journey's
 * own rows of every kind, and the {@link loadGuildOwnership} view of the same rows.
 */
async function readGuildBindings(
    guildId: string
): Promise<{ readonly rows: readonly ResourceBindingEntity[]; readonly ownership: GuildOwnership }> {
    const [rows, journeys] = await Promise.all([
        resourceBindingsRepo.listByGuild(guildId),
        journeysRepo.listNamesByGuildId(guildId),
    ]);
    return {
        rows,
        ownership: {
            bindings: rows.filter((row) => isDiscordResource(row)),
            journeyNames: new Map(journeys.map((journey) => [journey.journeyKey, journey.name] as const)),
        },
    };
}

export interface InstallJourneyInput extends PreviewInstallInput {
    /**
     * The plan the operator actually approved.
     *
     * Required rather than rebuilt here on purpose: applying a freshly built plan
     * would mean applying something nobody reviewed, which is the "never silently
     * mutate a live server" requirement inverted. A stale plan is caught during
     * apply, where a resource it names is no longer declared or already bound.
     */
    readonly approvedPlan: InstallPlan;
}

/**
 * Apply an approved plan.
 *
 * Refuses a plan built for a different guild or journey — the cheapest possible guard
 * against a mixed-up approval mutating the wrong server.
 *
 * **Takes no lock of its own; reach it through `runInstall`**, which holds the journey's
 * lock across the plan rebuild as well as this apply. Unlike repair and uninstall, the
 * install lock has to cover the rebuild, so it cannot live here without `runInstall`
 * acquiring it twice.
 */
export async function installJourney(
    input: InstallJourneyInput
): Promise<ApplyInstallPlanResult> {
    if (input.approvedPlan.guildId !== input.guild.id) {
        return {
            applied: [],
            failure: `This plan was built for guild ${input.approvedPlan.guildId} but is being applied to ${input.guild.id}. Refusing.`,
        };
    }
    if (input.approvedPlan.journeyKey !== input.journey.journeyKey) {
        return {
            applied: [],
            failure: `This plan was built for journey "${input.approvedPlan.journeyKey}" but is being applied to "${input.journey.journeyKey}". Refusing.`,
        };
    }

    return applyInstallPlan({
        guild: input.guild,
        journey: input.journey,
        plan: input.approvedPlan,
        subjectId: input.subjectId,
        staffRoleIds: input.staffRoleIds,
    });
}

/**
 * Build the teardown plan an operator reviews before anything is destroyed.
 *
 * Reads only. Takes the journey *key* rather than a declaration, because bindings
 * outlive the journey row they came from — a flow whose journey was deleted still has
 * live channels, and those are exactly what this exists to clean up. Requiring a
 * declaration would make the commonest case unreachable.
 */
export async function previewUnpublish(
    guild: Guild,
    journeyKey: string
): Promise<UnpublishPlan> {
    // The whole guild, not just this journey: an interrupted create must not be pinned on
    // an object another owner holds, and a `created` object another owner also uses is
    // forgotten rather than deleted. `bindings` stays this journey's own, of every kind:
    // its ticket type rows are forgotten like the rest.
    const { rows, ownership } = await readGuildBindings(guild.id);
    const bindings = rows.filter((binding) => isJourneyBinding(binding, journeyKey));
    // From the rows alone: a message's row records its channel, so a journey whose row is
    // gone still finds — and deletes — what it posted.
    const messagePresence = await readMessagePresence(guild, bindings);
    return buildUnpublishPlan({ guild, journeyKey, bindings, ownership, messagePresence });
}

export interface PreviewDriftInput {
    readonly guild: Guild;
    readonly journey: JourneyDeclaration;
    /** Who the journey is about, when a resource's permissions name a subject. */
    readonly subjectId?: string;
    readonly staffRoleIds: readonly string[];
}

/**
 * Report which of a journey's installed resources are no longer what it declared.
 *
 * Reads only. Takes a *declaration* rather than a key — the opposite of
 * `previewUnpublish` — because drift is a comparison and there is nothing to compare
 * against once the journey row is gone. A journey whose declaration has been deleted
 * has orphaned bindings, which is teardown's subject rather than this one's.
 *
 * Takes the same permission inputs as the install preview so the comparison compiles
 * the identical models the apply would, for the same reason stated on `previewInstall`.
 *
 * **Channels are read from Discord, not from the cache**, in one request. The cache
 * learns of a permission write only from the gateway event that follows it — Discord
 * answers the write itself with a bare 204 — so a check straight after a repair could
 * read the overwrites from before it. The drift dialog re-reads immediately after
 * repairing, and it showed the operator "Back in line" above the same drift it had
 * just fixed, with the button to fix it again. The refetch replaces each cached
 * channel, overwrites included, with what Discord holds now. Roles need no refetch: a
 * role write answers with the role, which discord.js applies on the spot.
 */
export async function previewDrift(input: PreviewDriftInput): Promise<JourneyDriftPlan> {
    await input.guild.channels.fetch();

    // The guild's rows rather than this journey's alone, so a resource another owner also
    // holds can be reported without a repair that would undo that owner's setup. This
    // journey's own rows are taken from all of them, not from the ownership view, which
    // leaves out every row that is not a Discord object — a message's included.
    const { rows, ownership } = await readGuildBindings(input.guild.id);
    const bindings = rows.filter((binding) => isJourneyBinding(binding, input.journey.journeyKey));
    // One fetch per message this journey has posted and still declares, which also says
    // whether somebody hid its embeds.
    const messageState = await readDeclaredMessageState(input.guild, input.journey, bindings);
    // Who listens to its messages' buttons, so a repair that would take one away names them.
    // Read only when a posted message carries a button its declaration no longer has.
    const buttonListeners = postsButtonsNoLongerDeclared(input.journey, messageState)
        ? await requireButtonListenerReader()(input.guild.id, input.journey.journeyKey)
        : undefined;

    return buildJourneyDriftPlan({
        guild: input.guild,
        journey: input.journey,
        bindings,
        ownership,
        messagePresence: messageState.presence,
        embedsSuppressed: messageState.embedsSuppressed,
        postedButtons: messageState.postedButtons,
        buttonListeners,
        permissionContext: {
            subjectId: input.subjectId,
            staffRoleIds: input.staffRoleIds,
        },
    });
}

/** Whether any posted message of this journey carries a button its declaration no longer has — one a repair would take away. */
function postsButtonsNoLongerDeclared(journey: JourneyDeclaration, messageState: MessageState): boolean {
    return journey.resources.some((resource) => {
        const declared = new Set((resource.buttons ?? []).map((button) => button.key));
        return (messageState.postedButtons.get(resource.key) ?? []).some((button) => !declared.has(button.key));
    });
}

/**
 * {@link readMessageState} for the posted messages a journey still declares, among its
 * rows: one fetch each, and none for a journey that declares no message. A message it no
 * longer declares is an orphan, and `previewOrphans` reads that one.
 */
async function readDeclaredMessageState(
    guild: Guild,
    journey: JourneyDeclaration,
    journeyRows: readonly ResourceBindingEntity[]
): Promise<MessageState> {
    const declaredMessageKeys = new Set(
        journey.resources.filter((resource) => resource.kind === 'message').map((resource) => resource.key)
    );
    return readMessageState(
        guild,
        journeyRows.filter((row) => declaredMessageKeys.has(row.resourceKey))
    );
}

/**
 * Resources this journey installed and no longer declares.
 *
 * Reads only. Separate from `previewDrift` rather than folded into it because the two
 * answer different questions about different things — drift is about resources we still
 * want, and this is about ones we have and no longer asked for. The honest answers
 * differ too: drift offers a repair, and an orphan offers a delete or a forget.
 */
export async function previewOrphans(input: {
    readonly guild: Guild;
    readonly journey: JourneyDeclaration;
}): Promise<readonly OrphanedBinding[]> {
    const bindings = await resourceBindingsRepo.listByJourney(
        input.guild.id,
        input.journey.journeyKey
    );

    // Only the rows no longer declared: a message the journey still declares is drift's.
    const declaredKeys = new Set(input.journey.resources.map((resource) => resource.key));
    const leftovers = bindings.filter((binding) => !declaredKeys.has(binding.resourceKey));
    const messagePresence = await readMessagePresence(input.guild, leftovers);
    // Who still answers a leftover message's buttons — read only when one was posted.
    const buttonListeners = leftovers.some((binding) => isPostedMessageRow(binding))
        ? await requireButtonListenerReader()(input.guild.id, input.journey.journeyKey)
        : undefined;

    return findOrphanedBindings({
        journey: input.journey,
        bindings,
        // Discord objects only; `findOrphanedBindings` branches a ticket type and a message off first.
        existsInGuild: (kind, discordId) => existsInGuildAs(input.guild, kind, discordId),
        messagePresence,
        buttonListeners,
    });
}

export interface RepairDriftInput extends PreviewDriftInput {
    /**
     * The report the operator actually reviewed.
     *
     * Required rather than rebuilt here, for the same reason `installJourney` and
     * `unpublishJourney` require theirs: repairing against a freshly built report would
     * act on findings nobody was shown. The applier re-checks each object immediately
     * before touching it, so a stale report cannot cause a wrong write — it can only
     * cause a no-op, which is reported honestly as nothing repaired.
     */
    readonly approvedPlan: JourneyDriftPlan;
    /** The resource keys the operator ticked. */
    readonly approvedKeys: ReadonlySet<string>;
}

/**
 * Put approved drift back to what the journey declared.
 *
 * Compiles the permission models here rather than in the applier, which has no guild
 * and deliberately refuses to guess at one: a key whose model cannot be compiled is
 * simply absent from the map, and the applier fails that item nameably instead of
 * writing a permission model it inferred.
 */
export async function repairDrift(
    input: RepairDriftInput
): Promise<ApplyDriftRepairResult> {
    // Taken here rather than by the route, so no caller can repair without it. Busy is
    // a refusal — the one outcome that guarantees nothing was touched.
    const outcome = await withJourneyLock(input.guild.id, input.journey.journeyKey, 'repair', () =>
        repairUnderLock(input)
    );
    return outcome.status === 'busy'
        ? { results: [], refusal: journeyBusyMessage(outcome.running) }
        : outcome.value;
}

async function repairUnderLock(input: RepairDriftInput): Promise<ApplyDriftRepairResult> {
    /*
     * The adoption promise is re-derived from the database, never taken from the plan.
     *
     * `approvedPlan` arrives from whoever is calling — today only this process, but the
     * moment a route exists it arrives over the wire, and `repairable: true` on an
     * adopted resource would then be a client's claim rather than a fact. The promise
     * this guards is the strongest one in the feature ("we never touch structure that
     * predates us"), so it is re-read from the row that actually records provenance.
     *
     * Cheap, because the bindings are one indexed query and the plan is small. The
     * alternative — trusting a boolean that travelled — is the shape of defect this
     * repo has shipped before.
     */
    // The guild's rows, so sharing is re-derived alongside adoption: an object another
    // owner holds is never reshaped, whatever the plan that travelled here says. This
    // journey's message rows come from all of them: the ownership view leaves those out.
    const { rows, ownership } = await readGuildBindings(input.guild.id);
    const journeyRows = rows.filter((binding) => isJourneyBinding(binding, input.journey.journeyKey));
    const bindings = ownership.bindings.filter((binding) =>
        isJourneyBinding(binding, input.journey.journeyKey)
    );
    const plan = withSharingReasserted(withAdoptionReasserted(input.approvedPlan, bindings), ownership);
    const bindingByKey = new Map(
        bindings.map((binding) => [binding.resourceKey, binding] as const)
    );

    const compiledOverwrites = new Map<string, readonly PermissionOverwriteWrite[]>();

    for (const declaration of input.journey.resources) {
        if (!declaration.permissions?.length) continue;

        /*
         * The same compile the *comparison* used, through the same function.
         *
         * Two copies of this marshalling existed briefly and they disagreed — one
         * filtered non-bigints, the other cast. Worse, this one skipped
         * `resolveDeclaredRoles`, so a permission naming a role the journey creates
         * compiled here and not there, or the reverse. Repair must write exactly the
         * model the operator was shown as drifted, so it has to reach it by the
         * identical route.
         *
         * A key left out of the map is refused by the applier rather than aborting the
         * run: a `subject` intent on one channel must not block a rename fix on
         * another.
         */
        const compiled = compileForComparison(
            resolveDeclaredRoles(declaration.permissions, bindingByKey),
            { guild: input.guild, subjectId: input.subjectId, staffRoleIds: input.staffRoleIds }
        );

        if (compiled) compiledOverwrites.set(declaration.key, compiled);
    }

    const messageEdits = await prepareMessageEdits(input, plan, journeyRows);

    return applyDriftRepair({
        guild: input.guild,
        plan,
        approvedKeys: input.approvedKeys,
        compiledOverwrites,
        messageEdits,
    });
}

/**
 * The edit for every approved out-of-date message, or why it is refused — before anything is
 * sent, so a message whose declaration Discord would now refuse, or whose uploads are gone,
 * is refused whole with nothing touched (`prepareMessageEdit`).
 *
 * Where each edit goes is read from the journey's row, not the report. The report names the
 * post it was checked against: a row that has moved on to another post since — reposted by
 * an install between the check and this repair — is refused rather than repaired, because
 * nobody was shown a finding about that one.
 *
 * No second presence read: the edit itself is the check, and a message deleted since answers
 * 10008, which the applier reports.
 */
async function prepareMessageEdits(
    input: RepairDriftInput,
    plan: JourneyDriftPlan,
    journeyRows: readonly ResourceBindingEntity[]
): Promise<ReadonlyMap<string, MessageEditPreparation>> {
    const edits = new Map<string, MessageEditPreparation>();

    for (const report of plan.drifted) {
        if (!input.approvedKeys.has(report.resourceKey)) continue;
        if (!report.drift.some((entry) => entry.kind === 'outOfDate')) continue;

        const declaration = input.journey.resources.find(
            (resource) => resource.key === report.resourceKey && resource.kind === 'message'
        );
        const row = journeyRows.find((candidate) => candidate.resourceKey === report.resourceKey && candidate.kind === 'message');
        if (!declaration || !row) {
            edits.set(report.resourceKey, {
                status: 'refused',
                refusal: `**${report.name}** is no longer a message this journey has posted. Nothing was changed; check again.`,
            });
            continue;
        }
        if (row.discordId !== report.discordId) {
            edits.set(report.resourceKey, {
                status: 'refused',
                refusal: `**${report.name}** was posted again since the check, so that check's finding no longer applies. Nothing was changed; check again.`,
            });
            continue;
        }

        try {
            edits.set(report.resourceKey, await prepareMessageEdit(input.guild.id, declaration, row));
        } catch (error) {            // One message that cannot be prepared refuses that message alone: every other
            // approved repair in the run still goes ahead. The cause stays in the log.
            console.error(`[provisioning] Preparing the repair of message "${report.resourceKey}" failed:`, error);
            edits.set(report.resourceKey, {
                status: 'refused',
                refusal: `"${report.name}" couldn't be prepared. Nothing was changed; try again.`,
            });
        }
    }

    return edits;
}

export interface UnpublishJourneyInput {
    readonly guild: Guild;
    /**
     * The plan the operator actually confirmed.
     *
     * Required rather than rebuilt, for the same reason `installJourney` requires one
     * and more sharply: rebuilding here would destroy guild objects against a plan
     * nobody was shown. The confirmation is of *this list*, not of the operation in
     * the abstract.
     */
    readonly approvedPlan: UnpublishPlan;
}

/**
 * Carry out a confirmed unpublish.
 *
 * Refuses a plan built for a different guild — the cheapest guard against a mixed-up
 * confirmation deleting channels on the wrong server, and the consequence of getting
 * it wrong here is not recoverable.
 */
export async function unpublishJourney(
    input: UnpublishJourneyInput
): Promise<ApplyUnpublishPlanResult> {
    if (input.approvedPlan.guildId !== input.guild.id) {
        return {
            results: [],
            refusal: `This teardown was planned for guild ${input.approvedPlan.guildId} but is being applied to ${input.guild.id}. Refusing to delete anything.`,
        };
    }

    // Taken here rather than by the route, so no caller can tear down without it.
    const outcome = await withJourneyLock(input.guild.id, input.approvedPlan.journeyKey, 'uninstall', () =>
        applyUnpublishPlan({ guild: input.guild, plan: input.approvedPlan })
    );
    return outcome.status === 'busy'
        ? { results: [], refusal: journeyBusyMessage(outcome.running) }
        : outcome.value;
}

export interface ResolvedJourneyResources {
    /** Resource key → snowflake, for bindings that still resolve in the guild. */
    readonly live: ReadonlyMap<string, string>;
    /**
     * Keys whose binding names something no longer in the guild.
     *
     * Reported rather than folded into `live`, because the caller's job is to write
     * these ids into node configs: a stale one produces a block silently pointing at
     * a deleted channel, which fails at run time far from the cause. Re-running
     * install repairs them.
     */
    readonly stale: readonly string[];
}

/**
 * Resolve a journey's resource keys to the ids they are bound to.
 *
 * This is what makes the "install writes snowflakes in" decision work: after an
 * install, a caller asks for the map and writes the ids into node configs.
 *
 * An `intended` row is skipped entirely — it names a resource that does not exist
 * yet, and its id is null. A settled row whose object has since been deleted is
 * surfaced in `stale` instead, so no caller can mistake it for live.
 *
 * A ticket type resolves to its **key**, which is what a `ticketTypePicker` field holds,
 * for as long as the ticket settings still list it; removed, it is `stale` like a deleted
 * channel. The settings are read once, and only when the journey holds a type.
 */
export async function resolveJourneyResources(
    guild: Guild,
    journeyKey: string
): Promise<ResolvedJourneyResources> {
    const bindings = await resourceBindingsRepo.listByJourney(guild.id, journeyKey);
    const live = new Map<string, string>();
    const stale: string[] = [];

    const ticketTypes = bindings.some((binding) => binding.kind === 'ticketType')
        ? await requireTicketTypeProvider().read(guild.id)
        : undefined;

    /**
     * Whether a settled row of a kind that is not in the guild's cache still names something,
     * or `undefined` for a row no node config can hold.
     */
    const nonDiscordBindingExists = (bindingKind: ResourceKind, discordId: string): boolean | undefined => {
        const kind = nonDiscordResourceKind(bindingKind);
        switch (kind) {
            case 'ticketType':
                return ticketTypes?.status === 'ok' && ticketTypes.types.has(discordId);
            // No node's config holds a message's id, so there is nothing to write back — and
            // telling whether it is still posted would cost a fetch per message per install.
            case 'message':
                return undefined;
            default: {
                const unreachable: never = kind;
                throw new Error(`Unhandled resource kind: ${String(unreachable)}`);
            }
        }
    };

    for (const binding of bindings) {
        if (!binding.discordId || binding.state === 'intended') continue;

        const exists = isDiscordResource(binding)
            ? binding.kind === 'role'
                ? guild.roles.cache.has(binding.discordId)
                : guild.channels.cache.has(binding.discordId)
            : nonDiscordBindingExists(binding.kind, binding.discordId);

        if (exists === undefined) continue;
        if (exists) {
            live.set(binding.resourceKey, binding.discordId);
        } else {
            stale.push(binding.resourceKey);
        }
    }

    return { live, stale };
}
