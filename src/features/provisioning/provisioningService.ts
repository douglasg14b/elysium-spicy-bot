import type { Guild } from 'discord.js';
import { resourceBindingsRepo } from './data/resourceBindingsRepo';
import { applyInstallPlan, type ApplyInstallPlanResult } from './logic/applyInstallPlan';
import { buildInstallPlan, type InstallPlan, type ResourceChoice } from './logic/installPlan';
import type { JourneyDeclaration } from './logic/resourceDeclaration';

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
    const existingBindings = await resourceBindingsRepo.listByJourney(
        input.guild.id,
        input.journey.journeyKey
    );

    return buildInstallPlan({
        guild: input.guild,
        journey: input.journey,
        existingBindings,
        choices: input.choices,
        permissionContext: {
            subjectId: input.subjectId,
            staffRoleIds: input.staffRoleIds,
        },
    });
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
 */
export async function resolveJourneyResources(
    guild: Guild,
    journeyKey: string
): Promise<ResolvedJourneyResources> {
    const bindings = await resourceBindingsRepo.listByJourney(guild.id, journeyKey);
    const live = new Map<string, string>();
    const stale: string[] = [];

    for (const binding of bindings) {
        if (!binding.discordId || binding.state === 'intended') continue;

        const exists =
            binding.kind === 'role'
                ? guild.roles.cache.has(binding.discordId)
                : guild.channels.cache.has(binding.discordId);

        if (exists) {
            live.set(binding.resourceKey, binding.discordId);
        } else {
            stale.push(binding.resourceKey);
        }
    }

    return { live, stale };
}
