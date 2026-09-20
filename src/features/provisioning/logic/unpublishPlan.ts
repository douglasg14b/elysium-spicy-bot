import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import { existsInGuildAs } from './installPlan';
import type { ResourceKind } from './resourceDeclaration';

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
export const UNPUBLISH_ACTIONS = ['delete', 'forget', 'refuse'] as const;
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
    readonly bindings: readonly ResourceBindingEntity[];
}

const KIND_LABEL: Record<ResourceKind, string> = {
    category: 'category',
    textChannel: 'channel',
    role: 'role',
};

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
 * So the order is by kind instead. It is sound because Discord's containment is only
 * one level deep and only one shape: a category holds channels, nothing holds a
 * category, and nothing holds a role. Channels first empties every category before it
 * is considered; roles are unordered with respect to both because nothing contains
 * them.
 *
 * The ordering is a convenience, not the safety property — {@link survivorsOf} reads
 * the *guild* for a category's children, so a category is refused on what is actually
 * inside it rather than on what this sort believed would be gone by then.
 */
const KIND_ORDER: Record<ResourceKind, number> = {
    textChannel: 0,
    role: 1,
    category: 2,
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
 */
function survivorsOf(
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
function permissionRefusal(guild: Guild, kind: ResourceKind): string | undefined {
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
    const { guild, journeyKey, bindings } = input;

    const ordered = [...bindings].sort(
        (left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    );

    const items: UnpublishItem[] = [];
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

        // An intended row never reached the guild — there is no `discordId` and nothing
        // was ever created. Dropping the row is the whole of it.
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

/** What this plan would actually destroy in the guild. */
export function plannedDeletions(plan: UnpublishPlan): readonly UnpublishItem[] {
    return plan.items.filter((item) => item.action === 'delete');
}

/** What this plan refuses to touch, and why. The part of a preview that matters. */
export function plannedRefusals(plan: UnpublishPlan): readonly UnpublishItem[] {
    return plan.items.filter((item) => item.action === 'refuse');
}

/**
 * Whether a channel id is a category, for callers that hold only an id.
 *
 * Exported for the apply path, which re-reads the guild and must not assume the plan's
 * view of a snowflake is still current.
 */
export function isCategoryChannel(guild: Guild, discordId: string): boolean {
    return guild.channels.cache.get(discordId)?.type === ChannelType.GuildCategory;
}
