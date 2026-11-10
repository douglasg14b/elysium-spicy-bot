import { BIRTHDAY_TIMEZONE } from '../../environment';
import type { FeatureGuide } from '../../shared/featureGuide';
import { birthdayCommand } from './commands/birthdayCommand';
import { birthdayConfigCommand } from './commands/birthdayConfigCommand';

export const BIRTHDAYS_GUIDE: FeatureGuide = {
    name: 'Birthdays',
    summary: 'Members record their birthday; the bot posts a written shout-out on the day.',
    about: `Members run /birthday to set, change or remove their birthday (the year is optional). On the day, between 7am and 10pm ${BIRTHDAY_TIMEZONE} time (the bot's own clock, not the server's time zone), the bot posts a short written shout-out pinging them in the announcement channel. If a context channel is set (an intros channel, say), it reads the member's last few messages there for a light touch — never their name or age. Setup is the /birthday-config command (Manage Server): the announcement channel and the optional context channel. The dashboard's Birthdays page isn't built yet.`,
    dashboardPages: [],
    commands: [birthdayCommand, birthdayConfigCommand],
};
