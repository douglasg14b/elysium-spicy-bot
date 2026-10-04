import type { Client, Guild, GuildMember, PartialGuildMember } from 'discord.js';
import { TICKET_VARIABLES, type TicketChangeEvent, type TicketChangeSubscriber } from '../../tickets';
import { isTriggerStartedBy } from '../blocks/registry';
import { ticketEventConfigSchema } from '../blocks/triggerTicketEvent';
import type { FlowRunSeed } from '../blocks/types';
import { FLOW_MAX_CHAIN_DEPTH } from '../constants';
import { isUnknownMember } from '../../../utils/isUnknownMember';
import { flowsRepo } from '../data/flowsRepo';
import type { FlowEntity } from '../data/flowsSchema';
import { asGuildTextChannel } from '../engine/runChannel';
import { startTriggeredRun } from '../engine/triggeredRun';

/*
 * The Ticket Event dispatcher.
 *
 * **Why here, and not in `engine/` beside the other dispatchers.** `engine/` is held to
 * a vocabulary that keeps the interpreter from learning a use case, and `ticket` is one
 * of the nouns that gate proves it rejects — so a dispatcher for ticket changes cannot
 * declare what it is about in there. Not in the block's own directory either: `initFlows`
 * would then import a block, which `__tests__/blockTypeBranching.test.ts` rightly treats
 * as a cross-block dependency. So it sits in `logic/`, ungated, as a declared residual
 * dependent of `triggerTicketEvent` — the shape `engine/levelUpDispatch.ts` and
 * `logic/planButtonDeployment.ts` already have: generic selection through the registry,
 * then the one block's schema to decide whether this change matches.
 */

/**
 * The subscriber flows registers with the ticket service.
 *
 * **It schedules the dispatch and returns at once.** A ticket change can come from a
 * flow's own Close Ticket or Open Ticket, inside that run's node. Awaiting the runs it
 * starts there would run flow B nested inside flow A's step, and a loop of flows would
 * recurse on the stack instead of being a sequence of separate runs the depth cap can
 * stop. `setImmediate` puts the dispatch on a later turn: the run that made the change
 * never awaits the runs its change starts, and none of them is on its stack.
 *
 * What that does **not** promise is that the run making the change has finished before
 * the next one starts. It has if the rest of its work completes without waiting on I/O;
 * if it is still waiting on Discord when the dispatch fires, the two run side by side.
 */
export function ticketChangeSubscriber(client: Client): TicketChangeSubscriber {
    return (event) => {
        setImmediate(() => {
            handleTicketChange(client, event).catch((error: unknown) => {
                console.error(
                    `[flows] Error dispatching ${event.kind} for ticket #${event.ticket.ticketNumber} in guild ${event.ticket.guildId}:`,
                    error
                );
            });
        });
    };
}

/**
 * On a committed ticket change, run **every** Ticket Event trigger whose event matches
 * and whose type filter is empty or names this ticket's type, in every enabled flow in
 * the ticket's guild.
 *
 * Each run is one link further down the chain than the change that started it. A run
 * that would sit deeper than {@link FLOW_MAX_CHAIN_DEPTH} is refused and logged with the
 * flow and the ticket, and nothing else about the change is affected.
 */
export async function handleTicketChange(client: Client, event: TicketChangeEvent): Promise<void> {
    const { ticket } = event;
    const guild = client.guilds.cache.get(ticket.guildId);
    if (!guild) {
        console.warn(
            `[flows] Skipping ${event.kind} dispatch for ticket #${ticket.ticketNumber}: guild ${ticket.guildId} is not available to this bot`
        );
        return;
    }

    // Matched before the cap and before any Discord call: a change nothing listens for
    // costs one flows read, and a refusal names exactly the flows it refused.
    const matching = matchingTriggers(await flowsRepo.getByGuildId(guild.id), event);
    if (matching.length === 0) {
        return;
    }

    const chainDepth = event.chainDepth + 1;
    if (chainDepth > FLOW_MAX_CHAIN_DEPTH) {
        for (const { flow, triggerNodeId } of matching) {
            console.warn(
                `[flows] Refused to start flow ${flow.flowId} (trigger ${triggerNodeId}) on ${event.kind} of ticket ` +
                    `#${ticket.ticketNumber} (id ${ticket.id}) in guild ${guild.id}: it would be run ${chainDepth} in a ` +
                    `chain of flows setting each other off, past the limit of ${FLOW_MAX_CHAIN_DEPTH}.`
            );
        }
        return;
    }

    /*
     * Resolved once, outside the flow loop, as Level Reached resolves its member: every
     * matching trigger needs the same people and the same channel.
     *
     * A fetch that fails for any reason but "not a member" throws out of here, and the
     * subscriber's catch logs it with nothing started: a timeout or a rate limit says
     * nothing about whether someone left, so it must not turn a present member into a
     * leaver, nor quietly drop the actor.
     */
    const subject = await resolveSubject(guild, ticket.subjectId);
    const actor = event.actorId ? await fetchUnlessGone(guild, event.actorId) : null;
    const channel = ticket.channelId
        ? asGuildTextChannel(await guild.channels.fetch(ticket.channelId).catch(() => null))
        : undefined;

    for (const { flow, triggerNodeId } of matching) {
        // A fresh seed per trigger, for the reason `handleLevelUp` gives.
        const seed: FlowRunSeed = {
            client,
            guild,
            subject,
            // Only when a person made the change and is still here to be named; a flow's
            // change has nobody behind it.
            ...(actor ? { actor } : {}),
            // A deleted ticket names no channel, and a channel that is gone, or that the
            // bot cannot reach, resolves to none.
            ...(channel ? { channel } : {}),
            eventAt: event.changedAt,
            chainDepth,
            /*
             * Seeded here rather than written by the trigger's `run`, which never sees the
             * change. The keys are the block's own outputs, from `TICKET_VARIABLES`, so
             * the picker and the bag cannot disagree. The channel id only when the channel
             * resolved, so `{{var.ticketChannelId}}` and the run's channel always agree.
             */
            variables: {
                [TICKET_VARIABLES.ticketId]: ticket.id,
                ...(channel ? { [TICKET_VARIABLES.ticketChannelId]: channel.id } : {}),
            },
        };

        await startTriggeredRun({ flowId: flow.flowId, graph: flow.graph, triggerNodeId, source: 'ticketChanged', seed });
    }
}

/** One trigger a ticket change starts, in the flow that holds it. */
interface MatchedTrigger {
    readonly flow: FlowEntity;
    readonly triggerNodeId: string;
}

/**
 * Every Ticket Event trigger this change starts: in an enabled flow, on this event, and
 * with no type filter or this ticket's type.
 *
 * The registry says which triggers the source starts; the trigger's own schema says
 * whether this change matches — the residual block dependency `levelUpDispatch` carries.
 */
function matchingTriggers(flows: readonly FlowEntity[], event: TicketChangeEvent): MatchedTrigger[] {
    const matched: MatchedTrigger[] = [];

    for (const flow of flows) {
        if (!flow.enabled) {
            continue;
        }

        for (const node of flow.graph.nodes) {
            if (!isTriggerStartedBy(node.type, 'ticketChanged')) {
                continue;
            }

            const parsed = ticketEventConfigSchema.safeParse(node.data);
            // A trigger whose config does not parse matches nothing rather than
            // everything, as Level Reached's does.
            if (!parsed.success) {
                continue;
            }

            if (parsed.data.event !== event.kind) {
                continue;
            }

            if (parsed.data.ticketType && parsed.data.ticketType !== event.ticket.type) {
                continue;
            }

            matched.push({ flow, triggerNodeId: node.id });
        }
    }

    return matched;
}

/** The member, or null when Discord says they are not in the guild. Any other failure throws. */
async function fetchUnlessGone(guild: Guild, userId: string): Promise<GuildMember | null> {
    try {
        return await guild.members.fetch(userId);
    } catch (error) {
        if (isUnknownMember(error)) {
            return null;
        }
        throw error;
    }
}

/**
 * The member a ticket is about, even when they have left the server.
 *
 * A leaver is not skipped, as Level Reached skips: the change still happened, and a
 * flow reacting to it — closing their other tickets, telling staff — needs no member to
 * act on. They get a **partial** member instead, the same object a Member Leaves run is
 * handed for an uncached leaver: an id and a user, no join date, no roles. Blocks that
 * need a full member then fail by name, as they already do on Member Leaves.
 *
 * discord.js has no public way to build that object, so this does exactly what its own
 * `GuildMemberRemove` action does when the `GuildMember` partial is enabled
 * (`client/actions/Action.js` → `getMember` → `manager._add`), with `false` so a member
 * who is not in the guild is never cached as though they were.
 *
 * Only Discord's `Unknown Member` makes someone a leaver; any other failure throws (see
 * the caller). A user Discord cannot fetch at all throws too, and starts nothing.
 */
async function resolveSubject(guild: Guild, subjectId: string): Promise<GuildMember | PartialGuildMember> {
    const member = await fetchUnlessGone(guild, subjectId);
    if (member) {
        return member;
    }

    // Fetched into the client's user cache, which `_add` relies on: it is handed only the
    // id, and the member's `user` is resolved from that cache — this fetch is what gives
    // the partial its name rather than a user with every field null.
    const user = await guild.client.users.fetch(subjectId, { cache: true });
    return guild.members['_add']({ user: { id: user.id } }, false);
}
