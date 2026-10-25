import { registerUploadUsageReader } from '../../features-system/guild-uploads';
import { journeyMessageUploadUses } from './logic/journeyMessageUploadUses';

/**
 * Wire provisioning up: tell guild-uploads where journeys show uploaded pictures — in the
 * messages they declare as resources — so the dashboard lists each picture's uses and
 * refuses to delete one a journey's message still shows.
 *
 * Registered from this side because guild-uploads imports no feature. Called once by every
 * boot root that serves the dashboard, beside flows' own reader: `bot.ts` before
 * `initFlows`, and the dashboard harness (`web/e2e/support/bootBot.ts`).
 */
export function initProvisioning(): void {
    registerUploadUsageReader(journeyMessageUploadUses);
}
