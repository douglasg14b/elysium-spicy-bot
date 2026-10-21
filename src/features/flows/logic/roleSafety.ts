import { PermissionFlagsBits, type Guild, type Role } from 'discord.js';

/**
 * Which roles a flow may give to or take from a member — the one statement of it, for
 * save-time validation (`guildReferences.ts`) and the blocks' own `run` alike. In `logic/`
 * rather than beside the blocks, because it names Discord permissions and that is not the
 * block contract's vocabulary.
 *
 * A flow acts with the bot's permissions on behalf of whoever sets it off, and a button
 * anyone can press is a button anyone can press. The bot's own top role is Discord's only
 * limit, so without this a flow could hand out Administrator to the whole server, or strip
 * a moderator's powers the moment they press the wrong thing. These roles are changed by
 * a person, by hand, or not at all.
 *
 * Which fields this applies to is not decided here: a block declares that it changes roles
 * through `capabilities: ['manageRoles']`, and save-time validation reads every role picker
 * on such a block as a role it hands out or takes away.
 */

/** A permission that makes a role one no flow may change, with how a sentence names it. */
interface PrivilegedPermission {
    readonly flag: bigint;
    readonly label: string;
}

/** The permissions a role must not carry for a flow to give or take it, in the order a sentence names them. */
export const PRIVILEGED_ROLE_PERMISSIONS: readonly PrivilegedPermission[] = [
    { flag: PermissionFlagsBits.Administrator, label: 'Administrator' },
    { flag: PermissionFlagsBits.ManageGuild, label: 'Manage Server' },
    { flag: PermissionFlagsBits.ManageRoles, label: 'Manage Roles' },
    { flag: PermissionFlagsBits.KickMembers, label: 'Kick Members' },
    { flag: PermissionFlagsBits.BanMembers, label: 'Ban Members' },
];

/**
 * Why a flow may not give this role to a member or take it from one, or `undefined` when
 * it may.
 *
 * Refuses `@everyone` (every member holds it, and Discord will not move it), a managed role
 * (a bot's own role, a booster or integration role — whatever manages it decides who holds
 * it), and any role carrying one of {@link PRIVILEGED_ROLE_PERMISSIONS}. The permissions are
 * read off the role itself, so a role somebody later grants Administrator is refused from
 * then on, on the next save and the next run alike.
 */
export function roleChangeRefusal(guild: Guild, role: Role): string | undefined {
    if (role.id === guild.id) {
        return "@everyone isn't a role a flow can hand out or take away — everybody already has it.";
    }
    if (role.managed) {
        return `@${role.name} belongs to a bot or an integration, so that's who decides who holds it — not a flow.`;
    }

    const carried = PRIVILEGED_ROLE_PERMISSIONS.filter((permission) => role.permissions.has(permission.flag, false));
    if (carried.length > 0) {
        const named = carried.map((permission) => permission.label).join(', ');
        return (
            `@${role.name} carries ${named}. A flow won't hand out or take away a role with that much power — ` +
            'pick a role without it, or change it by hand.'
        );
    }

    return undefined;
}

/** A role a flow may change, or the sentence a run fails with when it may not. */
export type ChangeableRole =
    | { readonly ok: true; readonly role: Role }
    | { readonly ok: false; readonly error: string };

/**
 * The role a block is about to give or take, resolved from the run's own guild — or why it
 * must not.
 *
 * **The guild's cache only, never a fetch.** The Guilds intent keeps every role of a guild
 * cached, so a miss is a role that is not in this server — deleted since the flow was saved,
 * or an id that never belonged here. Asking Discord would not change the answer.
 *
 * For the block's `run`, which returns the error as its `fail` outcome without calling
 * Discord at all.
 */
export function changeableRole(guild: Guild, roleId: string): ChangeableRole {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
        return { ok: false, error: `Role ${roleId} isn't a role in this server any more. Pick another on the canvas.` };
    }

    const refusal = roleChangeRefusal(guild, role);
    return refusal ? { ok: false, error: refusal } : { ok: true, role };
}
