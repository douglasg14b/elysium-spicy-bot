import type { FeatureGuide } from '../../shared/featureGuide';

export const CHAT_AGENT_GUIDE: FeatureGuide = {
    name: 'Chat Agent',
    summary: 'The bot answering @mentions and replies, looking things up instead of guessing.',
    about: `The bot answers when someone @mentions it or replies to one of its answers, and looks things up — rules, channels, members, levels, tickets — instead of guessing. In a ticket it answers only an explicit mention with a real question about the server. On the Chat Agent page admins pick context channels it may read (any marked as a rules channel is quoted instead of Discord's rules channel), write rules for how it behaves here, and notes about the server it may pass on to anyone. Where everyone reading is staff, staff can also ask it how the bot's features work and how they're set up here, have it find tickets (by number, by member or by channel, closed ones too), and have it read back through any channel or thread everyone reading can see — or from a message link — to answer what happened there, and ask who can see a channel: the roles that let people in, and every person who can, each marked staff or not.`,
    dashboardPages: [{ path: '/chat-agent', label: 'Chat Agent' }],
    commands: [],
};
