import type { FeatureGuide } from '../../shared/featureGuide';

export const CHAT_AGENT_GUIDE: FeatureGuide = {
    name: 'Chat Agent',
    summary: 'The bot answering @mentions and replies, looking things up instead of guessing.',
    about: `The bot answers when someone @mentions it or replies to one of its answers, and looks things up — rules, channels, members, levels, tickets — instead of guessing. In a ticket it answers only an explicit mention with a real question about the server. On the Chat Agent page admins pick context channels it may read (any marked as a rules channel is quoted instead of Discord's rules channel), write rules for how it behaves here, and notes about the server it may pass on to anyone. Staff can ask it how the bot's features work and how they're set up here, in a channel where everyone reading is staff.`,
    dashboardPages: [{ path: '/chat-agent', label: 'Chat Agent' }],
    commands: [],
};
