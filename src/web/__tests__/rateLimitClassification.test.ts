import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../api/openApiDocument';
import { callsDiscord, type RateBudget } from '../rateLimit';

/**
 * The gate behind "every guild route is in the right budget".
 *
 * `rateLimit.ts` sorts requests by path patterns kept apart from the routes, so a route added
 * or renamed would land in a budget by default rather than by decision: a new write in the
 * Discord budget (safe, but an autosave there would trip it while someone types), a new read
 * in the general one alone (even if it calls Discord). This walks every guild-scoped operation
 * in the spec and fails until each one is placed below.
 *
 * `discord` means the request also counts against the Discord budget. Some writes there touch
 * only the database; they stay because nothing sends them faster than a person clicks.
 */
const EXPECTED_BUDGET: Readonly<Record<string, RateBudget>> = {
    // Flows.
    listFlows: 'general',
    getFlow: 'general',
    getFlowNextRuns: 'general',
    checkFlow: 'general',
    createFlow: 'discord',
    updateFlow: 'discord',
    deleteFlow: 'discord',
    deployFlow: 'discord',
    getInstallPlan: 'general',
    installFlow: 'discord',
    getPublishedState: 'general',
    undeployFlow: 'discord',
    unpublishFlow: 'discord',
    // Drafts. The autosave is the one write here typing sends.
    listFlowDrafts: 'general',
    saveMyFlowDraft: 'general',
    discardFlowDraft: 'discord',
    // Guild directory and settings.
    getGuildChannels: 'general',
    getGuildRoles: 'general',
    getWarningsConfig: 'general',
    updateWarningsConfig: 'discord',
    getGuildSettings: 'general',
    updateGuildSettings: 'discord',
    updateGuildTimeZone: 'discord',
    // Journeys. Drift fetches every channel; both resource autosave targets are typing.
    listJourneys: 'general',
    getJourney: 'general',
    getJourneyPublishedState: 'general',
    undeployJourney: 'discord',
    unpublishJourney: 'discord',
    getJourneyDrift: 'discord',
    repairJourneyDrift: 'discord',
    forgetJourneyOrphan: 'discord',
    getFlowResources: 'general',
    saveFlowResources: 'general',
    getFlowAttachment: 'general',
    attachFlowToJourney: 'discord',
    detachFlowFromJourney: 'discord',
    previewFlowGrouping: 'general',
    groupFlowWith: 'discord',
    createJourney: 'discord',
    updateJourney: 'general',
    deleteJourney: 'discord',
    // Leveling. The leaderboard and one member's card fetch members from Discord.
    listLeveling: 'discord',
    getLevelingUser: 'discord',
    getLevelingInsights: 'general',
    // Tickets.
    listTickets: 'general',
    getTicket: 'general',
    claimTicket: 'discord',
    unclaimTicket: 'discord',
    closeTicket: 'discord',
    reopenTicket: 'discord',
    getTicketsConfig: 'general',
    updateTicketsConfig: 'discord',
    saveTicketType: 'discord',
    deleteTicketType: 'discord',
};

const GUILD_SCOPED_PREFIX = '/api/guilds/{guildId}/';

/** The HTTP methods an OpenAPI path item can hold an operation under. */
const OPERATION_METHODS: ReadonlySet<string> = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);

/** Every guild-scoped operation's budget as `callsDiscord` decides it, by operation id. */
async function actualBudgets(): Promise<Record<string, RateBudget>> {
    const paths = (await buildOpenApiDocument()).paths ?? {};
    const budgets: Record<string, RateBudget> = {};
    for (const [path, item] of Object.entries(paths)) {
        if (!path.startsWith(GUILD_SCOPED_PREFIX)) continue;
        // A concrete path the router would match, each `{param}` filled in.
        const examplePath = path.replace(/\{([^}]+)\}/g, (_match, name: string) => `${name}-1`);
        const operations = Object.entries(item as Record<string, { operationId?: string } | undefined>);
        for (const [method, operation] of operations) {
            if (!OPERATION_METHODS.has(method) || !operation?.operationId) continue;
            budgets[operation.operationId] = callsDiscord(method.toUpperCase(), examplePath) ? 'discord' : 'general';
        }
    }
    return budgets;
}

describe('rate limit budget per guild route', () => {
    it('places every guild-scoped operation in the budget it was given', async () => {
        expect(
            await actualBudgets(),
            'A guild route is in a budget nobody chose for it, or one listed here is gone. Place it in ' +
                'EXPECTED_BUDGET — `discord` if its handler calls Discord — and, where that disagrees with ' +
                '`callsDiscord`, list its path in `DISCORD_READS` or `DATABASE_ONLY_WRITES` (`rateLimit.ts`).'
        ).toEqual(EXPECTED_BUDGET);
    });
});
