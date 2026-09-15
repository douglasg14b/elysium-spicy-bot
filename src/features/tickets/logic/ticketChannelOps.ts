import { ChannelType, Guild, PermissionsBitField, TextChannel, type OverwriteResolvable } from 'discord.js';
import { fail, ok, type Result } from '../../../shared';
import type { ConfiguredTicketingConfig } from '../data/ticketingSchema';
import type { TicketEntity, TicketType } from '../data/ticketsSchema';
import { findOrCreateModeratorCategory } from './ticketChannelPermissions';
import { buildTicketChannelNameForType, getTicketTypeDefinition, toPermissionOverwrite } from './ticketTypes';

/**
 * The Discord half of a ticket: creating the channel and moving it between
 * categories.
 *
 * Split from `ticketService` so the decisions stay callable without a gateway.
 * This module knows how to make Discord reflect a ticket; it never decides
 * whether a transition is allowed — that is the service's job, and it has
 * already run by the time anything here is called.
 *
 * Takes a `Guild` rather than an interaction, which is the change that makes a
 * flow able to open a ticket at all. The path this replaces took a
 * `ModalSubmitInteraction` and read the guild, the opener and the member out of
 * it, so it could only ever be reached by a human pressing something.
 */

interface BuildOverwritesParams {
    readonly guild: Guild;
    readonly type: TicketType;
    readonly subjectId: string;
    readonly openerId: string | null;
    readonly moderationRoleIds: string[];
}

/**
 * Turns a type's declared permission model into Discord overwrites.
 *
 * Every participant's flags come from the type definition, including the
 * `@everyone` denial, so the same arrangement is produced whether a channel is
 * being created, closed or reopened. The old code derived a *different*
 * arrangement at each of those three sites and they had already drifted apart.
 */
function buildOverwrites({
    guild,
    type,
    subjectId,
    openerId,
    moderationRoleIds,
}: BuildOverwritesParams): OverwriteResolvable[] {
    const { permissions } = getTicketTypeDefinition(type);
    const me = guild.members.me;

    const overwrites: OverwriteResolvable[] = [
        {
            id: guild.roles.everyone.id,
            deny: [PermissionsBitField.Flags.ViewChannel],
        },
        { id: subjectId, ...toPermissionOverwrite(permissions.subject) },
    ];

    // Only when a human filed it, and never as a duplicate of the subject's own
    // entry — a moderator can open a ticket about themselves, and two overwrites
    // for one id is a Discord API error rather than a merge.
    if (openerId && openerId !== subjectId) {
        overwrites.push({ id: openerId, ...toPermissionOverwrite(permissions.opener) });
    }

    if (me) {
        overwrites.push({
            id: me.id,
            allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
                PermissionsBitField.Flags.ManageMessages,
            ],
        });
    }

    for (const roleId of moderationRoleIds) {
        if (guild.roles.cache.has(roleId)) {
            overwrites.push({ id: roleId, ...toPermissionOverwrite(permissions.staff) });
        }
    }

    return overwrites;
}

interface CreateChannelParams {
    readonly guild: Guild;
    readonly ticket: TicketEntity;
    readonly config: ConfiguredTicketingConfig;
    readonly subjectName: string;
    readonly openerName: string | null;
}

/**
 * Creates the channel for an already-opened ticket.
 *
 * Every overwrite is supplied to `channels.create` in one call rather than
 * created and then amended per role. The old path made the channel and then
 * looped `permissionOverwrites.create` once per moderation role — one API
 * round trip each, with a window where the channel existed and staff could not
 * see it.
 */
export async function createTicketChannelForTicket({
    guild,
    ticket,
    config,
    subjectName,
    openerName,
}: CreateChannelParams): Promise<Result<TextChannel>> {
    const definition = getTicketTypeDefinition(ticket.type);

    // A ticket that auto-claims on open belongs in the claimed category from the
    // start; one a flow opened is genuinely unclaimed and belongs in the open one.
    const categoryName = definition.autoClaimOnOpen
        ? config.claimedTicketCategoryName
        : config.supportTicketCategoryName;

    const categoryResult = await findOrCreateModeratorCategory({
        guild,
        categoryName,
        moderationRoleIds: config.moderationRoles,
    });
    if (!categoryResult.ok) return categoryResult;
    const category = categoryResult.value;

    const me = guild.members.me;
    if (!me) return fail('Bot member is not resolvable in this guild');

    const parentPermissions = category.permissionsFor(me);
    if (!parentPermissions?.has(PermissionsBitField.Flags.ManageChannels)) {
        return fail('Bot lacks ManageChannels in the ticket category');
    }
    if (!parentPermissions.has(PermissionsBitField.Flags.ViewChannel)) {
        return fail('Bot lacks ViewChannel in the ticket category');
    }

    try {
        const channel = await guild.channels.create({
            name: buildTicketChannelNameForType(ticket.type, {
                ticketNumber: ticket.ticketNumber,
                subjectName,
                openerName,
            }),
            type: ChannelType.GuildText,
            parent: category,
            permissionOverwrites: buildOverwrites({
                guild,
                type: ticket.type,
                subjectId: ticket.subjectId,
                openerId: ticket.openerId,
                moderationRoleIds: config.moderationRoles,
            }),
        });

        return ok(channel);
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }
}

/**
 * Moves a ticket's channel into the category its current state calls for, and
 * re-applies the type's permission model.
 *
 * One function for claim, close and reopen. Those were three separate code paths
 * that each re-derived permissions, which is how the `@everyone` drift got in:
 * reopening reset it to inherit from the parent while creating denied it
 * outright, so a reopened ticket was more permissive than a new one and whether
 * that was visible depended on the category.
 */
export async function syncTicketChannelToState(
    channel: TextChannel,
    guild: Guild,
    ticket: TicketEntity,
    config: ConfiguredTicketingConfig
): Promise<Result<void>> {
    const categoryName =
        ticket.status === 'closed'
            ? config.closedTicketCategoryName
            : ticket.claimerId
              ? config.claimedTicketCategoryName
              : config.supportTicketCategoryName;

    const categoryResult = await findOrCreateModeratorCategory({
        guild,
        categoryName,
        moderationRoleIds: config.moderationRoles,
    });
    if (!categoryResult.ok) return categoryResult;

    try {
        const overwrites = buildOverwrites({
            guild,
            type: ticket.type,
            subjectId: ticket.subjectId,
            openerId: ticket.openerId,
            moderationRoleIds: config.moderationRoles,
        });

        // A closed ticket keeps staff access and loses the subject's. Expressed
        // by dropping the subject's overwrite rather than by editing flags
        // in place, so the result is still exactly what the type declares.
        const effective =
            ticket.status === 'closed' ? overwrites.filter((entry) => entry.id !== ticket.subjectId) : overwrites;

        // A claimer gets the staff arrangement explicitly, so their access does
        // not depend on which moderation role they happen to hold.
        if (ticket.claimerId && ticket.status !== 'closed') {
            const { permissions } = getTicketTypeDefinition(ticket.type);
            effective.push({ id: ticket.claimerId, ...toPermissionOverwrite(permissions.staff) });
        }

        await channel.edit({ parent: categoryResult.value.id, permissionOverwrites: effective });

        return ok();
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }
}
