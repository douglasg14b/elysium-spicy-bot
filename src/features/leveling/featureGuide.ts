import type { FeatureGuide } from '../../shared/featureGuide';
import { levelCommand } from './commands/levelCommand';
import { levelingConfigCommand } from './commands/levelingConfigCommand';
import { levelRankingsCommand } from './commands/levelRankingsCommand';
import { levelReportCommand } from './commands/levelReportCommand';
import { levelStatsCommand } from './commands/levelStatsCommand';

export const LEVELING_GUIDE: FeatureGuide = {
    name: 'Leveling',
    summary: 'Members earn XP for being active and level up; level-ups can be announced.',
    about: `Members earn XP for chatting, reacting and posting pictures, and level up as it adds up; level-ups can be announced in a channel. /level and /level-stats show anyone's progress; /level-rankings and /level-report are the mods' view. Switch it on and pick the announcement channel with /leveling-config (Manage Server). The dashboard's Leveling pages show the leaderboard, insights and each member's history; they don't change settings.`,
    dashboardPages: [
        { path: '/leveling', label: 'Leveling' },
        { path: '/leveling/insights', label: 'Leveling insights' },
    ],
    commands: [levelingConfigCommand, levelCommand, levelStatsCommand, levelRankingsCommand, levelReportCommand],
};
