import { migrateTestDatabase } from '../../../src/features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { ensureBlocksDiscovered } from '../../../src/features/flows/blocks/registry';
import { flowsRepo } from '../../../src/features/flows/data/flowsRepo';
import { registerUploadUsageReader } from '../../../src/features-system/guild-uploads';
import { applyResourcesToFlows } from '../../../src/features/flows/logic/applyResourcesToFlows';
import { flowUploadUses } from '../../../src/features/flows/logic/flowUploadUses';
import { registerScheduleReconcile } from '../../../src/features/flows/logic/reconcileGuildSchedules';
import { initProvisioning, registerResourceWriteBack } from '../../../src/features/provisioning';
import { registerTicketTypeProvisioning } from '../../../src/features/tickets/logic/ticketTypeProvisioning';

/**
 * What `bot.ts` does before its web server answers, minus the gateway: migrate the
 * database, discover the flow blocks, tell provisioning where to write the ids it
 * creates and how to reach ticket types, tell guild-uploads where journeys' messages and
 * flows show pictures (`initProvisioning`, then flows' reader), and
 * keep each guild's schedules in step with its saved flows. `initFlows` and
 * `initTicketsFeature` do those in production; their gateway listeners and run scheduler
 * are left out because nothing here runs flows.
 *
 * Without discovery, `/api/nodes` and every graph save throw. Without the write-back, an
 * install succeeds and wires nothing into the flows that picked its resources. Without the
 * ticket type provider, installing a journey that declares a ticket type throws. Without
 * the upload usage reader, the uploads list and every upload delete throw. Without the
 * reconcile, a saved schedule never gets a next time for the builder to count down to.
 *
 * The preview server boots through here too (`startPreview`), so it needs no copy of its own.
 */
export async function bootBotForDashboard(): Promise<void> {
    await migrateTestDatabase();
    await ensureBlocksDiscovered();
    registerResourceWriteBack(applyResourcesToFlows);
    registerTicketTypeProvisioning();
    initProvisioning();
    registerUploadUsageReader(flowUploadUses);
    registerScheduleReconcile(flowsRepo);
}
