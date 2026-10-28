import { database } from '../../../features-system/data-persistence/database';
import { flowJourneyLinksRepo, journeysRepo } from '../../provisioning';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { flowsRepo } from '../data/flowsRepo';
import { describeFlowCycle, findFlowCycleThrough } from '../engine/flowCycles';
import { describeIssue } from '../engine/nodeDataValidation';
import { flowReadinessIssues } from '../logic/flowReadiness';
import { NEW_FLOW_SCOPE } from '../logic/readinessScope';
import { buildOnboardingFlowGraph } from './onboardingFlow';

/** The seeded flow's id in the loop check, before it has a real one. Never a UUID, so never a stored flow's. */
const UNSAVED_FLOW_ID = 'unsaved-onboarding-flow';

/**
 * Seed the canonical onboarding flow for a guild:
 *   trigger.buttonClick ("Agree to Rules") -> action.assignRole -> action.sendDM,
 * and its journey: the given channel, adopted, and the rules panel posted in it, whose
 * one button the trigger listens to.
 *
 * Usage (sqlite dev DB):
 *   DB_TYPE=sqlite SQLITE_DB_PATH=./data/bot.sqlite \
 *   DISCORD_APP_ID=x DISCORD_BOT_TOKEN=x OPENROUTER_API_KEY=x OPENAI_API_KEY=x \
 *   pnpm tsx src/features/flows/templates/seedOnboardingFlow.ts <guildId> <memberRoleId> <channelId> [welcomeMessage]
 *
 * Then install its resources from the dashboard, which posts the panel.
 */
async function main(): Promise<void> {
    const [, , guildId, memberRoleId, channelId, welcomeMessageArg] = process.argv;

    // The channel is required here rather than defaulted, because the journey adopts it
    // for the rules panel, and a journey adopting nothing would leave the panel nowhere
    // to go — a failure a long way from this script.
    if (!guildId || !memberRoleId || !channelId) {
        console.error(
            'Usage: tsx src/features/flows/templates/seedOnboardingFlow.ts <guildId> <memberRoleId> <channelId> [welcomeMessage]'
        );
        process.exitCode = 1;
        return;
    }

    const welcomeMessage =
        welcomeMessageArg ??
        'Welcome, you filthy little rule-follower. You have your role now — go enjoy the server. 😈';

    const { graph, resources } = buildOnboardingFlowGraph({ memberRoleId, channelId, welcomeMessage });

    // Readiness validates the graph against what each block declares, so the
    // registry has to be populated first. The bot does this in init; a script
    // has to say so itself.
    await ensureBlocksDiscovered();

    // The repo stores anything structurally sound, and this seeds the flow switched
    // on — so it asks the question the enable route asks, against the journey the seed
    // is about to write: the trigger names the panel's button, which only it declares.
    // No flow id yet, and no other flow in the journey: the seed's trigger names a journey button.
    const issues = flowReadinessIssues(graph, { ...NEW_FLOW_SCOPE, declarations: resources });
    if (issues.length > 0) {
        throw new Error(
            `The onboarding template is not ready to go live: ${issues.map(describeIssue).join('; ')}`
        );
    }

    // And the other question every switch-on asks: would it close a loop with the guild's
    // live flows? The template causes nothing today, so this cannot fail yet — it is here
    // so a template that learns to cannot slip past. The new flow has no id until it is
    // written, so it is judged under a placeholder no stored flow can hold.
    const name = 'Onboarding: Agree to Rules';
    const liveFlows = (await flowsRepo.getByGuildId(guildId)).filter((flow) => flow.enabled);
    const cycle = findFlowCycleThrough([...liveFlows, { flowId: UNSAVED_FLOW_ID, name, graph }], UNSAVED_FLOW_ID);
    if (cycle) {
        throw new Error(`The onboarding template cannot go live here. ${describeFlowCycle(cycle)}`);
    }

    const flow = await flowsRepo.create({
        guildId,
        name,
        graph,
        enabled: true,
    });

    // The flow's own journey, as the builder's first resources save writes it: keyed by
    // the flow's id, named after it, and linked.
    const journey = await journeysRepo.create({
        guildId,
        journeyKey: flow.flowId,
        name,
        resources,
        createdForFlowId: flow.flowId,
    });
    await flowJourneyLinksRepo.attach({ guildId, flowId: flow.flowId, journeyKey: journey.journeyKey });

    console.log('✅ Seeded onboarding flow.');
    console.log(`   flowId:  ${flow.flowId}`);
    console.log(`   guildId: ${flow.guildId}`);
    console.log(`   enabled: ${flow.enabled}`);
    console.log('');
    console.log(`Next: Install its resources from the dashboard. That posts the rules panel in <#${channelId}>.`);
}

void main()
    .catch((error: unknown) => {
        console.error('❌ Failed to seed onboarding flow:', error);
        process.exitCode = 1;
    })
    .finally(() => {
        void database.destroy();
    });
