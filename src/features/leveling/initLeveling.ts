import { Events } from 'discord.js';
import { interactionsRegistry } from '../../features-system/commands';
import { DISCORD_CLIENT } from '../../discordClient';
import { levelingConfigCommand, handleLevelingConfigCommand } from './commands/levelingConfigCommand';
import { handleLevelCommand, levelCommand } from './commands/levelCommand';
import { handleLevelRankingsCommand, levelRankingsCommand } from './commands/levelRankingsCommand';
import { handleLevelReportCommand, levelReportCommand } from './commands/levelReportCommand';
import { handleLevelStatsCommand, levelStatsCommand } from './commands/levelStatsCommand';
import { LevelingService } from './levelingService';
import {
    startVoiceSessionReconcileScheduler,
    stopVoiceSessionReconcileScheduler,
} from './logic/voiceSessionReconcileScheduler';
import { logIsolatedVoiceXpError } from './logic/voiceXp';

let levelingInitialized = false;
let levelingService: LevelingService | null = null;

export function initLeveling(): void {
    if (levelingInitialized) {
        return;
    }

    levelingInitialized = true;

    interactionsRegistry.register(levelingConfigCommand, handleLevelingConfigCommand);
    interactionsRegistry.register(levelCommand, handleLevelCommand);
    interactionsRegistry.register(levelStatsCommand, handleLevelStatsCommand);
    interactionsRegistry.register(levelRankingsCommand, handleLevelRankingsCommand);
    interactionsRegistry.register(levelReportCommand, handleLevelReportCommand);

    levelingService = new LevelingService(DISCORD_CLIENT);

    DISCORD_CLIENT.on(Events.MessageCreate, (message) => {
        void levelingService?.handleMessageCreate(message).catch((error) => {
            console.error('[leveling] Error handling message create:', error);
        });
    });

    DISCORD_CLIENT.on(Events.MessageReactionAdd, (reaction, user) => {
        void levelingService?.handleReactionAdd(reaction, user).catch((error) => {
            console.error('[leveling] Error handling reaction add:', error);
        });
    });

    startVoiceXpTracking(levelingService);
}

function startVoiceXpTracking(service: LevelingService): void {
    try {
        DISCORD_CLIENT.on(Events.VoiceStateUpdate, (oldState, newState) => {
            void service.handleVoiceStateUpdate(oldState, newState).catch((error) => {
                logIsolatedVoiceXpError('voice state update', error);
            });
        });

        const startVoiceReconciliation = (): void => {
            void service
                .reconcileAllGuilds(DISCORD_CLIENT)
                .catch((error) => {
                    logIsolatedVoiceXpError('startup reconcile', error);
                })
                .finally(() => {
                    try {
                        startVoiceSessionReconcileScheduler(DISCORD_CLIENT, service);
                    } catch (error) {
                        logIsolatedVoiceXpError('reconcile scheduler start', error);
                    }
                });
        };

        if (DISCORD_CLIENT.isReady()) {
            startVoiceReconciliation();
        } else {
            DISCORD_CLIENT.once(Events.ClientReady, startVoiceReconciliation);
        }
    } catch (error) {
        logIsolatedVoiceXpError('tracking startup', error);
    }
}

export function stopLeveling(): void {
    stopVoiceSessionReconcileScheduler();
}

export function resetLevelingInitializationForTests(): void {
    stopVoiceSessionReconcileScheduler();
    levelingInitialized = false;
    levelingService = null;
}
