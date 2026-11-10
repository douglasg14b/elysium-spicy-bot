import type { ChatToolContext } from './chatToolContext';
import { getChannelInfoTool, listChannelsTool, searchRecentMessagesTool } from './channelTools';
import { getMemberInfoTool, getUserLevelTool } from './memberTools';
import { getServerInfoTool, getServerRulesTool, readContextChannelTool } from './serverTools';
import { stayQuietTool } from './stayQuietTool';
import { getTicketInfoTool } from './ticketTools';

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
        getUserLevel: getUserLevelTool(context),
        getTicketInfo: getTicketInfoTool(context),
        // Offered only in tickets (`runChatTurn`'s `activeTools`): elsewhere a mention always gets an answer.
        stayQuiet: stayQuietTool(),
    };
}

export type ChatTools = ReturnType<typeof buildChatTools>;
