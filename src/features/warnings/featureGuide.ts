import type { FeatureGuide } from '../../shared/featureGuide';
import { WARNING_DEFAULT_DURATION_MONTHS } from './constants';
import { warnClearCommand } from './commands/warnClearCommand';
import { warnCommand } from './commands/warnCommand';
import { warningsCommand } from './commands/warningsCommand';
import { warningsConfigCommand } from './commands/warningsConfigCommand';

export const WARNINGS_GUIDE: FeatureGuide = {
    name: 'Warnings',
    summary: 'Staff warnings against members, with a mod-log channel.',
    about: `Staff record a warning against a member with /warn: the rule broken, what happened, and when it drops off (${WARNING_DEFAULT_DURATION_MONTHS} months by default). Every warning, edit and release is posted to the mod-log channel. /warnings lists a member's warnings; /warn-clear releases one, with a reason. The dashboard lists every warning and sets the mod-log channel (or /warnings-config, Manage Server).`,
    dashboardPages: [
        { path: '/warnings', label: 'Warnings' },
        { path: '/warnings/config', label: 'Warnings config' },
    ],
    commands: [warnCommand, warningsCommand, warnClearCommand, warningsConfigCommand],
};
