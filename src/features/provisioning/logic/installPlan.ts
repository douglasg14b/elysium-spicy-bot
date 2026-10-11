import { ChannelType, PermissionFlagsBits, SnowflakeUtil, type Guild } from 'discord.js';
import { journeyOwner, type ResourceBindingEntity } from '../data/resourceBindingsSchema';
import type { TicketTypeReading } from '../ticketTypeProvider';
import { describeOtherHolder, type GuildOwnership } from './bindingOwner';
import { parseDeclaredRoleReference } from './declaredRoleReference';
import { compilePermissionIntents, type PermissionIntentContext } from './permissionIntent';
import { normaliseResourceName } from './resourceName';
import {
    orderResourcesForApply,
    assertInstallable,
    isDiscordResource,
    validateJourneyDeclaration,
    type DiscordResourceKind,
    type JourneyDeclaration,
    type ResourceDeclaration,
    type ResourceKind,
} from './resourceDeclaration';

/**
 * What the applier will do to one resource.
 *
 * `reuse` is a binding that already resolves, `adopt` is an existing guild object the
 * operator chose, `create` makes a new one. `recover` records an object an interrupted
 * install created but never bound (see {@link findInterruptedCreates}). `blocked` is a
 * first-class outcome rather than a thrown error, because a plan that can only be shown
 * when it is entirely valid is useless for diagnosis — the operator needs to see the
 * whole picture, including the parts that cannot proceed.
 */
export const PLAN_ACTIONS = ['create', 'adopt', 'recover', 'reuse', 'blocked'] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

export interface PlanItem {
    readonly resourceKey: string;
    readonly kind: ResourceKind;
    readonly action: PlanAction;
    /** The name the resource will have, or already has. */
    readonly name: string;
    /**
     * Set for `adopt`, `recover` and `reuse`: the guild object this resolves to. For a
     * `ticketType` it is the type's key, which is what its binding row records.
     */
    readonly discordId?: string;
    /**
     * Why, in words an operator can act on: set for `blocked`, for a `create` replacing
     * something deleted, for a `recover`, and for a ticket type used as it is.
     */
    readonly reason?: string;
    /**
     * Something the operator should know that does not stop the apply. Today only the
     * ticket feature's "not fully set up yet" on a ticket type item.
     */
    readonly note?: string;
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

/**
 * A binding the operator has chosen for a resource key, from the install form.
 *
 * **Nothing supplies this today.** The dashboard's install-plan and install routes are
 * the only production callers of `previewInstall`, and both omit `choices` entirely —
 * the review dialog confirms a plan rather than editing one, so in practice every
 * adoption comes from the declaration's own `adoptDiscordId` and this type is
 * exercised only by tests.
 *
 * Kept, and ordered ahead of the declaration, because the two answer different
 * questions: the declaration is the author's standing preference, and this is the
 * decision taken *at one install*. When the dashboard grows an install form it is
 * where a per-run override lands. Until then, do not read the ordering below as a
 * live code path.
 */
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
    /**
     * Every id bound by **any** owner in this guild — every journey and the ticket
     * system — settled or not.
     *
     * Read only by crash recovery, which must never claim an object another owner
     * holds: if journey B created a same-named channel after journey A's install died,
     * recovering it under A would let A's uninstall delete B's channel. The same goes
     * for a ticket category, whose rows have lived in this table since 2026-10-10 and
     * so are fenced here with no code of their own. `previewInstall`
     * always supplies it, and test 12b in `provisioningDrift.integration.test.ts` fails if
     * it stops. **Optional for unit tests only**, which build plans with no other
     * journeys; omitting it in production is the unsafe direction, not a default.
     */
    readonly boundInGuild?: ReadonlySet<string>;
    /**
     * Every binding in the guild, with journey names, from the same read as
     * `boundInGuild` (`previewInstall`'s `loadGuildOwnership`).
     *
     * Read by the adopt fence: an object another owner holds — another journey, or the
     * ticket system — is `blocked`, naming the owner, because a category or channel
     * belongs to one owner (Douglas, 2026-10-10). Also names the owner when a name
     * collision's single match is held, so that block is not a dead end that says "adopt
     * it" about something that cannot be adopted.
     *
     * **Optional for unit tests only**, for the reason `boundInGuild` is; `previewInstall`
     * always supplies it.
     */
    readonly ownership?: GuildOwnership;
    /**
     * The guild's ticket types, read once through the ticket feature's provider.
     *
     * Required when the journey declares a ticket type — `previewInstall` reads it then
     * and only then — and a declared type with no reading throws rather than guessing,
     * since the plan cannot say create or reuse without it.
     */
    readonly ticketTypes?: TicketTypeReading;
}

/**
 * How far before an intent row's timestamp a guild object may claim to have been
 * created and still count as that intent's create.
 *
 * The intent's time comes from this host's clock and the object's from Discord's, so
 * the two can disagree by whatever the host's clock is off. Both directions of error
 * are safe: too tight and a genuine recovery falls back to the name-collision block
 * the operator resolves by hand; too loose and an object made by hand in the seconds
 * before a crash could be recovered in its place.
 */
const CLOCK_SKEW_ALLOWANCE_MS = 5_000;

/**
 * How long after an intent row's timestamp its create can still have landed.
 *
 * Without an upper bound, anything made at *any* point after an intent qualifies — and an
 * intent with nothing behind it is as common as one with something: a process that died
 * before the create was sent leaves the same row as one that died after. An operator who
 * then makes `#welcome` by hand days later would see it offered back as "an interrupted
 * install left this behind", settled as created, and deleted by the next uninstall.
 *
 * Ten minutes covers what can genuinely sit between writing the intent and Discord
 * creating the object: `@discordjs/rest` resending a timed-out request up to three times
 * at fifteen seconds each, plus rate-limit waits. Past it, the object falls back to the
 * name-collision block, which asks.
 */
const CREATE_LANDING_WINDOW_MS = 10 * 60_000;

const KIND_LABEL: Record<ResourceKind, string> = {
    category: 'category',
    textChannel: 'channel',
    role: 'role',
    ticketType: 'ticket type',
};

/** Why an existing ticket type is reused or recorded, never rewritten. */
const TICKET_TYPE_USED_AS_IT_IS = 'Already here, so it is used as it is — install never changes an existing ticket type.';

/**
 * Whether a snowflake resolves to something of the expected kind, in this guild.
 *
 * Lives here rather than in `applyInstallPlan.ts` (which imports from this module and
 * would make a cycle) because **both** need the same answer, and they were giving
 * different ones. The plan used to ask only `channels.cache.has(id)`, which is true
 * for a text channel handed to a resource declared as a `category`; the apply's
 * `requireAdoptable` checks the type and refuses. The result was a plan that showed
 * an applicable `adopt`, got approved, and then threw mid-apply with earlier
 * resources already created — the half-applied state the up-front validation exists
 * to prevent, reached by a route the validation could not see.
 */
export function existsInGuildAs(guild: Guild, kind: DiscordResourceKind, discordId: string): boolean {
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
function findByName(guild: Guild, kind: DiscordResourceKind, name: string): string[] {
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
 * The guild objects an interrupted install may have created for an `intended` row.
 *
 * An intent row is written *before* the create is sent (`applyInstallPlan`), so a
 * process that dies after Discord made the object and before the row was settled
 * leaves the row `intended` with no id, and the object untracked. A snowflake encodes
 * the moment its object was created, which makes the object recognisable without an
 * audit-log read or any marker of our own: it has the intent's kind and name, it was
 * created within {@link CREATE_LANDING_WINDOW_MS} of the intent being written, and
 * nothing else in the guild has bound it.
 *
 * Returns every candidate, for the same reason {@link findByName} does. One is a
 * recovery; several is a question for the operator, never a guess. Uninstall asks the
 * same question, so an interrupted create is never forgotten as "never created".
 */
export function findInterruptedCreates(
    guild: Guild,
    intent: Pick<ResourceBindingEntity, 'name' | 'createdAt'> & { readonly kind: DiscordResourceKind },
    excluded: ReadonlySet<string>
): string[] {
    const intendedAt = intent.createdAt.getTime();
    const notBefore = intendedAt - CLOCK_SKEW_ALLOWANCE_MS;
    const notAfter = intendedAt + CREATE_LANDING_WINDOW_MS;

    return findByName(guild, intent.kind, intent.name).filter((discordId) => {
        if (excluded.has(discordId)) return false;
        const createdAt = SnowflakeUtil.timestampFrom(discordId);
        return createdAt >= notBefore && createdAt <= notAfter;
    });
}

/**
 * Dry-run a resource's permission intents, returning the problem if there is one.
 *
 * Compiling is the check — there is no separate validator to drift out of step with
 * the thing that actually runs at apply time.
 *
 * References to roles this journey **declares** are dropped before compiling, because
 * at plan time those roles do not exist and `audienceToIds` would report every one of
 * them as missing — blocking a plan that is in fact perfectly applicable.
 *
 * Dropping is sound *here and only here* because this function answers "is this model
 * satisfiable", not "what are the overwrites". Everything else it checks still runs:
 * a `roles` intent whose ids are all declared keeps a non-empty list and still has to
 * name a resolvable audience, a plain snowflake naming an absent role still fails, and
 * `staff` and `subject` are unaffected. `validateJourneyDeclaration` has already
 * refused any reference to a key the journey does not declare, and
 * `orderResourcesForApply` guarantees the role is created first — so a reference
 * reaching this point is one the apply will resolve.
 *
 * An intent left with *no* ids after dropping would be a false failure, so it is
 * dropped whole rather than compiled as an empty `roles` list.
 */
function describePermissionFailure(
    permissions: NonNullable<ResourceDeclaration['permissions']>,
    context: PermissionIntentContext
): string | undefined {
    const previewable = permissions.flatMap((intent) => {
        if (!intent.roleIds?.length) return [intent];

        const existing = intent.roleIds.filter((roleId) => !parseDeclaredRoleReference(roleId));
        if (existing.length === intent.roleIds.length) return [intent];
        return existing.length > 0 ? [{ ...intent, roleIds: existing }] : [];
    });

    try {
        compilePermissionIntents(previewable, context);
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
    const { guild, journey, existingBindings, choices = {}, permissionContext, boundInGuild, ownership } = input;
    const self = journeyOwner(journey.journeyKey);
    const heldElsewhere = (discordId: string): string | undefined =>
        ownership ? describeOtherHolder(ownership, discordId, self) : undefined;
    const requireTicketTypes = (): TicketTypeReading => {
        if (!input.ticketTypes) {
            throw new Error(
                `Journey "${journey.journeyKey}" declares a ticket type, but its plan was built without reading the server's ticket types.`
            );
        }
        return input.ticketTypes;
    };

    // Coherence, then installability. The emptiness check lives here rather than in
    // `validateJourneyDeclaration` because storing an empty journey is legitimate —
    // grouping two flows that declare nothing yet creates exactly one — and only an
    // install has nothing to do with it.
    validateJourneyDeclaration(journey);
    assertInstallable(journey);

    const bindingByKey = new Map(
        existingBindings.map((binding) => [binding.resourceKey, binding] as const)
    );
    const alreadyBound = new Set(boundInGuild);
    for (const binding of existingBindings) {
        // Discord objects only: a ticket type row's id is a type key.
        if (binding.discordId && isDiscordResource(binding)) alreadyBound.add(binding.discordId);
    }
    const items: PlanItem[] = [];

    for (const resource of orderResourcesForApply(journey.resources)) {
        const choice = choices[resource.key];
        // The name Discord will store, so the binding records what the guild holds, a
        // later drift check compares like with like, and the name match below finds an
        // existing `#staff-chat` for a declared `Staff Chat` instead of planning a
        // duplicate beside it.
        const name = normaliseResourceName(
            resource.kind,
            choice?.name?.trim() || resource.defaultName
        );
        const base = {
            resourceKey: resource.key,
            kind: resource.kind,
            name,
            parentKey: resource.parentKey,
        } as const;

        // A ticket type is not a Discord object, so none of what follows — permissions,
        // the guild cache, crash recovery, name matching, ownership — applies to it.
        // Branched here, before any of it, rather than threaded through each.
        if (!isDiscordResource(resource)) {
            items.push(planTicketType(base, bindingByKey.get(resource.key), requireTicketTypes()));
            continue;
        }

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
        // A ticket type row under a key now declared as a channel, category or role names
        // nothing in Discord, so it is planned as if absent. The apply rebinds that row to
        // what it creates or adopts, writing the new kind — it is never left labelled a
        // ticket type, which uninstall would only forget.
        const bound = bindingByKey.get(resource.key);
        const existing = bound && isDiscordResource(bound) ? bound : undefined;
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

        // The install form's choice first, then what the author declared. Both mean
        // "adopt this", and they are resolved in that order so an operator can
        // override a standing preference for one install without editing the flow.
        const adoptDiscordId = choice?.adoptDiscordId ?? resource.adoptDiscordId;

        // An intent with no id: an earlier install got as far as recording it, and may
        // or may not have created the object before it stopped. Checked before the
        // name match below, which would otherwise offer the object up for *adoption* —
        // and an adopted resource is one uninstall never deletes, so a channel this
        // bot made would become the operator's to clean up forever.
        //
        // Not when the operator has named an object to adopt: that is a statement that
        // the thing predates the journey, and recovering it would record it as created
        // and hand it to uninstall. And not when the resource's kind has changed since
        // the intent was written — the object found would be of the old kind, and the
        // apply's re-check would refuse it mid-install.
        if (existing?.state === 'intended' && !adoptDiscordId && existing.kind === resource.kind) {
            const interrupted = findInterruptedCreates(
                guild,
                { kind: resource.kind, name: existing.name, createdAt: existing.createdAt },
                alreadyBound
            );
            if (interrupted.length === 1) {
                items.push({
                    ...base,
                    action: 'recover',
                    discordId: interrupted[0],
                    reason: `An earlier install created this ${KIND_LABEL[resource.kind]} and stopped before recording it. This records it as made by this journey.`,
                });
                continue;
            }
            if (interrupted.length > 1) {
                items.push({
                    ...base,
                    action: 'blocked',
                    reason: `An earlier install stopped while creating "${existing.name}", and ${interrupted.length} ${KIND_LABEL[resource.kind]}s of that name have been made since. Delete the extras, then run install again.`,
                });
                continue;
            }
            // Nothing matches: the install stopped before the create reached Discord.
            // Falls through, and the apply reuses this same intent row.
        }

        if (adoptDiscordId) {
            if (!existsInGuildAs(guild, resource.kind, adoptDiscordId)) {
                items.push({
                    ...base,
                    // Blocked rather than quietly created. A declaration naming an id is
                    // an operator saying the thing already exists; if it does not,
                    // creating one anyway installs a duplicate of whatever they meant.
                    action: 'blocked',
                    reason: `The chosen ${KIND_LABEL[resource.kind]} (${adoptDiscordId}) does not exist in this server, or is not a ${KIND_LABEL[resource.kind]}.`,
                });
                continue;
            }

            // One owner per object. Adopting what another journey or the ticket system
            // holds would leave two owners each believing it theirs to rename, repair
            // and — if either created it — delete.
            const holder = heldElsewhere(adoptDiscordId);
            if (holder) {
                items.push({
                    ...base,
                    action: 'blocked',
                    discordId: adoptDiscordId,
                    reason: `The chosen ${KIND_LABEL[resource.kind]} already belongs to ${holder}, so this journey can't adopt it. Pick another, or let this journey create its own.`,
                });
                continue;
            }

            items.push({ ...base, action: 'adopt', discordId: adoptDiscordId });
            continue;
        }

        // No binding and no explicit choice. Look for a name match to *report*, never
        // to apply: auto-binding on a name collision is how an install silently
        // takes over a channel the operator did not mean to give it.
        const matches = findByName(guild, resource.kind, name);
        if (matches.length === 1) {
            // A match another owner holds cannot be adopted either, so the usual advice
            // would send the operator to a choice that is not there.
            const holder = heldElsewhere(matches[0]);
            items.push({
                ...base,
                action: 'blocked',
                discordId: matches[0],
                reason: holder
                    ? `A ${KIND_LABEL[resource.kind]} named "${name}" already exists, and it belongs to ${holder}, so it can't be adopted here. Give this one a different name.`
                    : `A ${KIND_LABEL[resource.kind]} named "${name}" already exists. Choose whether to adopt it or create a new one under a different name.`,
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

/**
 * The plan item for one declared ticket type.
 *
 * Decided by the key alone, against the server's ticket types as the provider read them:
 *
 *  - no ticket config → `blocked`, in the ticket feature's own words. The one case where
 *    creating a type cannot succeed, and one blocked item stops the whole install.
 *  - a type of this key exists → `reuse` when this journey already recorded it, otherwise
 *    `adopt`, which is an action only so that apply writes the row. Either way it is used
 *    exactly as it stands, label and all: install never changes an existing type.
 *  - none exists → `create`, saying so when this journey's row shows it was there before.
 *
 * The provider's "not fully set up" note rides on every item and blocks nothing.
 *
 * A row under this key of another kind is a resource whose kind changed after install.
 * Writing the type's row over it would forget a channel or role this journey may have
 * created, leaving it for nobody to remove, so that is blocked instead.
 */
function planTicketType(
    base: Pick<PlanItem, 'resourceKey' | 'kind' | 'name'>,
    existing: ResourceBindingEntity | undefined,
    reading: TicketTypeReading
): PlanItem {
    if (reading.status === 'no-config') {
        return { ...base, action: 'blocked', reason: reading.blockedReason };
    }

    const note = reading.notReadyNote ? { note: reading.notReadyNote } : {};

    if (existing && existing.kind !== base.kind) {
        return {
            ...base,
            action: 'blocked',
            reason: `This journey still holds a ${KIND_LABEL[existing.kind]} under the key "${base.resourceKey}". Uninstall the journey, or give the ticket type another key.`,
        };
    }

    const recorded = Boolean(existing?.discordId) && existing?.state !== 'intended';
    const present = reading.types.get(base.resourceKey);

    if (present) {
        return {
            ...base,
            name: present.label,
            action: recorded ? 'reuse' : 'adopt',
            discordId: base.resourceKey,
            reason: TICKET_TYPE_USED_AS_IT_IS,
            ...note,
        };
    }

    return recorded
        ? {
              ...base,
              action: 'create',
              reason: 'The ticket type this journey installed has been removed from the ticket settings; it will be made again.',
              ...note,
          }
        : { ...base, action: 'create', ...note };
}

/** Whether a plan can be applied at all. A blocked item stops the whole apply. */
export function isPlanApplicable(plan: InstallPlan): boolean {
    return plan.blockers.length === 0 && plan.items.every((item) => item.action !== 'blocked');
}

/** The items an apply would actually act on, in parent-before-child order. */
export function planMutations(plan: InstallPlan): readonly PlanItem[] {
    return plan.items.filter(
        (item) => item.action === 'create' || item.action === 'adopt' || item.action === 'recover'
    );
}
