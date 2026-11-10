import { tool } from 'ai';
import { z } from 'zod';
import { ApplicationCommandOptionType } from 'discord.js';
import { WEB_ENABLED, WEB_PUBLIC_URL } from '../../../environment';
import type { DashboardPage, SlashCommandLike } from '../../../shared/featureGuide';
import { BOT_FEATURES, FEATURE_GUIDES, type BotFeature } from './botFeatures';
import type { ChatToolContext } from './chatToolContext';
import { FEATURE_SETUP } from './featureSetup';
import { staffHelpAccess, type StaffHelpAccess } from './staffAccess';

/** What the model is told when the answer is not for this turn, and nothing else: no guide, no setup. */
/** Why `getBotFeature` won't answer this turn, and how the model should say so. */
export type StaffHelpRefusal = { readonly reason: string; readonly tellThem: string };

export const BOT_FEATURE_REFUSALS: Readonly<Record<Exclude<StaffHelpAccess, 'allowed'>, StaffHelpRefusal>> = {
    askerNotStaff: {
        reason: "Only staff can ask about the bot's own features and how they're set up here.",
        tellThem: "Turn them down in character — dry, a little smug, no apology: it's above their pay grade, so they can ask a mod. Stop at \"ask a mod\": not what a mod will do or tell them. Say nothing about how the feature works.",
    },
    readersNotStaff: {
        reason: "People who aren't staff can read this channel.",
        tellThem: "In character, no apology: not where the members can read along — ask again in a channel only staff can see. Say nothing about how the feature works.",
    },
    readersUnknown: {
        reason: "The bot is still loading this server's member list, so it can't yet tell who can read this channel.",
        tellThem: "In character, no apology: you can't vouch for who's reading yet — ask again in a few minutes. Say nothing about how the feature works.",
    },
};

/** `/flash-chat`, with each subcommand when it has some (`/flash-chat setup`). */
function describeCommand(command: SlashCommandLike) {
    const { name, description, options = [] } = command.toJSON();
    const subcommands = options
        .filter((option) => option.type === ApplicationCommandOptionType.Subcommand)
        .map((option) => ({ command: `/${name} ${option.name}`, description: option.description }));
    return { command: `/${name}`, description, ...(subcommands.length > 0 ? { subcommands } : {}) };
}

/** Where this bot's dashboard is served, or null when it runs none. */
const DASHBOARD_ORIGIN = WEB_ENABLED && WEB_PUBLIC_URL ? WEB_PUBLIC_URL : null;

/**
 * A feature's dashboard pages as links — or, when the bot runs no dashboard, that it
 * doesn't. The dashboard opens on whichever server was last picked in it, not on the one
 * asked from, so the model is told to say which.
 */
function describeDashboard(pages: readonly DashboardPage[], dashboardOrigin: string | null) {
    if (!dashboardOrigin) return { dashboard: "The dashboard isn't switched on for this bot." };
    return {
        dashboardPages: pages.map((page) => ({ page: page.label, link: `${dashboardOrigin}${page.path}` })),
        dashboardNote: 'The dashboard opens on whichever server was last picked in its switcher: say to pick this one there.',
    };
}

/**
 * A feature's guide as the tool hands it to the model: the same for every server.
 * `dashboardOrigin` is this bot's (the eval's fixture names production's).
 */
export function describeBotFeature(feature: BotFeature, dashboardOrigin: string | null = DASHBOARD_ORIGIN) {
    const guide = FEATURE_GUIDES[feature];
    return {
        feature: guide.name,
        about: guide.about,
        ...describeDashboard(guide.dashboardPages, dashboardOrigin),
        commands: guide.commands.map(describeCommand),
    };
}

/**
 * How the bot's own features work and how this server has one set up — for staff, only
 * where every reader is staff (`staffHelpAccess`). Refused otherwise, with nothing of the
 * feature in the answer, so the model has nothing to leak.
 */
export function getBotFeatureTool(context: ChatToolContext) {
    const menu = BOT_FEATURES.map((key) => `${key} (${FEATURE_GUIDES[key].summary})`).join('; ');
    return tool({
        description: `How one of this bot's own features works — what it does, its dashboard pages and commands — and how this server has it set up. Call it for any question about the bot's features or their setup, whoever asks: it decides who may hear the answer (staff only, in a channel only staff can read) and says what to tell them otherwise. Features: ${menu}.`,
        inputSchema: z.object({ feature: z.enum(BOT_FEATURES) }),
        execute: async ({ feature }) => {
            const access = staffHelpAccess(context.viewers, context.staffRoleIds);
            if (access !== 'allowed') return { answered: false as const, ...BOT_FEATURE_REFUSALS[access] };
            return { answered: true as const, ...describeBotFeature(feature), setupHere: await FEATURE_SETUP[feature](context) };
        },
    });
}
