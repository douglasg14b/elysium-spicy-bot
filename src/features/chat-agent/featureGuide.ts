import type { FeatureGuide } from '../../shared/featureGuide';

export const CHAT_AGENT_GUIDE: FeatureGuide = {
    name: 'Chat Agent',
    summary: 'The bot answering @mentions and replies, looking things up instead of guessing.',
    about: `The bot answers when someone @mentions it or replies to one of its answers, and looks things up — rules, channels, members, their intros, tickets — instead of guessing. It calls people "they" unless their pronoun role or intro says otherwise (Discord doesn't show bots profile pronouns). In a ticket it answers only an explicit mention with a real question about the server. On the Chat Agent page admins pick context channels it may read (any marked as a rules channel is quoted instead of Discord's rules channel), the intros channel it keeps a copy of to know who people are, its own staff roles (separate from Server Settings', so moderators can count as staff to the bot without dashboard access; left empty, it uses Server Settings'), rules for how it behaves here, and notes about the server it may pass on to anyone. Where everyone reading is staff, staff can also ask it anyone's level and XP (it won't discuss levels anywhere else — members get pointed at /level), how the bot's features work and how they're set up here, have it find tickets (by number, by member or by channel, closed ones too), and have it read back through any channel or thread everyone reading can see — or from a message link — to answer what happened there, and ask who can see a channel: the roles that let people in, and every person who can, each marked staff or not.`,
    dashboardPages: [{ path: '/chat-agent', label: 'Chat Agent' }],
    commands: [],
};
