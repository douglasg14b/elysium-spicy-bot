import { PermissionFlagsBits, type Guild, type OverwriteResolvable } from 'discord.js';

/**
 * Who a permission intent is talking about.
 *
 * Two axes, not a list of named scenarios (PRD §5.7). A named set — `publicChannel`,
 * `staffOnly`, `verificationRoom` — grows one entry per journey, which is the engine
 * absorbing the use case. It also hides under-specification: "visible to everyone who
 * just joined" reads fine as a preset name and has no Discord representation at all,
 * whereas naming the axis forces the author to say *which role* they mean.
 *
 * `staff` and `subject` are **separate values on purpose**, and an earlier version of
 * this file got that wrong by fusing them into one `subjectAndStaff`. They have
 * different lifetimes:
 *
 *   - **staff** is a guild fact, known at install time. Nearly every server has staff
 *     roles, and "hidden from everyone, visible to staff" is an ordinary channel that
 *     has nothing to do with any particular member.
 *   - **subject** is a *run* fact — the member a resource is about — and does not
 *     exist while provisioning shared guild structure.
 *
 * Fused, a plain staff-only channel could not be declared without pasting literal
 * role ids into the journey (defeating portability), because the only audience naming
 * staff also demanded a subject. Split, each is usable on its own and a
 * ticket-shaped room is simply two intents.
 */
export const PERMISSION_AUDIENCES = ['everyone', 'roles', 'staff', 'subject'] as const;
export type PermissionAudience = (typeof PERMISSION_AUDIENCES)[number];

/**
 * What that audience may do.
 *
 * Deliberately coarse. These three cover every channel a journey has needed so far,
 * and each maps onto a defensible overwrite pair. A fourth value must earn its place
 * with a real call site rather than a hypothetical one.
 */
export const PERMISSION_ACCESS_LEVELS = ['hidden', 'readOnly', 'readWrite'] as const;
export type PermissionAccess = (typeof PERMISSION_ACCESS_LEVELS)[number];

/**
 * One row of the grid: this audience gets this access.
 *
 * A resource carries several, applied in order, so "hidden from everyone except
 * holders of role X" is two entries rather than a preset.
 */
export interface PermissionIntent {
    readonly audience: PermissionAudience;
    /** Role ids, required when `audience` is `roles` and meaningless otherwise. */
    readonly roleIds?: readonly string[];
    readonly access: PermissionAccess;
}

/** The run-time facts an intent needs that a declaration cannot know. */
export interface PermissionIntentContext {
    readonly guild: Guild;
    /** Who the resource is *about*, when the audience mentions a subject. */
    readonly subjectId?: string;
    /** Moderator roles, for the staff half of `subjectAndStaff`. */
    readonly staffRoleIds: readonly string[];
}

/**
 * Raised when an intent cannot be compiled.
 *
 * A distinct error rather than a silent skip: an unresolvable audience means the
 * channel would be created with *fewer* restrictions than the author asked for,
 * which is the one failure mode where degrading quietly is actively unsafe.
 */
export class PermissionIntentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PermissionIntentError';
    }
}

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const THREADS = PermissionFlagsBits.SendMessagesInThreads;
const REACT = PermissionFlagsBits.AddReactions;

interface AccessBits {
    readonly allow: bigint[];
    readonly deny: bigint[];
}

/**
 * The access half of the grid, as raw permission bits.
 *
 * `readOnly` denies the three ways a member can put content in a channel, not just
 * `SendMessages` — a thread reply and a reaction are both content, and denying only
 * the obvious one produces a channel that looks read-only and is not.
 */
function accessToBits(access: PermissionAccess): AccessBits {
    switch (access) {
        case 'hidden':
            return { allow: [], deny: [VIEW] };
        case 'readOnly':
            return { allow: [VIEW], deny: [SEND, THREADS, REACT] };
        case 'readWrite':
            return { allow: [VIEW, SEND, THREADS, REACT], deny: [] };
    }
}

/**
 * Resolve the audience half to the ids it names.
 *
 * Throws rather than returning an empty list, because "this audience matched nobody"
 * and "this audience is everyone" produce very different channels and must not be
 * confused at the call site.
 */
function audienceToIds(intent: PermissionIntent, context: PermissionIntentContext): string[] {
    switch (intent.audience) {
        case 'everyone':
            return [context.guild.roles.everyone.id];

        case 'roles': {
            const roleIds = intent.roleIds ?? [];
            if (roleIds.length === 0) {
                throw new PermissionIntentError(
                    'A `roles` permission intent names no roles. Declare at least one role id, or use the `everyone` audience.'
                );
            }
            const missing = roleIds.filter((roleId) => !context.guild.roles.cache.has(roleId));
            if (missing.length > 0) {
                throw new PermissionIntentError(
                    `Permission intent references role(s) that do not exist in ${context.guild.name}: ${missing.join(', ')}.`
                );
            }
            return [...roleIds];
        }

        case 'staff': {
            if (context.staffRoleIds.length === 0) {
                throw new PermissionIntentError(
                    'A `staff` permission intent needs at least one staff role, but none was supplied. Configure this guild\'s staff roles before installing a journey that grants them access.'
                );
            }
            /*
             * `@everyone` is refused as a staff role, and this is the last line of
             * defence rather than the only one — the settings API rejects it on the
             * way in too.
             *
             * Its id is the guild id, so it survives an existence check. Compiled, it
             * would key the same overwrite as the `everyone` audience, and because
             * later intents override earlier ones per id, the canonical "deny
             * everyone, then allow staff" would erase its own deny and publish the
             * channel while still reporting it as staff-only. Loud here beats a
             * silently public room.
             */
            if (context.staffRoleIds.includes(context.guild.roles.everyone.id)) {
                throw new PermissionIntentError(
                    '`@everyone` is configured as a staff role, which would make every staff-only resource public. Remove it from this guild\'s staff roles.'
                );
            }
            const missing = context.staffRoleIds.filter(
                (roleId) => !context.guild.roles.cache.has(roleId)
            );
            if (missing.length > 0) {
                throw new PermissionIntentError(
                    `Configured staff role(s) do not exist in ${context.guild.name}: ${missing.join(', ')}.`
                );
            }
            return [...context.staffRoleIds];
        }

        case 'subject': {
            if (!context.subjectId) {
                throw new PermissionIntentError(
                    'A `subject` permission intent names the member a resource is about, but none was supplied. A subject is a per-run fact and does not exist while provisioning shared guild structure.'
                );
            }
            return [context.subjectId];
        }
    }
}

/**
 * Compile a declared set of intents into Discord permission overwrites.
 *
 * Later intents win on a per-id basis, so the readable form — *deny everyone, then
 * allow staff* — behaves the way it reads. The bot itself is always granted view and
 * send last: a channel the bot cannot see is a channel it can never repair, and an
 * author denying `everyone` would otherwise lock the bot out of its own resource.
 */
export function compilePermissionIntents(
    intents: readonly PermissionIntent[],
    context: PermissionIntentContext
): OverwriteResolvable[] {
    const byId = new Map<string, { allow: Set<bigint>; deny: Set<bigint> }>();

    for (const intent of intents) {
        const bits = accessToBits(intent.access);
        for (const id of audienceToIds(intent, context)) {
            const entry = byId.get(id) ?? { allow: new Set<bigint>(), deny: new Set<bigint>() };
            // A later intent overrides an earlier one for the same id rather than
            // merging with it, so an allow cannot be shadowed by a stale deny.
            for (const bit of bits.allow) {
                entry.deny.delete(bit);
                entry.allow.add(bit);
            }
            for (const bit of bits.deny) {
                entry.allow.delete(bit);
                entry.deny.add(bit);
            }
            byId.set(id, entry);
        }
    }

    const botId = context.guild.members.me?.id;
    if (!botId) {
        throw new PermissionIntentError(
            `The bot's own member is not cached for ${context.guild.name}, so its access to a new resource cannot be guaranteed. Refusing to create a channel the bot may not be able to see.`
        );
    }
    byId.set(botId, {
        allow: new Set<bigint>([VIEW, SEND, THREADS, REACT]),
        deny: new Set<bigint>(),
    });

    return [...byId.entries()].map(([id, bits]) => ({
        id,
        allow: [...bits.allow],
        deny: [...bits.deny],
    }));
}
