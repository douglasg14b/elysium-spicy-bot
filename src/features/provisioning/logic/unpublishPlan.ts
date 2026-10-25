import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { journeyOwner, type ResourceBindingEntity } from '../data/resourceBindingsSchema';
import { describeOtherHolder, type GuildOwnership } from './bindingOwner';
import { describeChannel, existsInGuildAs, findInterruptedCreates } from './installPlan';
import { requireMessagePresence, type MessagePresence } from './lookupBoundMessage';
import {
    isDiscordResource,
    isDiscordResourceKind,
    nonDiscordResourceKind,
    type DiscordResourceKind,
    type ResourceKind,
} from './resourceDeclaration';

/**
 * What unpublish will do to one binding.
 *
 * `delete` removes the guild object and then the row; `forget` removes only the row,
 * because there is nothing in the guild to remove; `refuse` changes nothing and says
 * why.
 *
 * `refuse` is a first-class outcome rather than a thrown error for the same reason
 * `blocked` is in {@link InstallPlan}: an operator about to destroy part of their
 * server needs the whole picture, including the parts that cannot proceed. A preview
 * that can only be shown when every item is destroyable is useless for deciding.
 */
const UNPUBLISH_ACTIONS = ['delete', 'forget', 'refuse'] as const;
export type UnpublishAction = (typeof UNPUBLISH_ACTIONS)[number];

/**
 * Why a binding is being left alone.
 *
 * A closed union because each value has different copy behind it and because the two
 * that matter — `adopted` and `category-has-survivors` — are the promises this feature
 * rests on. An unrecognised reason has nothing to render.
 */
export const REFUSAL_REASONS = [
    'adopted',
    'category-has-survivors',
    'missing-permission',
    /** A binding state this code does not recognise. Refused rather than guessed at. */
    'unrecognised-state',
    /**
     * An `intended` row whose object an interrupted install may have created. Neither
     * deleted on a guess nor forgotten as "never created" — see `buildUnpublishPlan`.
     */
    'interrupted-create',
    /**
     * A message whose channel the bot could not read, so whether it is still posted is
     * unknown. Neither deleted nor forgotten on a guess: forgetting a message that is there
     * would leave it posted with nothing that knows it is ours.
     */
    'unreadable',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface UnpublishItem {
    /** The binding row this is about. Identifies the row to remove. */
    readonly bindingId: number;
    readonly resourceKey: string;
    readonly kind: ResourceKind;
    readonly name: string;
    readonly action: UnpublishAction;
    /** Set when the binding points at a guild object. Absent for an `intended` row. */
    readonly discordId?: string;
    /**
     * Set for a `message`: the channel it is posted in, which the applier deletes it from.
     * The binding's own record, since no declaration may be left to find the channel by.
     */
    readonly messageChannelId?: string;
    /** Set for `refuse`. */
    readonly refusalReason?: RefusalReason;
    /** Set for `refuse`: the whole story, in words an operator can act on. */
    readonly explanation?: string;
    /**
     * Set for `refuse` with `category-has-survivors`: what is still inside, by name.
     *
     * Named rather than counted. "3 channels would be destroyed" tells an operator
     * nothing they can check; the names are what let them go and look.
     */
    readonly survivors?: readonly string[];
}

export interface UnpublishPlan {
    readonly guildId: string;
    readonly journeyKey: string;
    readonly items: readonly UnpublishItem[];
}

export interface BuildUnpublishPlanInput {
    readonly guild: Guild;
    readonly journeyKey: string;
    /** This journey's own rows — what is being torn down. */
    readonly bindings: readonly ResourceBindingEntity[];
    /**
     * Every binding in the guild, every owner's, with journey names.
     *
     * Read for two fences, and neither can be answered from this journey's rows alone:
     * crash recovery must not pin an interrupted create on an object another owner
     * holds, and a `created` object another owner also uses is forgotten, never
     * deleted. Required, because omitting it is the unsafe direction for both.
     */
    readonly ownership: GuildOwnership;
    /**
     * Whether each message this journey posted is still there, keyed by resource key
     * (`readMessagePresence`, over `bindings`). Required when a posted message's row is met
     * — `previewUnpublish` always reads it — and such a row with no entry throws: deleting
     * or forgetting on a guess are both wrong.
     */
    readonly messagePresence?: ReadonlyMap<string, MessagePresence>;
}

const KIND_LABEL: Record<ResourceKind, string> = {
    category: 'category',
    textChannel: 'channel',
    role: 'role',
    ticketType: 'ticket type',
    message: 'message',
};

/**
 * Why uninstall forgets a ticket type rather than removing it — Douglas's rule
 * (2026-10-10): **uninstalling a journey never removes a setting it installed.** The
 * type may be what other flows, open tickets and the dashboard rely on.
 */
function ticketTypeStays(name: string): string {
    return `The ticket type **${name}** stays, and flows that use it keep working. Uninstalling a journey never removes settings; only this journey's record of it goes.`;
}

/**
 * Teardown order: children before parents.
 *
 * **`orderResourcesForApply` is not reusable here, and this is the difference.** That
 * function sorts {@link ResourceDeclaration}s, which carry a `parentKey`; unpublish
 * works from {@link ResourceBindingEntity} rows, which do not have one and outlive the
 * declaration they came from. There is frequently no declaration left to reverse — a
 * flow whose journey row was deleted still has live bindings, which is exactly the
 * case this feature exists to clean up.
 *
 * So the order is by kind instead. It is sound because containment comes in only two
 * fixed shapes: a text channel holds the messages posted in it, a category holds
 * channels, nothing holds a category, and nothing holds a role. Messages first empties
 * every channel, and channels then empty every category before it is considered; roles
 * are unordered with respect to all three because nothing contains them.
 *
 * The ordering is a convenience, not the safety property — {@link survivorsOf} reads
 * the *guild* for a category's children, so a category is refused on what is actually
 * inside it rather than on what this sort believed would be gone by then.
 */
const KIND_ORDER: Record<ResourceKind, number> = {
    // Before the text channel it is posted in: deleting the channel takes the message with
    // it, and a delete answered "Unknown Channel" is a gone message, not a deleted one.
    message: 0,
    textChannel: 1,
    role: 2,
    category: 3,
    // Only ever forgotten, so its place is immaterial; last keeps the deletions together.
    ticketType: 4,
};

/**
 * Everything still inside a category that this unpublish is not itself deleting.
 *
 * Read from the **guild**, never from the binding table. A channel somebody made by
 * hand inside our category has no binding at all, and it is precisely the case that
 * must block: Discord deletes a category's children along with it, so deleting this
 * category would destroy a channel nothing in our records has ever heard of.
 *
 * A child is a survivor unless it is itself being deleted in this same run. That
 * exception is what lets the ordinary case through — a journey that created a category
 * and three channels inside it unpublishes cleanly, because by the time the category is
 * considered every one of its children is in `deletingIds`.
 *
 * Note what is deliberately *not* an exception: an `adopted` binding inside our own
 * category. It is refused above, so it is not in `deletingIds`, so it survives here and
 * blocks the category. That is the cascade rule and the adoption promise agreeing —
 * the promise would be worthless if the category delete could route around it.
 *
 * Exported because `applyUnpublishPlan` re-runs it immediately before each category
 * delete. Containment is the one fact here that a human can change while they are
 * reading the preview — dragging a channel into the category takes a second — so
 * checking it only at plan time would leave the guard open for exactly as long as the
 * operator spends deciding.
 */
export function survivorsOf(
    guild: Guild,
    categoryId: string,
    deletingIds: ReadonlySet<string>
): readonly string[] {
    return guild.channels.cache
        .filter((channel) => channel.parentId === categoryId && !deletingIds.has(channel.id))
        .map((channel) => channel.name);
}

/**
 * Whether the bot can delete this kind of object at all.
 *
 * Checked in the plan rather than at apply, so a refusal is something the operator sees
 * *before* confirming. The install path sets the precedent (`collectBlockers`), and the
 * argument is sharper here: a teardown that gets halfway and then 403s has already
 * destroyed part of a server.
 *
 * Reported per item rather than as a plan-level blocker, because the two permissions
 * are independent — missing **Manage Roles** must not stop the channels being cleaned
 * up, and an operator who sees the whole plan can fix the permission and re-run.
 */
function permissionRefusal(guild: Guild, kind: DiscordResourceKind): string | undefined {
    const me = guild.members.me;
    if (!me) {
        return `The bot's own member is not cached for ${guild.name}, so its permissions cannot be verified. Refusing to delete anything that cannot be checked first.`;
    }

    if (kind === 'role') {
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return 'The bot lacks **Manage Roles**, so it cannot delete this role.';
        }
        return undefined;
    }

    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return `The bot lacks **Manage Channels**, so it cannot delete this ${KIND_LABEL[kind]}.`;
    }
    return undefined;
}

/**
 * Whether the bot's own role sits high enough to delete this one.
 *
 * Discord refuses to let a bot delete a role at or above its own highest, and the
 * failure arrives mid-apply as a bare 403. `@everyone` (position 0, id === guild id) is
 * refused for a different reason: it cannot be deleted by anybody, and a binding
 * pointing at it is a mistake worth naming rather than a 403 worth inheriting.
 */
function roleHierarchyRefusal(guild: Guild, discordId: string): string | undefined {
    const role = guild.roles.cache.get(discordId);
    if (!role) return undefined;

    if (role.id === guild.id) {
        return 'That binding points at the `@everyone` role, which cannot be deleted.';
    }

    const me = guild.members.me;
    if (me && role.position >= me.roles.highest.position) {
        return `The role **${role.name}** sits at or above the bot's highest role, so Discord will not let the bot delete it. Move the bot's role above it in Server Settings → Roles.`;
    }

    return undefined;
}

/**
 * Decide what unpublishing a journey's bindings would do, without doing any of it.
 *
 * Pure with respect to the guild: it reads caches and decides. That is what makes the
 * preview honest — the operator sees this, confirms it, and only then is anything
 * destroyed.
 *
 * The rule the whole feature rests on is the first branch below: **a binding may be
 * deleted from the guild only when `state === 'created'`.** `adopted` means the
 * operator told us that channel existed before we did, and adoption is the promise that
 * we will not touch their existing structure. There is deliberately no override — a
 * promise the operator can click through is a weaker promise than the one that was
 * made.
 */
export function buildUnpublishPlan(input: BuildUnpublishPlanInput): UnpublishPlan {
    const { guild, journeyKey, bindings, ownership } = input;
    const self = journeyOwner(journeyKey);

    const ordered = [...bindings].sort(
        (left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    );

    const items: UnpublishItem[] = [];
    /**
     * Every id any owner in the guild has bound — the same fence install's recovery
     * uses (`boundInGuild`). It was this journey's ids alone, which let a stale intent
     * here point at a same-named object another journey or the ticket system holds.
     */
    const guildBoundIds = new Set(
        ownership.bindings.flatMap((binding) => (binding.discordId ? [binding.discordId] : []))
    );
    /**
     * The guild objects this run has already decided to delete.
     *
     * Accumulated as the loop goes, which is why the kind ordering matters: every
     * channel has been decided before the first category is considered, so a category
     * whose children are all ours sees them all here.
     */
    const deletingIds = new Set<string>();

    for (const binding of ordered) {
        const base = {
            bindingId: binding.id,
            resourceKey: binding.resourceKey,
            kind: binding.kind,
            name: binding.name,
        } as const;

        /*
         * A ticket type, in whatever state: forgotten, never removed. Ahead of every other
         * branch — the adoption refusal would otherwise keep an adopted type's row forever,
         * and the delete path below has no business seeing a row whose `discordId` is a
         * key. The applier carries a `forget` out without asking anyone, the ticket
         * feature included.
         *
         * A message has its own branch too: its id names nothing in the guild's cache, and
         * whether it is still posted was read from Discord before this plan was built.
         */
        if (!isDiscordResource(binding)) {
            const kind = nonDiscordResourceKind(binding.kind);
            switch (kind) {
                case 'ticketType':
                    items.push({ ...base, action: 'forget', explanation: ticketTypeStays(binding.name) });
                    continue;
                case 'message':
                    items.push(planMessageTeardown(guild, binding, input.messagePresence));
                    continue;
                default: {
                    const unreachable: never = kind;
                    throw new Error(`Unhandled resource kind: ${String(unreachable)}`);
                }
            }
        }

        /*
         * An intended row with no id. Either its create never reached Discord, or it did
         * and the install stopped before recording it — the state crash recovery exists
         * for. Forgetting the row in the second case would erase the only thing tying
         * the object to this journey, and a re-install would then offer it for adoption.
         *
         * So the question install asks is asked here too. A candidate is **refused**, not
         * deleted: identity by name and creation time is good enough to *keep* a record,
         * and not good enough to destroy a channel and its history on the strength of it.
         * Install takes it back as created, after which uninstall deletes it normally.
         */
        if (binding.state === 'intended' && !binding.discordId) {
            const interrupted = findInterruptedCreates(guild, binding, guildBoundIds);
            if (interrupted.length > 0) {
                const noun = KIND_LABEL[binding.kind];
                items.push({
                    ...base,
                    discordId: interrupted.length === 1 ? interrupted[0] : undefined,
                    action: 'refuse',
                    refusalReason: 'interrupted-create',
                    explanation:
                        interrupted.length === 1
                            ? `An install of this journey stopped while creating **${binding.name}**, and a ${noun} of that name appeared moments later — most likely made by it. It is not deleted on a guess: run install to take it back, then uninstall removes it. Or delete it yourself.`
                            : `An install of this journey stopped while creating **${binding.name}**, and ${interrupted.length} ${noun}s of that name appeared moments later. None is deleted on a guess: delete the ones you do not want, then run install to take back the last.`,
                });
                continue;
            }
        }

        // An intended row that reached nothing: its create never landed, so there is no
        // object and dropping the row is the whole of it.
        if (binding.state === 'intended' || !binding.discordId) {
            items.push({
                ...base,
                action: 'forget',
                explanation: 'This was recorded but never created in the server, so only the record is removed.',
            });
            continue;
        }

        const discordId = binding.discordId;

        // The promise. Checked before anything else that could delete, and before the
        // existence check below, so that an adopted object reports *why* it is being
        // kept rather than being quietly forgotten if it happens to be gone.
        if (binding.state === 'adopted') {
            items.push({
                ...base,
                discordId,
                action: 'refuse',
                refusalReason: 'adopted',
                explanation: `This ${KIND_LABEL[binding.kind]} already existed and was adopted, not created by this journey. It will be left exactly where it is; only you can delete it.`,
            });
            continue;
        }

        /*
         * Everything past here deletes, so the permission to do so is stated
         * positively: only `created` proceeds.
         *
         * Written as a refusal of everything else rather than as `if (created)` with
         * the deletes after it, because those two differ on exactly one case — a state
         * this function has never heard of. A fourth entry in
         * `RESOURCE_BINDING_STATES`, or a row edited by hand, would otherwise reach the
         * delete at the bottom by falling through every branch that names a state.
         * Every other decision in this file fails closed; this was the one that failed
         * open, and it is the one where failing open means destroying something.
         */
        if (binding.state !== 'created') {
            items.push({
                ...base,
                discordId,
                action: 'refuse',
                refusalReason: 'unrecognised-state',
                explanation: `This binding is in the state "${binding.state}", which this teardown does not recognise. Refusing to delete anything it cannot account for.`,
            });
            continue;
        }

        // Already gone — deleted by hand, or by an earlier run that died between the
        // two steps. The desired state holds, so this is a `forget`, not a failure.
        if (!existsInGuildAs(guild, binding.kind, discordId)) {
            items.push({
                ...base,
                discordId,
                action: 'forget',
                explanation: `This ${KIND_LABEL[binding.kind]} is already gone from the server, so only the leftover record is removed.`,
            });
            continue;
        }

        /*
         * Another owner also holds it — tickets pointed at a category this journey made,
         * say, before one owner per object was enforced (the 2026-10-10 migration copied
         * such cross-claims as they were). Deleting it would pull it out from under that
         * owner, which would then quietly make a replacement.
         *
         * So only this journey's record goes, and the object stays standing. A `forget`
         * rather than a new refusal: removing the row is exactly what should happen, and
         * a refusal would leave this journey unable to uninstall over something it does
         * not need. Ahead of the permission check, because a forget needs no permission,
         * and ahead of `category-has-survivors`, so it holds for an empty category too.
         */
        const holder = describeOtherHolder(ownership, discordId, self);
        if (holder) {
            items.push({
                ...base,
                discordId,
                action: 'forget',
                explanation: `This ${KIND_LABEL[binding.kind]} is also used by ${holder}, so it is left standing; only this journey's record of it is removed.`,
            });
            continue;
        }

        const missingPermission = permissionRefusal(guild, binding.kind);
        if (missingPermission) {
            items.push({
                ...base,
                discordId,
                action: 'refuse',
                refusalReason: 'missing-permission',
                explanation: missingPermission,
            });
            continue;
        }

        if (binding.kind === 'role') {
            const hierarchy = roleHierarchyRefusal(guild, discordId);
            if (hierarchy) {
                items.push({
                    ...base,
                    discordId,
                    action: 'refuse',
                    refusalReason: 'missing-permission',
                    explanation: hierarchy,
                });
                continue;
            }
        }

        // The cascade. Discord deletes a category's children with it, so a category
        // holding anything we are not already deleting is refused outright — deleting
        // it would destroy an adopted channel, a hand-made one, or another journey's,
        // none of which this operation was given permission to touch.
        if (binding.kind === 'category') {
            const survivors = survivorsOf(guild, discordId, deletingIds);
            if (survivors.length > 0) {
                items.push({
                    ...base,
                    discordId,
                    action: 'refuse',
                    refusalReason: 'category-has-survivors',
                    survivors,
                    explanation: `Deleting the category **${binding.name}** would also delete everything inside it, and it still contains ${survivors.length === 1 ? 'a channel this unpublish is not removing' : `${survivors.length} channels this unpublish is not removing`}: ${survivors.map((survivor) => `**${survivor}**`).join(', ')}. Move them out, or delete them yourself, then run this again.`,
                });
                continue;
            }
        }

        deletingIds.add(discordId);
        items.push({ ...base, discordId, action: 'delete' });
    }

    return { guildId: guild.id, journeyKey, items };
}

/**
 * What uninstall does to one message this journey posted.
 *
 *  - **posted and there** → `delete`. The bot needs no permission to delete its own post;
 *  - **gone** — deleted by hand, or with its channel → `forget`;
 *  - **unreadable** → `refuse`, naming the channel and why. Deleting would be a guess, and
 *    forgetting a message that is still there would leave it posted with no record;
 *  - **any other state, or no id** → `refuse`. A message's row is only ever written
 *    `created` (`upsertPostedMessage`), so anything else is a row this code did not write,
 *    and it fails closed as the rest of this file does.
 *
 * No ownership fence: a message is never adopted and never held by a second owner.
 */
function planMessageTeardown(
    guild: Guild,
    binding: ResourceBindingEntity,
    messagePresence: ReadonlyMap<string, MessagePresence> | undefined
): UnpublishItem {
    const base = {
        bindingId: binding.id,
        resourceKey: binding.resourceKey,
        kind: binding.kind,
        name: binding.name,
    } as const;

    if (binding.state !== 'created' || !binding.discordId || !binding.messageChannelId) {
        return {
            ...base,
            ...(binding.discordId ? { discordId: binding.discordId } : {}),
            action: 'refuse',
            refusalReason: 'unrecognised-state',
            explanation: `This message's record is in the state "${binding.state}"${binding.messageChannelId ? '' : ' with no channel'}, which this teardown does not recognise. Refusing to delete anything it cannot account for.`,
        };
    }

    const presence = requireMessagePresence(messagePresence, binding, 'its teardown was planned');

    const posted = { ...base, discordId: binding.discordId, messageChannelId: binding.messageChannelId };
    if (typeof presence === 'object') {
        return {
            ...posted,
            action: 'refuse',
            refusalReason: 'unreadable',
            explanation: `Couldn't check whether it's still posted in ${describeChannel(guild, binding.messageChannelId)}: ${presence.unreadable}. Nothing is deleted or forgotten on a guess — sort out the bot's access, then run this again.`,
        };
    }
    switch (presence) {
        case 'gone':
            return {
                ...posted,
                action: 'forget',
                explanation: 'This message is already gone from its channel, so only the leftover record is removed.',
            };
        case 'found':
            return { ...posted, action: 'delete' };
        default: {
            const unreachable: never = presence;
            throw new Error(`Unhandled message presence: ${String(unreachable)}`);
        }
    }
}

/** What this plan would actually destroy in the guild. */
export function plannedDeletions(plan: UnpublishPlan): readonly UnpublishItem[] {
    return plan.items.filter((item) => item.action === 'delete');
}

/** What this plan refuses to touch, and why. The part of a preview that matters. */
export function plannedRefusals(plan: UnpublishPlan): readonly UnpublishItem[] {
    return plan.items.filter((item) => item.action === 'refuse');
}

/**
 * The settings this plan forgets and leaves exactly as they are — today, ticket types.
 *
 * Its own list because a preview has to show them: the type is real and in use, and an
 * inventory listing only deletions and refusals would call a journey holding nothing but a
 * ticket type "nothing live", and offer no uninstall — the one step that lets the type go.
 */
export function plannedSettingsKept(plan: UnpublishPlan): readonly UnpublishItem[] {
    return plan.items.filter((item) => item.action === 'forget' && isSettingKept(item.kind));
}

/** Whether a forgotten item of this kind leaves a setting behind: a ticket type does. */
function isSettingKept(kind: ResourceKind): boolean {
    if (isDiscordResourceKind(kind)) return false;

    const settingKind = nonDiscordResourceKind(kind);
    switch (settingKind) {
        case 'ticketType':
            return true;
        // A message is forgotten only once it is gone: nothing is left behind.
        case 'message':
            return false;
        default: {
            const unreachable: never = settingKind;
            throw new Error(`Unhandled resource kind: ${String(unreachable)}`);
        }
    }
}
