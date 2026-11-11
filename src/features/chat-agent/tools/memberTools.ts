import { tool } from 'ai';
import { z } from 'zod';
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import type { Guild, GuildMember } from 'discord.js';
import { loadUserLevelProfile } from '../../leveling';
import type { ChatToolContext } from './chatToolContext';
import { pronounRoles } from './pronouns';
import { staffOnlyRefusal, type StaffOnlyRefusals } from './staffAccess';

const MEMBER_ROLE_LIMIT = 15;

/**
 * Why a level stays unsaid outside a staff channel. Levels and XP are talked about only where
 * every reader is staff, the owner's rule — but a member's own level is no secret from them,
 * so they are pointed at `/level`, which answers them privately.
 */
export const LEVEL_REFUSALS: StaffOnlyRefusals = {
    askerNotStaff: {
        reason: 'Levels and XP are only discussed in staff channels.',
        tellThem: "In character, no apology: levels aren't chatted about out here. /level shows them their own, privately. Say nothing of anyone's level or XP.",
    },
    readersNotStaff: {
        reason: "People who aren't staff can read this channel, and levels and XP are only discussed in staff channels.",
        tellThem: "In character, no apology: not where the members can read along — /level answers privately, or ask again in a channel only staff can see. Say nothing of anyone's level or XP.",
    },
    readersUnknown: {
        reason: "The bot is still loading this server's member list, so it can't yet tell whether only staff read this channel.",
        tellThem: "In character, no apology: you can't vouch for who's reading yet — /level answers privately, or ask again in a few minutes. Say nothing of anyone's level or XP.",
    },
};

/** One member, by name — or the asker, left out. Shared by every tool about a person. */
export const memberInput = z.object({
    member: z
        .string()
        .optional()
        .describe('Display name or username (with or without @). Leave out to mean the person asking.'),
});

/**
 * A member by id, `<@id>`, or name — exact display name or username first, then a
 * prefix — from the member cache, then Discord's member search. Undefined when nobody matches.
 */
export async function findMember(guild: Guild, query: string): Promise<GuildMember | undefined> {
    const trimmed = query.trim().replace(/^@/, '');
    const id = /^<@!?(\d+)>$/.exec(trimmed)?.[1] ?? (/^\d{15,22}$/.test(trimmed) ? trimmed : undefined);
    if (id) return guild.members.cache.get(id) ?? (await fetchMemberOrNobody(guild, id));

    const name = trimmed.toLowerCase();
    const cached = [...guild.members.cache.values()];
    const named = (member: GuildMember) => [member.displayName, member.user.username].map((value) => value.toLowerCase());
    const found =
        cached.find((member) => named(member).includes(name)) ??
        cached.find((member) => named(member).some((value) => value.startsWith(name)));
    if (found) return found;

    const searched = await guild.members.search({ query: trimmed, limit: 1 });
    return searched.first();
}

/** The member with `id`, or undefined when Discord says there is no such member or user. */
async function fetchMemberOrNobody(guild: Guild, id: string): Promise<GuildMember | undefined> {
    try {
        return await guild.members.fetch(id);
    } catch (error) {
        const isNobody =
            error instanceof DiscordAPIError &&
            (error.code === RESTJSONErrorCodes.UnknownMember || error.code === RESTJSONErrorCodes.UnknownUser);
        if (isNobody) return undefined;
        throw error;
    }
}

/** The member `query` names, or the asker when it is left out; undefined when nobody matches. */
export async function resolveMember(context: ChatToolContext, query: string | undefined): Promise<GuildMember | undefined> {
    return query ? findMember(context.guild, query) : context.asker;
}

export function getMemberInfoTool(context: ChatToolContext) {
    return tool({
        description:
            "Public facts about a member: display name, username, their pronouns (from their pronoun roles; empty when they have none), when they joined, their roles, whether they boost.",
        inputSchema: memberInput,
        execute: async ({ member: query }) => {
            const member = await resolveMember(context, query);
            if (!member) return { found: false as const, note: `Nobody here matches "${query}".` };
            const roles = [...member.roles.cache.values()]
                .filter((role) => role.id !== context.guild.id)
                .sort((left, right) => right.position - left.position)
                .slice(0, MEMBER_ROLE_LIMIT)
                .map((role) => role.name);
            return {
                found: true as const,
                displayName: member.displayName,
                username: member.user.username,
                isBot: member.user.bot,
                // Its own field: pronoun roles sit low, so the role list's cut would often drop them.
                pronouns: pronounRoles(member),
                joinedAt: member.joinedAt?.toISOString() ?? null,
                boostingSince: member.premiumSince?.toISOString() ?? null,
                roles,
            };
        },
    });
}

export function getUserLevelTool(context: ChatToolContext) {
    return tool({
        description:
            "A member's level and XP on this server, and how far they are from the next level. Only answers where every reader is staff; elsewhere it says why not and what to tell them.",
        inputSchema: memberInput,
        execute: async ({ member: query }) => {
            const refusal = staffOnlyRefusal(context, LEVEL_REFUSALS);
            if (refusal) return { answered: false as const, ...refusal };
            const member = await resolveMember(context, query);
            if (!member) return { found: false as const, note: `Nobody here matches "${query}".` };
            const profile = await loadUserLevelProfile(context.guild.id, member.id);
            return {
                found: true as const,
                displayName: member.displayName,
                level: profile.level,
                totalXp: profile.totalXp,
                xpToNextLevel: profile.xpToNextLevel,
                hasAnyActivity: profile.hasAnyActivity,
            };
        },
    });
}
