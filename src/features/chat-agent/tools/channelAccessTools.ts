import { tool } from 'ai';
import { z } from 'zod';
import { ChannelType, OverwriteType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import type { GuildBasedChannel, GuildMember, NonThreadGuildBasedChannel, Role } from 'discord.js';
import { describeWhere } from './channelHistoryTools';
import { findAdmittedChannel, parseMessageLink } from './channelReferences';
import type { ChatToolContext } from './chatToolContext';
import { isStaffMember, staffOnlyRefusal } from './staffAccess';
import { everyoneCanSee, memberCanSee } from './visibleChannels';

/** People listed by name; a channel with more says how many were left out. */
export const ACCESS_MEMBER_LIMIT = 50;

/**
 * What a member holding `role` and no other may do in `channel`: @everyone's permissions and
 * the role's, then the channel's overwrites for @everyone and for the role — Discord's own
 * order. An Administrator role may do everything, overwrites or not: `has` counts it as every permission.
 */
function permissionsOfRole(channel: NonThreadGuildBasedChannel, role: Role): PermissionsBitField {
    const everyone = channel.guild.roles.everyone;
    const permissions = new PermissionsBitField([everyone.permissions, role.permissions]);
    const everyoneOverwrite = channel.permissionOverwrites.cache.get(everyone.id);
    const roleOverwrite = channel.permissionOverwrites.cache.get(role.id);
    return permissions
        .remove(everyoneOverwrite?.deny ?? 0n)
        .add(everyoneOverwrite?.allow ?? 0n)
        .remove(roleOverwrite?.deny ?? 0n)
        .add(roleOverwrite?.allow ?? 0n);
}

/** The channel whose permissions decide who sees `channel`: a thread's parent, else the channel itself. */
function governingChannel(channel: GuildBasedChannel): NonThreadGuildBasedChannel | null {
    return channel.isThread() ? channel.parent : channel;
}

/** What a role must allow to see `channel`: View Channel, and for a private thread — which takes membership otherwise — Manage Threads too. */
function seeingTakes(channel: GuildBasedChannel): bigint[] {
    return channel.type === ChannelType.PrivateThread
        ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageThreads]
        : [PermissionFlagsBits.ViewChannel];
}

type RoleAccess = {
    readonly role: string;
    readonly staff?: true;
    /** Administrator: sees every channel, whatever the channel says. */
    readonly administrator?: true;
};

function describeRole(role: Role, staffRoleIds: readonly string[]): RoleAccess {
    return {
        role: `@${role.name}`,
        ...(staffRoleIds.includes(role.id) || role.permissions.has(PermissionFlagsBits.Administrator) ? { staff: true as const } : {}),
        ...(role.permissions.has(PermissionFlagsBits.Administrator) ? { administrator: true as const } : {}),
    };
}

type MemberAccess = {
    readonly name: string;
    readonly staff?: true;
    /** Let in by name rather than by a role: the channel's own permission for them, or a private thread's membership. */
    readonly addedDirectly?: true;
};

function addedDirectly(member: GuildMember, channel: GuildBasedChannel, governing: NonThreadGuildBasedChannel): boolean {
    if (channel.type === ChannelType.PrivateThread) return channel.members.cache.has(member.id);
    const overwrite = governing.permissionOverwrites.cache.get(member.id);
    return overwrite?.type === OverwriteType.Member && overwrite.allow.has(PermissionFlagsBits.ViewChannel);
}

/**
 * Who can see a channel today, worked out from its permissions — never from who has posted
 * there, which says nothing about who can still read it. For staff only, where every reader
 * is staff (`staffOnlyRefusal`), and only about channels every reader can see themselves.
 *
 * The roles are each role's own reach (as if it were a member's only role); the people are
 * the member cache, which the gate has already found whole, held to `memberCanSee`. A thread
 * answers by its parent's permissions, and a private thread by its members and whoever may
 * manage threads.
 */
export function getChannelAccessTool(context: ChatToolContext) {
    return tool({
        description: `For staff: who can see a channel, thread or ticket channel on this server today, from its permissions — the roles that let someone in, and every person who can see it (up to ${ACCESS_MEMBER_LIMIT} by name), each marked staff or not. Ask it whenever the question is who can see or is in a channel, or whether it is staff-only; never work that out from who has posted there. Give a channel (#name, mention, id or a message link), or leave it out for this one. It says who may hear the answer.`,
        inputSchema: z.object({
            channel: z.string().min(1).optional().describe('#name, <#id>, an id, or a Discord link. Leave out for the channel you are in.'),
        }),
        execute: async ({ channel: query }) => {
            const refusal = staffOnlyRefusal(context);
            if (refusal) return { found: false as const, ...refusal };
            const link = query ? parseMessageLink(query) : null;
            if (link && link.guildId !== context.guild.id) return { found: false as const, note: 'That link is to another server.' };

            const admits = (candidate: GuildBasedChannel | undefined) =>
                candidate && everyoneCanSee(context.viewers, candidate) ? candidate : undefined;
            const channel = query ? await findAdmittedChannel(context, query, admits) : context.channel;
            const governing = channel && governingChannel(channel);
            if (!channel || !governing) return { found: false as const, note: `No channel matching "${query}" that everyone here can see.` };

            const takes = seeingTakes(channel);
            const roles = [...context.guild.roles.cache.values()]
                .filter((role) => role.id !== context.guild.id && !role.tags?.botId)
                .sort((left, right) => right.position - left.position);
            const roleSees = (role: Role) => permissionsOfRole(governing, role).has(takes);
            const openToEveryone = roleSees(context.guild.roles.everyone);

            const people = [...context.guild.members.cache.values()]
                .filter((member) => !member.user.bot && memberCanSee(member, channel))
                .map((member) => ({ member, staff: isStaffMember(member, context.staffRoleIds) }))
                .sort((left, right) => Number(right.staff) - Number(left.staff) || left.member.displayName.localeCompare(right.member.displayName));
            const members: MemberAccess[] = people.slice(0, ACCESS_MEMBER_LIMIT).map(({ member, staff }) => ({
                name: `@${member.displayName}`,
                ...(staff ? { staff: true as const } : {}),
                ...(addedDirectly(member, channel, governing) ? { addedDirectly: true as const } : {}),
            }));

            return {
                found: true as const,
                ...describeWhere(channel),
                ...(channel.type === ChannelType.PrivateThread
                    ? { note: 'A private thread: its members can see it, and so can anyone whose roles let them manage threads in its channel.' }
                    : {}),
                openToEveryone,
                // Open to @everyone, every role sees it unless the channel shuts one out; else only the roles that let someone in.
                ...(openToEveryone
                    ? { rolesShutOut: roles.filter((role) => !roleSees(role)).map((role) => describeRole(role, context.staffRoleIds)) }
                    : { roles: roles.filter(roleSees).map((role) => describeRole(role, context.staffRoleIds)) }),
                people: people.length,
                staff: people.filter((person) => person.staff).length,
                members,
                ...(people.length > ACCESS_MEMBER_LIMIT ? { notListed: people.length - ACCESS_MEMBER_LIMIT } : {}),
            };
        },
    });
}
