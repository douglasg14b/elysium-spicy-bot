import type { FeatureGuide } from '../../shared/featureGuide';
import { FLASH_CHAT_MAX_TIMEOUT_SECONDS } from './constants';
import { formatFlashChatTimeout } from './logic/flashChatNotices';
import { flashChatCommand } from './flashChatCommand';

export const FLASH_CHAT_GUIDE: FeatureGuide = {
    name: 'Flash Chat',
    summary: 'Channels whose messages delete themselves after a set time.',
    about: `In a flash chat channel every message deletes itself after a set time, up to ${formatFlashChatTimeout(FLASH_CHAT_MAX_TIMEOUT_SECONDS)}. Per channel: the timeout, whether pinned messages are kept, and whether messages from before it was switched on are left alone. Set it up on the dashboard's Flash Chat page, or with /flash-chat in the channel (Manage Channels).`,
    dashboardPages: [{ path: '/flash-chat', label: 'Flash Chat' }],
    commands: [flashChatCommand],
};
