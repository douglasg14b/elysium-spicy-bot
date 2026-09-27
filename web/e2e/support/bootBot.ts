import { migrateTestDatabase } from '../../../src/features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { ensureBlocksDiscovered } from '../../../src/features/flows/blocks/registry';
import { applyResourcesToFlows } from '../../../src/features/flows/logic/applyResourcesToFlows';
import { registerResourceWriteBack } from '../../../src/features/provisioning';

/**
 * What `bot.ts` does before its web server answers, minus the gateway: migrate the
 * database, discover the flow blocks, and tell provisioning where to write the ids it
 * creates. `initFlows` does the last two in production; its gateway listeners and run
 * scheduler are left out because nothing here runs flows.
 *
 * Without discovery, `/api/nodes` and every graph save throw. Without the write-back, an
 * install succeeds and wires nothing into the flows that picked its resources.
 */
export async function bootBotForDashboard(): Promise<void> {
    await migrateTestDatabase();
    await ensureBlocksDiscovered();
    registerResourceWriteBack(applyResourcesToFlows);
}
