import { ChannelType, DiscordAPIError, type CategoryChannel, type Guild } from 'discord.js';
import { resourceBindingsRepo } from '../data/resourceBindingsRepo';
import { journeyOwner, type ResourceBindingEntity } from '../data/resourceBindingsSchema';
import { requireTicketTypeProvider, type TicketTypeCreateOutcome } from '../ticketTypeProvider';
import { parseDeclaredRoleReference } from './declaredRoleReference';
import { describeDiscordError } from './discordErrors';
import {
    existsInGuildAs,
    isPlanApplicable,
    planMutations,
    type InstallPlan,
    type PlanItem,
} from './installPlan';
import {
    compilePermissionIntents,
    type PermissionIntent,
    type PermissionIntentContext,
} from './permissionIntent';
import {
    isDiscordResource,
    type DiscordResourceKind,
    type JourneyDeclaration,
    type ResourceDeclaration,
} from './resourceDeclaration';

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
        // Everything below goes by the item's kind, so a plan made before the resource's
        // kind changed must not reach it.
        if (declaration.kind !== item.kind) {
            return {
                applied,
                failure: `Plan has "${item.resourceKey}" as a ${item.kind}, but the journey now declares a ${declaration.kind}. The plan is stale — rebuild it.`,
            };
        }

        // A ticket type is a row in the ticket settings, not a Discord object: nothing here
        // can be half-made, so there is no intent row, and none of the Discord error
        // handling below applies. Branched before `recordIntent`, which takes only a
        // Discord kind.
        if (!isDiscordResource(item)) {
            const outcome = await applyTicketType(guild.id, journey.journeyKey, item, declaration);
            if ('failure' in outcome) return { applied, failure: outcome.failure };
            applied.push(outcome);
            continue;
        }

        let binding: ResourceBindingEntity;
        try {
            binding = await resourceBindingsRepo.recordIntent({
                guildId: guild.id,
                journeyKey: journey.journeyKey,
                resourceKey: item.resourceKey,
                kind: item.kind,
                name: item.name,
                startsCreate: item.action === 'create',
            });
        } catch (error) {
            logStoreFailure(`recording intent for "${item.resourceKey}"`, error);
            return {
                applied,
                failure: `Could not record provisioning intent for "${item.resourceKey}". Nothing was created; run install again.`,
            };
        }

        // A binding that is already settled needs care: it may be a converging
        // re-run, or it may be the stale binding that *caused* the plan to decide on
        // a recreate. Treating every settled binding as convergence reports success
        // while pointing at a dead snowflake.
        const settledElsewhere = Boolean(binding.discordId) && binding.state !== 'intended';
        // Only a row of this kind can be live as this item: a ticket type row left under a
        // key now declared as a channel holds a type key, which may even be all digits.
        const bindingIsLive =
            settledElsewhere && binding.discordId && binding.kind === item.kind
                ? existsInGuildAs(guild, item.kind, binding.discordId)
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

        // The guild was not mutated, so the intent row is noise — but only if it is
        // *ours*. A pre-existing settled row must survive, and `discardIntent` is guarded
        // on `intended` so it will not touch one.
        const discardOwnIntent = async (): Promise<void> => {
            if (settledElsewhere) return;
            try {
                await resourceBindingsRepo.discardIntent(binding.id);
            } catch (discardError) {
                // Reported rather than swallowed: the row stays `intended`, which is the
                // safe direction, but a human needs to know why the next plan may mention
                // a resource that was never created.
                console.error(
                    `[provisioning] Failed to discard the intent row for "${item.resourceKey}" (binding ${binding.id}) in guild ${guild.id}:`,
                    discardError
                );
            }
        };

        // Everything that can refuse *before* Discord is asked: a recovery or adoption
        // whose object has gone, a parent with no id, a permission model that will not
        // compile. None of it has touched the guild.
        let bind: () => Promise<string>;
        try {
            // A recovery binds an object that already exists, exactly as an adoption
            // does, so it gets the same re-check; only the provenance it records differs.
            if (item.action === 'adopt' || item.action === 'recover') {
                const existingId = requireAdoptable(guild, item);
                bind = async () => existingId;
            } else {
                bind = prepareCreate({ guild, item, declaration, idByKey, permissionContext });
            }
        } catch (error) {
            await discardOwnIntent();
            return {
                applied,
                failure: `Failed to ${item.action} ${item.kind} "${item.name}": ${describeError(error)}`,
            };
        }

        let discordId: string;
        try {
            discordId = await bind();
        } catch (error) {
            /*
             * Only a `DiscordAPIError` is Discord *refusing* — a 4xx with a reason, after
             * which nothing was made. Anything else is an answer that never arrived: a
             * timeout, a 5xx, a dropped connection. `@discordjs/rest` resends those up to
             * three times before giving up, so Discord may have created the object once
             * or more. Discarding the intent there would erase the one record crash
             * recovery reads, and the next install would offer the object up for
             * adoption — so the intent stays, and the next plan finds what landed.
             */
            if (error instanceof DiscordAPIError) {
                await discardOwnIntent();
                return {
                    applied,
                    failure: `Failed to ${item.action} ${item.kind} "${item.name}": ${describeDiscordError(error)}`,
                };
            }
            // Whatever never arrived — a timeout, a dropped connection — is the log's to
            // keep; the operator's next step is the same whichever it was.
            console.error(`[provisioning] No answer from Discord creating ${item.kind} "${item.name}":`, error);
            return {
                applied,
                failure: `Discord never confirmed whether ${item.kind} "${item.name}" was created. Run install again: if it was, the next plan takes it back rather than making another.`,
            };
        }

        /*
         * What to record as the binding's name.
         *
         * For a `create` this is the declared name, because we just gave the object
         * that name. For an **adopt** it must be the object's *live* name: adoption
         * binds to something that already exists and deliberately never renames it
         * (`requireAdoptable` validates the id and type and nothing else), so recording
         * the declared name would say the channel is called `welcome` when the operator
         * can plainly see it is called `#lounge`.
         *
         * That mismatch is not cosmetic. Drift detection measures an **adopted** object
         * against this column — precisely because the declaration and the live name are
         * expected to differ forever on the adopt path — so recording the wrong one makes
         * every adopted resource report a rename that never happened, permanently. The
         * adoption promise would hide the consequence by withholding repair, but a report
         * that cries wolf on exactly the resources the operator asked us not to touch is
         * how they learn to ignore the whole feature.
         *
         * A **created** object is measured against its declaration instead, so that
         * renaming the row in the resources panel is drift the operator can repair. See
         * `detectResourceDrift`, which owns that split; this column is one half of it.
         */
        // A recovered object also predates this run, and carries whatever name the
        // interrupted attempt gave it — which a rename since would make differ from
        // `item.name`.
        const recordedName =
            item.action === 'adopt' || item.action === 'recover'
                ? liveNameOf(guild, item.kind, discordId) ?? item.name
                : item.name;
        /*
         * A recovered object was **created** by this journey, whatever route found it.
         * Recording it as adopted is the whole defect recovery exists to prevent:
         * provenance is what teardown reads, and it never deletes an adopted resource.
         */
        const settledState = item.action === 'adopt' ? 'adopted' : 'created';

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
                          kind: item.kind,
                          state: settledState,
                          name: recordedName,
                      })
                    : await resourceBindingsRepo.settle({
                          id: binding.id,
                          discordId,
                          kind: item.kind,
                          state: settledState,
                          name: recordedName,
                      });
        } catch (error) {
            logStoreFailure(`recording the binding of ${item.kind} "${item.name}" (${discordId})`, error);
            return {
                applied,
                failure: `${item.kind} "${item.name}" was ${settledState} in the server (${discordId}), but recording its binding failed. Re-run install to reconcile; do not delete it by hand first.`,
            };
        }

        if (!settled) {
            /*
             * An adopt or a recover binds an object that already existed, and loses when
             * another owner claimed it after the plan was built — a ticket save or another
             * journey's install holds a different lock (`settle`/`rebind` refuse an object
             * someone else holds). Nothing was made, so there is no duplicate to mention.
             *
             * The intent row goes too, in both cases. For an adopt, a fresh intent left
             * behind could recover a same-named object made in the next ten minutes as
             * this journey's `created`, to be deleted by its uninstall. For a recover the
             * object it was about to take back is another owner's now, and the intent
             * must not offer to take it back again.
             */
            if (item.action !== 'create') {
                await discardOwnIntent();
                return {
                    applied,
                    failure:
                        item.action === 'recover'
                            ? `"${item.resourceKey}" could not take back ${item.kind} "${recordedName}" (${discordId}): it was bound elsewhere while this install was applying, so it belongs to that owner now and this journey has let go of it. Rebuild the plan and review it again.`
                            : `"${item.resourceKey}" could not adopt ${item.kind} "${recordedName}" (${discordId}): it was bound elsewhere while this install was applying. Rebuild the plan and review it again.`,
                };
            }
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
            action: settledState,
            name: item.name,
        });
    }

    return { applied };
}

/**
 * Apply one ticket type item: create it if absent, then record that this journey uses it.
 *
 * `create` and `adopt` both ask the ticket feature to create the type **only if absent**,
 * so what is recorded is what is true at apply time rather than at preview:
 *
 * - a type that appeared since the plan — another journey, the dashboard, the Discord
 *   modal — comes back as `exists` and is recorded `adopted`, untouched;
 * - a type the plan found that has gone since (deleted on the dashboard before this
 *   journey held it) is made again from the declaration and recorded `created`, rather
 *   than reported as "used as it is" for a type that is not there.
 *
 * A refusal fails this item in the ticket feature's words, and everything before it stays
 * applied.
 *
 * The row goes through `upsertBinding`, not the intent lifecycle: there is nothing in
 * Discord to half-make, and its `discordId` is the type's key, which no Discord ownership
 * fence must ever read as a snowflake. It is a second write after the provider's, so a
 * delete can still land between the two; the next install then finds the type gone and
 * plans it as made again.
 */
async function applyTicketType(
    guildId: string,
    journeyKey: string,
    item: PlanItem,
    declaration: ResourceDeclaration
): Promise<AppliedResource | { readonly failure: string }> {
    if (item.action !== 'create' && item.action !== 'adopt') {
        // `recover` is the only other mutation, and the plan never offers it for a type:
        // nothing can be half-made.
        return {
            failure: `"${item.resourceKey}" is a ticket type, which has nothing to ${item.action}. The plan is malformed — rebuild it.`,
        };
    }
    if (!declaration.ticketType) {
        // `validateJourneyDeclaration` requires the settings, so this is a declaration that
        // skipped it — named rather than created blank.
        return { failure: `Ticket type "${item.resourceKey}" has no settings to create it with.` };
    }

    let created: TicketTypeCreateOutcome;
    try {
        created = await requireTicketTypeProvider().createIfAbsent(
            guildId,
            item.resourceKey,
            declaration.defaultName,
            declaration.ticketType
        );
    } catch (error) {
        logStoreFailure(`creating the ticket type "${item.name}"`, error);
        return { failure: `Could not create the ticket type "${item.name}". Run install again.` };
    }

    let state: 'created' | 'adopted';
    let name: string;
    switch (created.outcome) {
        case 'created':
            state = 'created';
            name = declaration.defaultName.trim();
            break;
        case 'exists':
            // Already there: used as it is, never rewritten.
            state = 'adopted';
            name = created.label;
            break;
        case 'refused':
            return { failure: created.message };
    }

    try {
        await resourceBindingsRepo.upsertBinding({
            guildId,
            owner: journeyOwner(journeyKey),
            resourceKey: item.resourceKey,
            kind: 'ticketType',
            state,
            discordId: item.resourceKey,
            name,
        });
    } catch (error) {
        logStoreFailure(`recording the binding of ticket type "${name}"`, error);
        return {
            failure:
                state === 'created'
                    ? `The ticket type "${name}" was created, but recording that this journey installed it failed. Run install again; it finds the type and records it.`
                    : `Could not record that this journey uses the ticket type "${name}". Run install again.`,
        };
    }

    return { resourceKey: item.resourceKey, discordId: item.resourceKey, action: state, name };
}

/**
 * The name a guild object currently carries, or `undefined` if it is not there.
 *
 * Used only on the adopt path, where the object predates us and keeps whatever name it
 * already had. `undefined` falls back to the declared name at the call site — a binding
 * with no name at all is worse than one with an optimistic name, and the object has
 * just been proven to exist by `requireAdoptable`, so this returning nothing means the
 * cache is thin rather than that the object is gone.
 */
function liveNameOf(guild: Guild, kind: DiscordResourceKind, discordId: string): string | undefined {
    return kind === 'role'
        ? guild.roles.cache.get(discordId)?.name
        : guild.channels.cache.get(discordId)?.name;
}

/**
 * Re-check an adoption or a recovery at apply time.
 *
 * The plan verified this id when it was built, but a plan is reviewed by a human and
 * approval takes time — the channel can be deleted in between. Binding to it anyway
 * would record a resource that does not exist, which is exactly what the recreate
 * path then has to clean up.
 */
function requireAdoptable(guild: Guild, item: DiscordPlanItem): string {
    if (!item.discordId) {
        throw new Error(`a ${item.action} item carries no id`);
    }
    if (!existsInGuildAs(guild, item.kind, item.discordId)) {
        throw new Error(
            `the chosen ${item.kind} (${item.discordId}) no longer exists in this server, or is not a ${item.kind}. Rebuild the plan`
        );
    }
    return item.discordId;
}

/** A plan item for a Discord object — everything this file does past the ticket type branch. */
type DiscordPlanItem = PlanItem & { readonly kind: DiscordResourceKind };

interface CreateResourceInput {
    readonly guild: Guild;
    readonly item: DiscordPlanItem;
    readonly declaration: ResourceDeclaration;
    readonly idByKey: ReadonlyMap<string, string>;
    readonly permissionContext: PermissionIntentContext;
}

/**
 * Check everything a create needs, then hand back the one call that asks Discord.
 *
 * Split in two because the two halves fail differently. A throw from here has touched
 * nothing and its intent row can go; a throw from the returned call may have created
 * the object, and its intent row is the only record that it might exist.
 */
function prepareCreate({
    guild,
    item,
    declaration,
    idByKey,
    permissionContext,
}: CreateResourceInput): () => Promise<string> {
    const overwrites = declaration.permissions?.length
        ? compilePermissionIntents(
              resolveDeclaredRoles(declaration.permissions, idByKey),
              permissionContext
          )
        : undefined;

    // On the item's kind, which the ticket type branch has already narrowed; the plan
    // copied it from this declaration.
    switch (item.kind) {
        case 'role':
            return async () => {
                const role = await guild.roles.create({
                    name: item.name,
                    reason: `Provisioned for journey "${item.resourceKey}"`,
                });
                return role.id;
            };

        case 'category':
            return async () => {
                const category = await guild.channels.create({
                    name: item.name,
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: overwrites,
                    reason: `Provisioned for journey "${item.resourceKey}"`,
                });
                return category.id;
            };

        case 'textChannel': {
            const parent = resolveParent(guild, declaration, idByKey);
            return async () => {
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
            };
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

/**
 * The words of an error this module threw itself while preparing an item — a parent that is
 * not a category, an adopted id that no longer resolves — which are written for the operator.
 * Never for a database or Discord error: those go through {@link logStoreFailure} or
 * `describeDiscordError`, so a driver's own message never reaches a response.
 */
function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Log a failed write to the bot's own store, whose cause stays out of the report: it is
 * whatever the database driver said, which the operator cannot act on.
 */
function logStoreFailure(what: string, error: unknown): void {
    console.error(`[provisioning] Failed ${what}:`, error);
}
