import type { FeatureGuide } from '../../shared/featureGuide';
import { DEFAULT_GUILD_TIME_ZONE } from './constants';

export const SERVER_SETTINGS_GUIDE: FeatureGuide = {
    name: 'Server Settings',
    summary: 'Who counts as staff, and the server time zone.',
    about: `Settings for the whole server. Staff roles are who counts as staff: the staff-only channels a journey installs, and — with the owner and Administrators, who always count — who may ask the bot about its features. The time zone is what flow schedules and the chat agent's sense of "now" use (${DEFAULT_GUILD_TIME_ZONE} until set); birthdays, leveling's days and warnings' dates keep the bot's own clock whatever it is set to. Both are on the dashboard's Server Settings page.`,
    dashboardPages: [{ path: '/settings', label: 'Server Settings' }],
    commands: [],
};
