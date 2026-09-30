import { database } from '../../../features-system/data-persistence/database';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { flowsRepo } from '../data/flowsRepo';
import { describeIssue } from '../engine/nodeDataValidation';
import { flowReadinessIssues } from '../logic/flowReadiness';
import { buildOnboardingFlowGraph } from './onboardingFlow';

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

    const flow = await flowsRepo.create({
        guildId,
        name: 'Onboarding: Agree to Rules',
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
