import { getBotFeatureTool } from './botFeatureTools';
import type { ChatToolContext } from './chatToolContext';
import { getChannelAccessTool } from './channelAccessTools';
import { readChannelMessagesTool } from './channelHistoryTools';
import { getChannelInfoTool, listChannelsTool, searchRecentMessagesTool } from './channelTools';
import { getMemberIntroTool } from './introTools';
import { getMemberInfoTool, getUserLevelTool } from './memberTools';
import { getServerInfoTool, getServerRulesTool, readContextChannelTool } from './serverTools';
import { stayQuietTool } from './stayQuietTool';
import { findTicketsTool, getTicketInfoTool } from './ticketTools';

/** The agent's tools for one turn, every one bound to that turn's server, channel and asker. Read-only. */
export function buildChatTools(context: ChatToolContext) {
    return {
        getServerRules: getServerRulesTool(context),
        readContextChannel: readContextChannelTool(context),
        getServerInfo: getServerInfoTool(context),
        listChannels: listChannelsTool(context),
        getChannelInfo: getChannelInfoTool(context),
        searchRecentMessages: searchRecentMessagesTool(context),
        getMemberInfo: getMemberInfoTool(context),
        getMemberIntro: getMemberIntroTool(context),
        getTicketInfo: getTicketInfoTool(context),
        // Staff only, where every reader is staff; each says so itself.
        getUserLevel: getUserLevelTool(context),
        getBotFeature: getBotFeatureTool(context),
        findTickets: findTicketsTool(context),
        readChannelMessages: readChannelMessagesTool(context),
        getChannelAccess: getChannelAccessTool(context),
        // Offered only in tickets (`runChatTurn`'s `activeTools`): elsewhere a mention always gets an answer.
        stayQuiet: stayQuietTool(),
    };
}

export type ChatTools = ReturnType<typeof buildChatTools>;
