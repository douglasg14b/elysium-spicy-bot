import { BIRTHDAYS_GUIDE } from '../../birthday-tracker/featureGuide';
import { FLASH_CHAT_GUIDE } from '../../flash-chat/featureGuide';
import { FLOWS_GUIDE } from '../../flows/featureGuide';
import { LEVELING_GUIDE } from '../../leveling/featureGuide';
import { TICKETS_GUIDE } from '../../tickets/featureGuide';
import { WARNINGS_GUIDE } from '../../warnings/featureGuide';
import { SERVER_SETTINGS_GUIDE } from '../../../features-system/guild-settings/featureGuide';
import type { FeatureGuide } from '../../../shared/featureGuide';
import { CHAT_AGENT_GUIDE } from '../featureGuide';

/** The bot's features staff can ask about, by the key the model picks. */
export const BOT_FEATURES = [
    'birthdays',
    'flashChat',
    'flows',
    'leveling',
    'tickets',
    'warnings',
    'chatAgent',
    'serverSettings',
] as const;

export type BotFeature = (typeof BOT_FEATURES)[number];

/** Each feature's guide, kept beside that feature's code. */
export const FEATURE_GUIDES: Readonly<Record<BotFeature, FeatureGuide>> = {
    birthdays: BIRTHDAYS_GUIDE,
    flashChat: FLASH_CHAT_GUIDE,
    flows: FLOWS_GUIDE,
    leveling: LEVELING_GUIDE,
    tickets: TICKETS_GUIDE,
    warnings: WARNINGS_GUIDE,
    chatAgent: CHAT_AGENT_GUIDE,
    serverSettings: SERVER_SETTINGS_GUIDE,
};
