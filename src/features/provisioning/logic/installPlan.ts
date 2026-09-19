import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import { compilePermissionIntents, type PermissionIntentContext } from './permissionIntent';
import {
    orderResourcesForApply,
    validateJourneyDeclaration,
    type JourneyDeclaration,
    type ResourceDeclaration,
    type ResourceKind,
} from './resourceDeclaration';

/**
 * What the applier will do to one resource.
 *
 * `reuse` is a binding that already resolves, `adopt` is an existing guild object the
 * operator chose, `create` makes a new one. `blocked` is a first-class outcome rather
 * than a thrown error, because a plan that can only be shown when it is entirely
 * valid is useless for diagnosis — the operator needs to see the whole picture,
 * including the parts that cannot proceed.
 */
export const PLAN_ACTIONS = ['create', 'adopt', 'reuse', 'blocked'] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

export interface PlanItem {
    readonly resourceKey: string;
    readonly kind: ResourceKind;
    readonly action: PlanAction;
    /** The name the resource will have, or already has. */
    readonly name: string;
    /** Set for `adopt` and `reuse`: the guild object this resolves to. */
    readonly discordId?: string;
    /** Set for `blocked`: why, in words an operator can act on. */
    readonly reason?: string;
    readonly parentKey?: string;
}

export interface InstallPlan {
    readonly guildId: string;
    readonly journeyKey: string;
    readonly items: readonly PlanItem[];
    /**
     * Guild-level problems that stop the whole apply — missing permissions, or a role
     * hierarchy that would make role creation fail. Separate from per-item `blocked`
     * because these are not about any one resource.
     */
    readonly blockers: readonly string[];
}

/** A binding the operator has chosen for a resource key, from the install form. */
export interface ResourceChoice {
    /** Adopt this existing guild object instead of creating one. */
    readonly adoptDiscordId?: string;
    /** Use this name instead of the declaration's default. */
    readonly name?: string;
}

export interface BuildInstallPlanInput {
    readonly guild: Guild;
    readonly journey: JourneyDeclaration;
    readonly existingBindings: readonly ResourceBindingEntity[];
    /** Keyed by resource key. Absent means "take the default", which is create. */
    readonly choices?: Readonly<Record<string, ResourceChoice>>;
    /**
     * The same permission context the apply will use.
     *
     * Supplied so the plan can compile each resource's intents and surface an
     * unresolvable one as a blocker. Without it a plan can look applicable and then
     * fail partway through on a permission model that was never satisfiable — the
     * preview would be lying about what apply will do.
     */
    readonly permissionContext?: Omit<PermissionIntentContext, 'guild'>;
}

const KIND_LABEL: Record<ResourceKind, string> = {
    category: 'category',
    textChannel: 'channel',
    role: 'role',
};

/**
 * Check the bot can actually do what the plan asks, before it is shown.
 *
 * The hierarchy check is the one that matters and the one a runtime exception reports
 * badly: Discord refuses to let a bot create a role above its own highest role, and
 * the failure surfaces mid-apply as a generic 403. Naming it in the plan is the
 * requirement (PRD §5.7 capability preflight).
 */
function collectBlockers(guild: Guild, resources: readonly ResourceDeclaration[]): string[] {
    const blockers: string[] = [];
    const me = guild.members.me;

    if (!me) {
        // Everything below reads from `me`; without it there is nothing to check
        // against, and guessing is worse than refusing.
        return [
            `The bot's own member is not cached for ${guild.name}, so its permissions cannot be verified. Refusing to plan an install that cannot be checked.`,
        ];
    }

    const needsChannels = resources.some(
        (resource) => resource.kind === 'category' || resource.kind === 'textChannel'
    );
    const needsRoles = resources.some((resource) => resource.kind === 'role');

    if (needsChannels && !me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        blockers.push('The bot lacks **Manage Channels**, which this journey needs to create its categories and channels.');
    }
    if (needsRoles && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        blockers.push('The bot lacks **Manage Roles**, which this journey needs to create its roles.');
    }

    // A bot can only create roles below its own highest. At position 0 it has no
    // room at all, which is worth saying plainly rather than letting the create 403.
    if (needsRoles && me.roles.highest.position === 0) {
        blockers.push(
            "The bot's highest role sits at the bottom of the role list, so it cannot create a role below itself. Move the bot's role up in Server Settings → Roles."
        );
    }

    return blockers;
}

/**
 * Find an existing guild object by name, for suggestion purposes only.
 *
 * Returns every match rather than the first, because Discord permits duplicate
 * channel and role names — picking one would be the guess this design exists to
 * avoid. An ambiguous result blocks the item and asks the operator (§5.7).
 */
function findByName(guild: Guild, kind: ResourceKind, name: string): string[] {
    const wanted = name.trim().toLowerCase();

    if (kind === 'role') {
        return guild.roles.cache
            .filter((role) => role.name.toLowerCase() === wanted)
            .map((role) => role.id);
    }

    const channelType = kind === 'category' ? ChannelType.GuildCategory : ChannelType.GuildText;
    return guild.channels.cache
        .filter((channel) => channel.type === channelType && channel.name.toLowerCase() === wanted)
        .map((channel) => channel.id);
}

/**
 * Dry-run a resource's permission intents, returning the problem if there is one.
 *
 * Compiling is the check — there is no separate validator to drift out of step with
 * the thing that actually runs at apply time.
 */
function describePermissionFailure(
    permissions: NonNullable<ResourceDeclaration['permissions']>,
    context: PermissionIntentContext
): string | undefined {
    try {
        compilePermissionIntents(permissions, context);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/**
 * Build the reviewable plan for installing a journey on a guild.
 *
 * Pure with respect to the guild: it reads caches and the binding table and mutates
 * nothing. That is what makes preview honest — the operator sees this, approves it,
 * and only then does anything change.
 */
export function buildInstallPlan(input: BuildInstallPlanInput): InstallPlan {
    const { guild, journey, existingBindings, choices = {}, permissionContext } = input;

    validateJourneyDeclaration(journey);

    const bindingByKey = new Map(
        existingBindings.map((binding) => [binding.resourceKey, binding] as const)
    );
    const items: PlanItem[] = [];

    for (const resource of orderResourcesForApply(journey.resources)) {
        const choice = choices[resource.key];
        const name = choice?.name?.trim() || resource.defaultName;
        const base = {
            resourceKey: resource.key,
            kind: resource.kind,
            name,
            parentKey: resource.parentKey,
        } as const;

        // Compile the permission model now, so an unsatisfiable one blocks the plan
        // instead of failing mid-apply with resources already created. Skipped when
        // no context was supplied, since a caller that cannot provide one gets the
        // old behaviour rather than a false blocker.
        if (permissionContext && resource.permissions?.length) {
            const permissionError = describePermissionFailure(resource.permissions, {
                guild,
                ...permissionContext,
            });
            if (permissionError) {
                items.push({ ...base, action: 'blocked', reason: permissionError });
                continue;
            }
        }

        // A settled binding wins over everything: this journey already owns a
        // resource for this key, and re-running install must converge, not duplicate.
        const existing = bindingByKey.get(resource.key);
        if (existing?.discordId && existing.state !== 'intended') {
            const stillThere =
                resource.kind === 'role'
                    ? guild.roles.cache.has(existing.discordId)
                    : guild.channels.cache.has(existing.discordId);

            if (stillThere) {
                items.push({ ...base, action: 'reuse', discordId: existing.discordId });
                continue;
            }

            // The binding points at something that no longer exists. Creating a
            // replacement silently would hide a deletion the operator may not know
            // about, so the plan says so and offers the create explicitly.
            items.push({
                ...base,
                action: 'create',
                reason: `The previously bound ${KIND_LABEL[resource.kind]} no longer exists in this server and will be recreated.`,
            });
            continue;
        }

        if (choice?.adoptDiscordId) {
            const exists =
                resource.kind === 'role'
                    ? guild.roles.cache.has(choice.adoptDiscordId)
                    : guild.channels.cache.has(choice.adoptDiscordId);

            items.push(
                exists
                    ? { ...base, action: 'adopt', discordId: choice.adoptDiscordId }
                    : {
                          ...base,
                          action: 'blocked',
                          reason: `The chosen ${KIND_LABEL[resource.kind]} (${choice.adoptDiscordId}) does not exist in this server.`,
                      }
            );
            continue;
        }

        // No binding and no explicit choice. Look for a name match to *report*, never
        // to apply: auto-binding on a name collision is how an install silently
        // takes over a channel the operator did not mean to give it.
        const matches = findByName(guild, resource.kind, name);
        if (matches.length === 1) {
            items.push({
                ...base,
                action: 'blocked',
                discordId: matches[0],
                reason: `A ${KIND_LABEL[resource.kind]} named "${name}" already exists. Choose whether to adopt it or create a new one under a different name.`,
            });
            continue;
        }
        if (matches.length > 1) {
            items.push({
                ...base,
                action: 'blocked',
                reason: `${matches.length} ${KIND_LABEL[resource.kind]}s are named "${name}". Pick which one to adopt, or choose a different name.`,
            });
            continue;
        }

        items.push({ ...base, action: 'create' });
    }

    return {
        guildId: guild.id,
        journeyKey: journey.journeyKey,
        items,
        blockers: collectBlockers(guild, journey.resources),
    };
}

/** Whether a plan can be applied at all. A blocked item stops the whole apply. */
export function isPlanApplicable(plan: InstallPlan): boolean {
    return plan.blockers.length === 0 && plan.items.every((item) => item.action !== 'blocked');
}

/** The items an apply would actually act on, in parent-before-child order. */
export function planMutations(plan: InstallPlan): readonly PlanItem[] {
    return plan.items.filter((item) => item.action === 'create' || item.action === 'adopt');
}
