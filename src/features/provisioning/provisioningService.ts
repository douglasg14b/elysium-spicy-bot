import type { Guild } from 'discord.js';
import { journeysRepo } from './data/journeysRepo';
import { resourceBindingsRepo } from './data/resourceBindingsRepo';
import type { ResourceBindingEntity } from './data/resourceBindingsSchema';
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
import { isDiscordResource, type JourneyDeclaration } from './logic/resourceDeclaration';

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

    return buildInstallPlan({
        guild: input.guild,
        journey: input.journey,
        existingBindings,
        boundInGuild,
        ownership,
        ticketTypes,
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
    return buildUnpublishPlan({ guild, journeyKey, bindings, ownership });
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
    // holds can be reported without a repair that would undo that owner's setup.
    const ownership = await loadGuildOwnership(input.guild.id);
    const bindings = ownership.bindings.filter((binding) =>
        isJourneyBinding(binding, input.journey.journeyKey)
    );

    return buildJourneyDriftPlan({
        guild: input.guild,
        journey: input.journey,
        bindings,
        ownership,
        permissionContext: {
            subjectId: input.subjectId,
            staffRoleIds: input.staffRoleIds,
        },
    });
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

    return findOrphanedBindings({
        journey: input.journey,
        bindings,
        // Discord objects only; `findOrphanedBindings` branches a ticket type off first.
        existsInGuild: (kind, discordId) => existsInGuildAs(input.guild, kind, discordId),
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
    // owner holds is never reshaped, whatever the plan that travelled here says.
    const ownership = await loadGuildOwnership(input.guild.id);
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

    return applyDriftRepair({
        guild: input.guild,
        plan,
        approvedKeys: input.approvedKeys,
        compiledOverwrites,
    });
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

    for (const binding of bindings) {
        if (!binding.discordId || binding.state === 'intended') continue;

        const exists = isDiscordResource(binding)
            ? binding.kind === 'role'
                ? guild.roles.cache.has(binding.discordId)
                : guild.channels.cache.has(binding.discordId)
            : ticketTypes?.status === 'ok' && ticketTypes.types.has(binding.discordId);

        if (exists) {
            live.set(binding.resourceKey, binding.discordId);
        } else {
            stale.push(binding.resourceKey);
        }
    }

    return { live, stale };
}
