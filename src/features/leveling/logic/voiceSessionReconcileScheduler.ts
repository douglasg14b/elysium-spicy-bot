import type { Client, Guild } from 'discord.js';
import {
    VOICE_GUILD_SWEEP_DELAY_MS,
    VOICE_GUILD_SWEEP_DELAY_THRESHOLD,
    VOICE_SESSION_RECONCILE_INTERVAL_MS,
} from '../constants';
import { levelingConfigRepo } from '../data/levelingConfigRepo';
import { levelingVoiceSessionRepo } from '../data/levelingVoiceSessionRepo';
import type { LevelingService } from '../levelingService';
import { logIsolatedVoiceXpError } from './voiceXp';

export type VoiceSessionReconcileSchedulerDependencies = {
    listEnabledGuildIds: () => Promise<string[]>;
    listGuildIdsWithOpenSessions: () => Promise<string[]>;
    reconcileGuild: (guild: Guild) => Promise<void>;
    delay: (ms: number) => Promise<void>;
};

let voiceSessionReconcileInterval: ReturnType<typeof setInterval> | null = null;
let isTickRunning = false;

const defaultDelay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export function startVoiceSessionReconcileScheduler(
    client: Client,
    levelingService: LevelingService,
    intervalMs: number = VOICE_SESSION_RECONCILE_INTERVAL_MS
): void {
    if (voiceSessionReconcileInterval) {
        return;
    }

    voiceSessionReconcileInterval = setInterval(() => {
        void runVoiceSessionReconcileTick(client, {
            listEnabledGuildIds: () => levelingConfigRepo.listEnabledGuildIds(),
            listGuildIdsWithOpenSessions: () => levelingVoiceSessionRepo.listGuildIdsWithOpenSessions(),
            reconcileGuild: (guild) => levelingService.reconcileGuild(guild),
            delay: defaultDelay,
        }).catch((error) => {
            logIsolatedVoiceXpError('reconcile tick', error);
        });
    }, intervalMs);

    console.info(`[leveling] Voice session reconcile scheduler started with interval ${intervalMs}ms`);
}

export function stopVoiceSessionReconcileScheduler(): void {
    if (voiceSessionReconcileInterval) {
        clearInterval(voiceSessionReconcileInterval);
        voiceSessionReconcileInterval = null;
        console.info('[leveling] Voice session reconcile scheduler stopped');
    }

    isTickRunning = false;
}

export async function runVoiceSessionReconcileTick(
    client: Client,
    dependencies: VoiceSessionReconcileSchedulerDependencies
): Promise<void> {
    if (isTickRunning) {
        console.info('[leveling] Skipping voice reconcile tick because previous tick is still running');
        return;
    }

    if (!client.user) {
        console.info('[leveling] Skipping voice reconcile tick because Discord client user is not ready yet');
        return;
    }

    isTickRunning = true;

    try {
        const [enabledGuildIds, openSessionGuildIds] = await Promise.all([
            dependencies.listEnabledGuildIds(),
            dependencies.listGuildIdsWithOpenSessions(),
        ]);
        const guildIds = [...new Set([...enabledGuildIds, ...openSessionGuildIds])];
        const shouldDelay = guildIds.length > VOICE_GUILD_SWEEP_DELAY_THRESHOLD;

        for (const [index, guildId] of guildIds.entries()) {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) {
                continue;
            }

            try {
                await dependencies.reconcileGuild(guild);
            } catch (error) {
                logIsolatedVoiceXpError(`reconcile tick for guild ${guildId}`, error);
            }

            if (shouldDelay && index < guildIds.length - 1) {
                await dependencies.delay(VOICE_GUILD_SWEEP_DELAY_MS);
            }
        }
    } finally {
        isTickRunning = false;
    }
}

export function resetVoiceSessionReconcileSchedulerForTests(): void {
    stopVoiceSessionReconcileScheduler();
}
