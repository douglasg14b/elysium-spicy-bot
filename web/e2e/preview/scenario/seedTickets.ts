import { defaultTicketTypes } from '../../../../src/features/tickets/data/defaultTicketTypes';
import { ticketingRepo } from '../../../../src/features/tickets/data/ticketingRepo';
import type { TicketTypeDefinition } from '../../../../src/features/tickets/data/ticketingSchema';
import type { TicketEntity, TicketIdentity } from '../../../../src/features/tickets/data/ticketsSchema';
import { buildTicketChannelName } from '../../../../src/features/tickets/logic/ticketTypes';
import {
    attachTicketChannel,
    claimTicket,
    closeTicket,
    deleteTicket,
    openTicket,
    unclaimTicket,
} from '../../../../src/features/tickets/ticketService';
import type { Result } from '../../../../src/shared';
import type { TicketingConfigView, TicketTypeView } from '../../../src/api/types';
import type { PreviewPage, SeedContext } from './seedScenario';

/**
 * Tickets, in every state the list and detail pages render differently.
 *
 * **Deploying the config row goes through `ticketingRepo` directly, not a route.** The
 * only thing that creates one is `/deploy-ticket-system` in Discord — there is no
 * dashboard route for it, deliberately (`TicketsConfigPage`'s own "not set up yet" alert
 * says as much) — so this mirrors `handleDeployTicketSystem`'s write rather than skipping
 * a route that does not exist. Everything reachable through a route after that —
 * categories, moderation roles, the type editor — goes through `api.send`, the same as
 * every other seed step.
 *
 * **Opening a ticket goes through `ticketService`, not `ticketsRepo.create`.** That
 * module is the actual product surface a Discord button and a flow both call — it
 * allocates the number, decides auto-claim, and derives the claimer's identity from the
 * opener's — so seeding through it is seeding through the same decisions a real open
 * makes, rather than hand-building a row that merely looks like one.
 */

const STAFF_PERMISSIONS = { view: true, send: true, readHistory: true, manageMessages: true };
const PARTICIPANT_PERMISSIONS = { view: true, send: true, readHistory: true, manageMessages: false };

/** A long label on purpose — the config page's type table and the list's type badge both need one to stress. */
const LONG_TYPE_LABEL = 'Immediate Safety & Consent Escalation — Staff Only, No Waiting Queue';

/** A type key this guild's config never declares, for the "row older than its type" state `getTicketTypeDefinition` documents. */
const LEGACY_TYPE: TicketTypeDefinition = {
    type: 'legacy-onboarding',
    label: 'Legacy Onboarding (retired)',
    nameTemplate: 'ON{{####}}-{{subject}}',
    permissions: { subject: PARTICIPANT_PERMISSIONS, opener: PARTICIPANT_PERMISSIONS, staff: STAFF_PERMISSIONS },
    autoClaimOnOpen: false,
};

/** Someone a ticket can be about, open, or claimed by. */
interface Person {
    readonly id: string;
    readonly identity: TicketIdentity;
}

/**
 * One ticket to open and carry to its final state.
 *
 * `end` names the state the list and detail pages actually branch on; everything before
 * it — allocation, auto-claim, the channel — is `openTicket`'s own business and not
 * repeated here per row.
 */
interface TicketPlan {
    readonly type: string;
    readonly definition: TicketTypeDefinition;
    readonly subject: Person;
    /** Null for a flow-opened ticket — no human filed it. */
    readonly opener: Person | null;
    readonly title: string;
    readonly reason: string;
    readonly end: 'unclaimed' | 'claimed' | 'closed' | 'deleted';
    /**
     * Who ends up holding it. Defaults to the guild's one moderator. `null` means "closed
     * (or deleted) without anyone having claimed it first" — closing does not require a
     * claim, and an operator who just resolves things by hand is a real shape. Ignored
     * when `end` is `'unclaimed'`.
     */
    readonly claimer?: Person | null;
    /**
     * Skip attaching a channel, leaving `channelId` null on an otherwise live ticket —
     * the state `openTicket`'s own docs describe as "a caller that fails to create a
     * channel", rather than the `deleted` status, which always carries a null channel
     * anyway and would not be a distinct case worth seeding.
     */
    readonly noChannel?: boolean;
    /** Remembered as a `PreviewPage`, keyed by this name, once the plan has run. */
    readonly page?: { readonly name: string; readonly note: string };
}

/**
 * The value of a service call the seed cannot continue without. A refusal here is a seed
 * asking for a state the product would not produce, so it stops seeding rather than
 * carrying on with the ticket as it was.
 */
function must<T>(result: Result<T>, what: string): T {
    if (!result.ok) {
        const reason = result.error instanceof Error ? result.error.message : String(result.error);
        throw new Error(`Seeding failed: could not ${what}: ${reason}`);
    }
    return result.value;
}

/** Claims `desired`, releasing whatever auto-claim or earlier claim is on the ticket first. `null` releases outright. */
async function ensureClaimer(ticket: TicketEntity, desired: Person | null): Promise<TicketEntity> {
    if (ticket.claimerId === (desired?.id ?? null)) return ticket;

    const released = ticket.claimerId ? must(await unclaimTicket(ticket.id), `release #${ticket.ticketNumber}`) : ticket;
    if (desired === null) return released;
    return must(await claimTicket(released.id, desired.id, desired.identity), `claim #${ticket.ticketNumber}`);
}

async function runPlan(context: SeedContext, plan: TicketPlan, defaultClaimer: Person): Promise<TicketEntity> {
    let ticket = must(
        await openTicket({
            guildId: context.guild.guild.id,
            type: plan.type,
            definition: plan.definition,
            subjectId: plan.subject.id,
            openerId: plan.opener?.id ?? null,
            title: plan.title,
            reason: plan.reason,
            subjectIdentity: plan.subject.identity,
            openerIdentity: plan.opener?.identity ?? null,
        }),
        `open "${plan.title}"`
    );

    if (!plan.noChannel) {
        // Passed as the product renders it: TestDiscord lowercases it, as Discord does.
        const channel = context.guild.guild.createTextChannel({
            name: buildTicketChannelName(plan.definition, {
                ticketNumber: ticket.ticketNumber,
                subjectName: plan.subject.identity.username,
                openerName: plan.opener?.identity.username ?? null,
            }),
        });
        ticket = must(await attachTicketChannel(ticket.id, channel.id), `attach a channel to #${ticket.ticketNumber}`);
    }

    const desiredClaimer =
        plan.end === 'unclaimed' ? null : plan.claimer === undefined ? defaultClaimer : plan.claimer;
    ticket = await ensureClaimer(ticket, desiredClaimer);

    if (plan.end === 'closed' || plan.end === 'deleted') {
        ticket = must(await closeTicket(ticket.id), `close #${ticket.ticketNumber}`);
    }

    if (plan.end === 'deleted') {
        ticket = must(await deleteTicket(ticket.id), `delete #${ticket.ticketNumber}`);
    }

    return ticket;
}

export async function seedTickets(context: SeedContext): Promise<PreviewPage[]> {
    const { guild, api } = context;
    const guildId = guild.guild.id;
    const guildPath = `/api/guilds/${guildId}`;

    // The members `seedDiscord` created, in its order. Nicknames are made up here, because
    // TestDiscord has no member-nickname API, but the snapshot columns hold whatever a
    // resolved member's nickname was, so a long one is a state the product renders.
    const brat: Person = {
        id: guild.members[0].id,
        identity: {
            username: 'brattiest_brat_in_the_whole_server',
            nickname: 'The Actual Worst Human Being In This Server, And Extremely Proud Of It (affectionate, mostly)',
        },
    };
    const bunny: Person = { id: guild.members[1].id, identity: { username: 'rope_bunny', nickname: null } };
    const dungeonMonitor: Person = { id: guild.members[2].id, identity: { username: 'mx.switch', nickname: 'Switch' } };
    const admin: Person = { id: guild.operator.id, identity: { username: guild.operator.username, nickname: null } };
    // The guild's one moderation-role holder, and so the default hand a ticket ends up in
    // when a plan does not name somebody else.
    const defaultClaimer = dungeonMonitor;

    // Deploys the ticket system the way `/deploy-ticket-system` does: a config row with
    // the two shipped types, aimed at a real channel. No dashboard route creates this row
    // — see the file doc — so this is the one direct repo write in this seed.
    await ticketingRepo.upsert({
        guildId,
        config: JSON.stringify({
            modTicketsDeployed: true,
            modTicketsDeployedChannelId: guild.channels.modLog.id,
            modTicketsDeployedMessageId: '1100000000000000001',
            supportTicketCategoryName: '',
            claimedTicketCategoryName: '',
            closedTicketCategoryName: '',
            moderationRoles: [],
            ticketTypes: defaultTicketTypes(),
        }),
        ticketNumberInc: 0,
        entityVersion: 1,
    });

    // Categories and the one moderation role, through the real config route — staff and
    // moderators are different crowds here, so this is `moderators`, not `staff`.
    await api.send('PUT', `${guildPath}/config/tickets`, {
        supportTicketCategoryName: 'Tickets — Open',
        claimedTicketCategoryName: 'Tickets — Claimed',
        closedTicketCategoryName: 'Tickets — Closed',
        moderationRoles: [guild.roles.moderators.id],
    });

    // A third type, through the real type route, with a label long enough to stress the
    // list's badge column and the config table's label cell.
    await api.send('PUT', `${guildPath}/config/tickets/types/safety-escalation`, {
        label: LONG_TYPE_LABEL,
        nameTemplate: 'ESC{{####}}-{{subject}}',
        permissions: { subject: PARTICIPANT_PERMISSIONS, opener: PARTICIPANT_PERMISSIONS, staff: STAFF_PERMISSIONS },
        autoClaimOnOpen: false,
    });

    // Read back what the routes actually declared, rather than assuming the request
    // bodies above and the stored shape agree — `support` and `verification` come from
    // `defaultTicketTypes()`, not from anything this file wrote.
    const config = await api.send<TicketingConfigView>('GET', `${guildPath}/config/tickets`);
    const declared = new Map<string, TicketTypeView>(config.types.map((type) => [type.type, type]));
    const definitionOf = (type: string): TicketTypeDefinition => {
        const found = declared.get(type);
        if (!found) throw new Error(`Seeding failed: expected "${type}" to be declared by now.`);
        return found;
    };

    const support = definitionOf('support');
    const verification = definitionOf('verification');
    const safetyEscalation = definitionOf('safety-escalation');

    /*
     * Twenty-five tickets. `support` auto-claims its opener on open, which is used
     * deliberately below rather than worked around: a support ticket somebody filed
     * about themselves and never handed off is a real, common shape, and forcing every
     * plan to `unclaimed` would hide it.
     */
    const plans: TicketPlan[] = [
        // -- support: self-filed, mostly self-claimed --
        {
            type: 'support',
            definition: support,
            subject: bunny,
            opener: bunny,
            title: "Can't see the after-dark voice channel",
            reason: "It just doesn't show up in my channel list even though I have the Verified role. Role sync issue?",
            end: 'claimed',
        },
        {
            type: 'support',
            definition: support,
            subject: bunny,
            opener: brat,
            title:
                "My rope bag went missing after last week's munch and I think someone borrowed it without asking, again, for the third time this month, and I would like it noted somewhere official before I start accusing people by name in general chat",
            reason:
                "Second week in a row somebody's \"borrowed\" my good rope from the gear cupboard without leaving a note.\n\nI'm not naming names yet because I don't have proof, just a very strong vibe and a missing bag. If this happens a third time I am absolutely naming names, so consider this an official heads up before it gets messy.\n\nCan we get a sign-out sheet or something? Anything.",
            end: 'closed',
            page: { name: 'ticket-long', note: 'closed support ticket with a long title, a multi-paragraph reason, and a long subject/opener name' },
        },
        {
            type: 'support',
            definition: support,
            subject: brat,
            opener: brat,
            title: 'Payment for the workshop bounced but I still got charged',
            reason: 'Card shows a pending charge, the workshop signup still says unpaid. Bank or bot bug?',
            end: 'claimed',
        },
        {
            type: 'support',
            definition: support,
            subject: admin,
            opener: admin,
            title: "Ticket channel never actually got created, filing this over DMs instead",
            reason: 'Pressed the button, got a confirmation, no channel showed up anywhere. Second time this has happened.',
            end: 'unclaimed',
            noChannel: true,
            page: { name: 'ticket-no-channel', note: 'open ticket whose channel never got created — channelId is null without the ticket being deleted' },
        },
        {
            type: 'support',
            definition: support,
            subject: brat,
            opener: null,
            title: 'Requesting a rename of an old ticket channel for the archive',
            reason: 'Automated request from the channel-cleanup flow. No human filed this one.',
            end: 'unclaimed',
        },
        {
            type: 'support',
            definition: support,
            subject: dungeonMonitor,
            opener: dungeonMonitor,
            title: 'Lost my 2FA device, need manual identity re-verification for event access',
            reason: 'Phone with the authenticator app is gone. Need staff to re-verify me by some other means.',
            end: 'deleted',
        },
        {
            type: 'support',
            definition: support,
            subject: bunny,
            opener: bunny,
            title: 'Refund request — could not attend the workshop due to a family emergency',
            reason: "Fully understand if it's non-refundable, just want to ask before assuming.",
            end: 'closed',
            claimer: null,
        },
        {
            type: 'support',
            definition: support,
            subject: brat,
            opener: brat,
            title: 'Late fee waiver',
            reason: 'Paid three days late because of a bank holiday, not because I forgot. Any chance of a waiver?',
            end: 'claimed',
        },
        {
            type: 'support',
            definition: support,
            subject: bunny,
            opener: bunny,
            title: 'General feedback about the new bot commands',
            reason: 'Nothing urgent, just some thoughts on the new slash commands whenever someone has a minute.',
            end: 'unclaimed',
        },

        // -- verification: flow-opened, staff-reviewed --
        {
            type: 'verification',
            definition: verification,
            subject: brat,
            opener: null,
            title: 'ID verification for 18+ access',
            reason: 'Automated verification request triggered by the onboarding flow. Awaiting ID review.',
            end: 'unclaimed',
        },
        {
            type: 'verification',
            definition: verification,
            subject: bunny,
            opener: null,
            title: 'ID verification for 18+ access',
            reason: 'Automated verification request triggered by the onboarding flow. Awaiting ID review.',
            end: 'unclaimed',
        },
        {
            type: 'verification',
            definition: verification,
            subject: dungeonMonitor,
            opener: null,
            title: 'ID verification — resubmission after a blurry photo',
            reason: 'Second attempt. Photo should be clearer this time.',
            end: 'claimed',
            claimer: admin,
        },
        {
            type: 'verification',
            definition: verification,
            subject: brat,
            opener: null,
            title: 'ID verification for 18+ access, please expedite — event starts in an hour',
            reason: 'Know this is short notice, would really appreciate a quick look if anyone is around.',
            end: 'claimed',
        },
        {
            type: 'verification',
            definition: verification,
            subject: bunny,
            opener: null,
            title: 'ID verification for 18+ access',
            reason: 'Automated verification request triggered by the onboarding flow. Approved on first pass.',
            end: 'closed',
        },
        {
            type: 'verification',
            definition: verification,
            subject: brat,
            opener: null,
            title: 'ID verification — name on the documents does not match the account, escalating',
            reason:
                'Reviewed the submitted ID twice. The photo quality is fine but the name on it matches neither the account nor anything the member mentioned when they joined.\n\nHolding this open rather than approving or rejecting outright. Someone with more experience on ID review should take a second look before we do anything either way.\n\nSubject has been told review is ongoing, nothing more.',
            end: 'closed',
        },

        // -- safety-escalation: the long-label type --
        {
            type: 'safety-escalation',
            definition: safetyEscalation,
            subject: bunny,
            opener: brat,
            title: "Consent boundary crossed at last night's play party — need staff eyes now",
            reason:
                "Filing this on behalf of a friend who doesn't want to be the one typing it up right now.\n\nDuring a scene last night, a boundary that was explicitly stated beforehand was crossed. Nothing further happened after it was called out, and the other person has already left the immediate area, but this needs to go on record and be looked at properly, not just smoothed over.\n\nHappy to give more detail directly to whichever mod picks this up. Please treat this with some urgency.",
            end: 'claimed',
        },
        {
            type: 'safety-escalation',
            definition: safetyEscalation,
            subject: brat,
            opener: brat,
            title: 'Repeated boundary-testing in DMs after being told to stop',
            reason: 'Asked them twice to stop, they did not. Have screenshots ready to share with whoever picks this up.',
            end: 'claimed',
            claimer: admin,
        },
        {
            type: 'safety-escalation',
            definition: safetyEscalation,
            subject: bunny,
            opener: bunny,
            title: 'Someone posted a screenshot of a private conversation without consent',
            reason: 'Screenshot went into a public channel before it was taken down. Would like it addressed with the poster directly.',
            end: 'closed',
        },
        {
            type: 'safety-escalation',
            definition: safetyEscalation,
            subject: dungeonMonitor,
            opener: brat,
            title: "Safeword wasn't honored during a scene at the munch",
            reason:
                "Reporting this for someone else who has asked to stay anonymous for now, so please don't push for a name yet.\n\nDuring a scene at Saturday's munch, a called safeword was not immediately respected — there was a delay of maybe ten to fifteen seconds before play stopped. Everyone involved is physically fine, but it clearly should not have happened and the person is shaken up about it.\n\nThis needs a proper look, not just a quiet word. Whoever takes this, please reach out to me first before contacting anyone else involved.",
            end: 'closed',
        },
        {
            type: 'safety-escalation',
            definition: safetyEscalation,
            subject: brat,
            opener: brat,
            title: 'Uncomfortable comments from a Dungeon Monitor during a scene check-in',
            reason: 'Nothing that crossed a hard line, but the tone felt off and I want it noted.',
            end: 'unclaimed',
        },
        {
            type: 'safety-escalation',
            definition: safetyEscalation,
            subject: brat,
            opener: brat,
            title: "Follow-up: is the DM situation from last week resolved?",
            reason: "Haven't heard anything since the last update. Just checking in.",
            end: 'unclaimed',
        },
        {
            type: 'safety-escalation',
            definition: safetyEscalation,
            subject: bunny,
            opener: bunny,
            title: 'Someone using an old photo of me without permission on their profile',
            reason: 'Talked to them directly and they took it down, so withdrawing this — did not mean to leave it open.',
            end: 'deleted',
        },
        {
            type: 'safety-escalation',
            definition: safetyEscalation,
            subject: bunny,
            opener: brat,
            title: 'Requesting a no-contact note between two members after a bad breakup got messy in voice chat',
            reason: 'Nothing physical, just a lot of shouting in the events voice channel that made people uncomfortable.',
            end: 'closed',
            claimer: null,
        },

        // -- a type this guild's config no longer declares --
        {
            type: LEGACY_TYPE.type,
            definition: LEGACY_TYPE,
            subject: brat,
            opener: null,
            title: 'Legacy onboarding ticket — predates the type migration',
            reason: 'Old record from before ticket types were guild-configurable. Kept for history.',
            end: 'closed',
        },
        {
            type: LEGACY_TYPE.type,
            definition: LEGACY_TYPE,
            subject: bunny,
            opener: null,
            title: 'Legacy onboarding ticket, still open somehow',
            reason: 'Old record from before ticket types were guild-configurable. Kept for history.',
            end: 'unclaimed',
            page: { name: 'ticket-undeclared-type', note: 'open ticket whose type this guild no longer declares — no typeLabel, raw key shown instead' },
        },
    ];

    const remembered = new Map<string, TicketEntity>();
    for (const plan of plans) {
        const ticket = await runPlan(context, plan, defaultClaimer);
        if (plan.page) remembered.set(plan.page.name, ticket);
    }

    const pages: PreviewPage[] = [
        { name: 'tickets-list', path: '/tickets', note: '25 tickets across four types, every status, one undeclared type and one missing channel' },
        { name: 'tickets-config', path: '/tickets/config', note: 'three types including one with a very long label' },
    ];
    for (const plan of plans) {
        if (!plan.page) continue;
        const ticket = remembered.get(plan.page.name);
        if (!ticket) continue;
        pages.push({ name: plan.page.name, path: `/tickets/${ticket.id}`, note: plan.page.note });
    }

    return pages;
}
