import { ChannelType, type CategoryChannel, type Guild } from 'discord.js';
import { resourceBindingsRepo } from '../data/resourceBindingsRepo';
import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import { parseDeclaredRoleReference } from './declaredRoleReference';
import { isPlanApplicable, planMutations, type InstallPlan, type PlanItem } from './installPlan';
import {
    compilePermissionIntents,
    type PermissionIntent,
    type PermissionIntentContext,
} from './permissionIntent';
import type { JourneyDeclaration, ResourceDeclaration, ResourceKind } from './resourceDeclaration';

export interface ApplyInstallPlanInput {
    readonly guild: Guild;
    readonly journey: JourneyDeclaration;
    readonly plan: InstallPlan;
    /** Who the journey is about, when a resource's permissions name a subject. */
    readonly subjectId?: string;
    readonly staffRoleIds: readonly string[];
}

export interface AppliedResource {
    readonly resourceKey: string;
    readonly discordId: string;
    readonly action: 'created' | 'adopted' | 'reused';
    readonly name: string;
}

export interface ApplyInstallPlanResult {
    readonly applied: readonly AppliedResource[];
    /**
     * What stopped the apply, if anything.
     *
     * Partial application is a legitimate state, not a failure (PRD §5.7): the
     * resources in `applied` are real, bound, and must not be undone. The operator
     * re-runs install and it converges.
     */
    readonly failure?: string;
}

/**
 * Apply an approved plan to the guild.
 *
 * The ordering here is the crash-safety requirement, and it is the reason this is not
 * a simple loop over creates:
 *
 *   1. write the binding row as `intended`
 *   2. mutate the guild
 *   3. settle the binding with the new id
 *
 * A crash between 2 and 3 leaves an `intended` row naming what was being made, so the
 * next install can find it rather than creating a duplicate. The reverse order — make
 * it, then record it — is what produces orphans, and no amount of error handling
 * recovers from a process that died.
 *
 * Stops at the first failure rather than pressing on. A journey's later resources
 * routinely depend on its earlier ones (a channel needs its category), so continuing
 * past a failure produces a half-built structure that is harder to reason about than
 * a clearly truncated one.
 */
export async function applyInstallPlan(
    input: ApplyInstallPlanInput
): Promise<ApplyInstallPlanResult> {
    const { guild, journey, plan, subjectId, staffRoleIds } = input;

    if (!isPlanApplicable(plan)) {
        return {
            applied: [],
            failure: 'This plan has unresolved items or blockers and cannot be applied. Resolve them and rebuild the plan.',
        };
    }

    const declarationByKey = new Map(
        journey.resources.map((resource) => [resource.key, resource] as const)
    );
    const applied: AppliedResource[] = [];

    // Resources already bound from a previous run still have to resolve, because a
    // later resource may name one as its parent.
    const idByKey = new Map<string, string>();
    for (const item of plan.items) {
        if (item.action === 'reuse' && item.discordId) {
            idByKey.set(item.resourceKey, item.discordId);
            applied.push({
                resourceKey: item.resourceKey,
                discordId: item.discordId,
                action: 'reused',
                name: item.name,
            });
        }
    }

    const permissionContext: PermissionIntentContext = { guild, subjectId, staffRoleIds };

    for (const item of planMutations(plan)) {
        const declaration = declarationByKey.get(item.resourceKey);
        if (!declaration) {
            return {
                applied,
                failure: `Plan names resource "${item.resourceKey}", which the journey does not declare. The plan is stale — rebuild it.`,
            };
        }

        let binding: ResourceBindingEntity;
        try {
            binding = await resourceBindingsRepo.recordIntent({
                guildId: guild.id,
                journeyKey: journey.journeyKey,
                resourceKey: item.resourceKey,
                kind: item.kind,
                name: item.name,
            });
        } catch (error) {
            return {
                applied,
                failure: `Could not record provisioning intent for "${item.resourceKey}": ${describeError(error)}`,
            };
        }

        // A binding that is already settled needs care: it may be a converging
        // re-run, or it may be the stale binding that *caused* the plan to decide on
        // a recreate. Treating every settled binding as convergence reports success
        // while pointing at a dead snowflake.
        const settledElsewhere = Boolean(binding.discordId) && binding.state !== 'intended';
        const bindingIsLive =
            settledElsewhere && binding.discordId
                ? existsInGuild(guild, item.kind, binding.discordId)
                : false;

        if (settledElsewhere && bindingIsLive && binding.discordId) {
            // Genuine convergence: something real is already bound for this key. If
            // the operator approved adopting a *different* object, the plan they
            // reviewed no longer describes reality, and applying it anyway would
            // bind something they did not approve.
            if (item.action === 'adopt' && item.discordId !== binding.discordId) {
                return {
                    applied,
                    failure: `"${item.resourceKey}" is already bound to ${binding.discordId}, but this plan approved adopting ${item.discordId}. Rebuild the plan and review it again.`,
                };
            }

            idByKey.set(item.resourceKey, binding.discordId);
            applied.push({
                resourceKey: item.resourceKey,
                discordId: binding.discordId,
                action: 'reused',
                name: binding.name,
            });
            continue;
        }

        let discordId: string;
        try {
            discordId =
                item.action === 'adopt'
                    ? requireAdoptable(guild, item)
                    : await createResource({
                          guild,
                          item,
                          declaration,
                          idByKey,
                          permissionContext,
                      });
        } catch (error) {
            // The guild was not mutated, so the intent row is noise — but only if it
            // is *ours*. A pre-existing settled row must survive, and `discardIntent`
            // is guarded on `intended` so it will not touch one.
            if (!settledElsewhere) {
                try {
                    await resourceBindingsRepo.discardIntent(binding.id);
                } catch (discardError) {
                    // Reported rather than swallowed: the row stays `intended`, which
                    // is the safe direction, but a human needs to know why the next
                    // plan may mention a resource that was never created.
                    console.error(
                        `[provisioning] Failed to discard the intent row for "${item.resourceKey}" (binding ${binding.id}) in guild ${guild.id}:`,
                        discardError
                    );
                }
            }
            return {
                applied,
                failure: `Failed to ${item.action} ${item.kind} "${item.name}": ${describeError(error)}`,
            };
        }

        // The guild is now mutated. Every failure past this point must still report
        // what was applied, or the operator retries blindly and duplicates it.
        let settled: boolean;
        try {
            settled =
                settledElsewhere && binding.discordId
                    ? // Replacing a binding that pointed at something deleted.
                      await resourceBindingsRepo.rebind({
                          id: binding.id,
                          expectedDiscordId: binding.discordId,
                          discordId,
                          state: item.action === 'adopt' ? 'adopted' : 'created',
                          name: item.name,
                      })
                    : await resourceBindingsRepo.settle({
                          id: binding.id,
                          discordId,
                          state: item.action === 'adopt' ? 'adopted' : 'created',
                          name: item.name,
                      });
        } catch (error) {
            return {
                applied,
                failure: `${item.kind} "${item.name}" was ${item.action === 'adopt' ? 'adopted' : 'created'} in the server (${discordId}), but recording its binding failed: ${describeError(error)}. Re-run install to reconcile; do not delete it by hand first.`,
            };
        }

        if (!settled) {
            // Another install settled this binding first. The resource we just made
            // is a duplicate, and we say so rather than pretending it is ours —
            // deleting it automatically would be a destructive action taken without
            // confirmation.
            return {
                applied,
                failure: `"${item.resourceKey}" was bound by a concurrent install while this one was applying. A duplicate ${item.kind} named "${item.name}" may have been created and should be removed by hand.`,
            };
        }

        idByKey.set(item.resourceKey, discordId);
        applied.push({
            resourceKey: item.resourceKey,
            discordId,
            action: item.action === 'adopt' ? 'adopted' : 'created',
            name: item.name,
        });
    }

    return { applied };
}

/** Whether a snowflake still resolves to something of the expected kind. */
function existsInGuild(guild: Guild, kind: ResourceKind, discordId: string): boolean {
    if (kind === 'role') {
        return guild.roles.cache.has(discordId);
    }

    const channel = guild.channels.cache.get(discordId);
    if (!channel) return false;

    return kind === 'category'
        ? channel.type === ChannelType.GuildCategory
        : channel.type === ChannelType.GuildText;
}

/**
 * Re-check an adoption at apply time.
 *
 * The plan verified this id when it was built, but a plan is reviewed by a human and
 * approval takes time — the channel can be deleted in between. Binding to it anyway
 * would record a resource that does not exist, which is exactly what the recreate
 * path then has to clean up.
 */
function requireAdoptable(guild: Guild, item: PlanItem): string {
    if (!item.discordId) {
        throw new Error('an adopt item carries no id');
    }
    if (!existsInGuild(guild, item.kind, item.discordId)) {
        throw new Error(
            `the chosen ${item.kind} (${item.discordId}) no longer exists in this server, or is not a ${item.kind}. Rebuild the plan`
        );
    }
    return item.discordId;
}

interface CreateResourceInput {
    readonly guild: Guild;
    readonly item: PlanItem;
    readonly declaration: ResourceDeclaration;
    readonly idByKey: ReadonlyMap<string, string>;
    readonly permissionContext: PermissionIntentContext;
}

async function createResource({
    guild,
    item,
    declaration,
    idByKey,
    permissionContext,
}: CreateResourceInput): Promise<string> {
    const overwrites = declaration.permissions?.length
        ? compilePermissionIntents(
              resolveDeclaredRoles(declaration.permissions, idByKey),
              permissionContext
          )
        : undefined;

    switch (declaration.kind) {
        case 'role': {
            const role = await guild.roles.create({
                name: item.name,
                reason: `Provisioned for journey "${item.resourceKey}"`,
            });
            return role.id;
        }

        case 'category': {
            const category = await guild.channels.create({
                name: item.name,
                type: ChannelType.GuildCategory,
                permissionOverwrites: overwrites,
                reason: `Provisioned for journey "${item.resourceKey}"`,
            });
            return category.id;
        }

        case 'textChannel': {
            const parent = resolveParent(guild, declaration, idByKey);
            const channel = await guild.channels.create({
                name: item.name,
                type: ChannelType.GuildText,
                parent,
                // Without declared permissions a channel inherits its category's,
                // which is the useful default and why this stays undefined rather
                // than becoming an empty array (which would clear inheritance).
                permissionOverwrites: overwrites,
                reason: `Provisioned for journey "${item.resourceKey}"`,
            });
            return channel.id;
        }
    }
}

/**
 * Swap every declared-role reference in a set of intents for the id it resolved to.
 *
 * Resolution happens **here**, against the ids this same apply has been accumulating,
 * rather than in a pre-pass over the declaration. The reason is that `idByKey` is
 * already the canonical key→snowflake answer for this install — it holds ids from
 * reused bindings and from resources created moments ago alike — so resolving
 * anywhere else would be a second source of truth that can disagree with it.
 *
 * Throws on an unresolved reference rather than dropping it. A dropped reference
 * would compile to a *less* restricted channel than the author asked for, which is
 * the one failure mode `permissionIntent.ts` explicitly refuses to degrade into.
 * `orderResourcesForApply` guarantees the role was handled first, so reaching this is
 * a genuine ordering bug or a role whose own creation failed — both worth naming.
 */
function resolveDeclaredRoles(
    permissions: readonly PermissionIntent[],
    idByKey: ReadonlyMap<string, string>
): readonly PermissionIntent[] {
    return permissions.map((intent) => {
        if (!intent.roleIds?.length) return intent;

        let changed = false;
        const roleIds = intent.roleIds.map((roleId) => {
            const referencedKey = parseDeclaredRoleReference(roleId);
            if (!referencedKey) return roleId;

            const resolved = idByKey.get(referencedKey);
            if (!resolved) {
                throw new Error(
                    `its permissions name the declared role "${referencedKey}", which has no id yet. The role must be created before anything referencing it`
                );
            }
            changed = true;
            return resolved;
        });

        return changed ? { ...intent, roleIds } : intent;
    });
}

function resolveParent(
    guild: Guild,
    declaration: ResourceDeclaration,
    idByKey: ReadonlyMap<string, string>
): CategoryChannel | undefined {
    if (!declaration.parentKey) return undefined;

    const parentId = idByKey.get(declaration.parentKey);
    if (!parentId) {
        // Ordering guarantees the parent was handled first, so this means the parent
        // failed or was skipped. Creating the channel at the guild root instead would
        // put it somewhere the operator did not ask for and did not approve.
        throw new Error(
            `parent "${declaration.parentKey}" has no id yet, so this channel cannot be placed`
        );
    }

    const parent = guild.channels.cache.get(parentId);
    if (!parent || parent.type !== ChannelType.GuildCategory) {
        throw new Error(`parent "${declaration.parentKey}" (${parentId}) is not a category`);
    }

    return parent;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
