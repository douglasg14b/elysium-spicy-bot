import { database } from '../../../features-system/data-persistence/database';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { flowsRepo } from '../data/flowsRepo';
import { describeFlowCycle, findFlowCycleThrough } from '../engine/flowCycles';
import { describeIssue } from '../engine/nodeDataValidation';
import { flowReadinessIssues } from '../logic/flowReadiness';
import { buildOnboardingFlowGraph } from './onboardingFlow';

/** The seeded flow's id in the loop check, before it has a real one. Never a UUID, so never a stored flow's. */
const UNSAVED_FLOW_ID = 'unsaved-onboarding-flow';

/**
 * Seed the canonical onboarding flow for a guild:
 *   trigger.buttonClick ("Agree to Rules") -> action.assignRole -> action.sendDM.
 *
 * Usage (sqlite dev DB):
 *   DB_TYPE=sqlite SQLITE_DB_PATH=./data/bot.sqlite \
 *   DISCORD_APP_ID=x DISCORD_BOT_TOKEN=x OPENROUTER_API_KEY=x OPENAI_API_KEY=x \
 *   pnpm tsx src/features/flows/templates/seedOnboardingFlow.ts <guildId> <memberRoleId> <channelId> [welcomeMessage]
 *
 * Then deploy the button in Discord with:  /flow-deploy flow-id:<printed flowId>
 */
async function main(): Promise<void> {
    const [, , guildId, memberRoleId, channelId, welcomeMessageArg] = process.argv;

    // The channel is required here rather than defaulted, because the button trigger
    // carries its own destination now and a flow seeded without one saves fine and
    // then refuses to deploy — a failure a long way from this script.
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

    const { graph } = buildOnboardingFlowGraph({ memberRoleId, channelId, welcomeMessage });

    // Readiness validates the graph against what each block declares, so the
    // registry has to be populated first. The bot does this in init; a script
    // has to say so itself.
    await ensureBlocksDiscovered();

    // The repo stores anything structurally sound, and this seeds the flow switched
    // on — so it asks the question the enable route asks. Nothing is declared: the
    // flow is new, and this template picks real ids.
    const issues = flowReadinessIssues(graph, new Set<string>());
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

    console.log('✅ Seeded onboarding flow.');
    console.log(`   flowId:  ${flow.flowId}`);
    console.log(`   guildId: ${flow.guildId}`);
    console.log(`   enabled: ${flow.enabled}`);
    console.log('');
    console.log(`Next: run /flow-deploy flow-id:${flow.flowId} to post the button in <#${channelId}>.`);
}

void main()
    .catch((error: unknown) => {
        console.error('❌ Failed to seed onboarding flow:', error);
        process.exitCode = 1;
    })
    .finally(() => {
        void database.destroy();
    });
