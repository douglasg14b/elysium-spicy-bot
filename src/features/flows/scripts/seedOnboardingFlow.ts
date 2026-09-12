import { database } from '../../../features-system/data-persistence/database';
import { flowsRepo } from '../data/flowsRepo';
import { buildOnboardingFlowGraph } from '../logic/onboardingFlow';

/**
 * Seed the canonical onboarding flow for a guild:
 *   trigger.buttonClick ("Agree to Rules") -> action.assignRole -> action.sendDM.
 *
 * Usage (sqlite dev DB):
 *   DB_TYPE=sqlite SQLITE_DB_PATH=./data/bot.sqlite \
 *   DISCORD_APP_ID=x DISCORD_BOT_TOKEN=x OPENROUTER_API_KEY=x OPENAI_API_KEY=x \
 *   pnpm tsx src/features/flows/scripts/seedOnboardingFlow.ts <guildId> <memberRoleId> [welcomeMessage]
 *
 * Then deploy the button in Discord with:  /flow-deploy flow-id:<printed flowId>
 */
async function main(): Promise<void> {
    const [, , guildId, memberRoleId, welcomeMessageArg] = process.argv;

    if (!guildId || !memberRoleId) {
        console.error(
            'Usage: tsx src/features/flows/scripts/seedOnboardingFlow.ts <guildId> <memberRoleId> [welcomeMessage]'
        );
        process.exitCode = 1;
        return;
    }

    const welcomeMessage =
        welcomeMessageArg ??
        'Welcome, you filthy little rule-follower. You have your role now — go enjoy the server. 😈';

    const { graph } = buildOnboardingFlowGraph({ memberRoleId, welcomeMessage });

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
    console.log(`Next: run /flow-deploy flow-id:${flow.flowId} in the target channel to post the button.`);
}

void main()
    .catch((error: unknown) => {
        console.error('❌ Failed to seed onboarding flow:', error);
        process.exitCode = 1;
    })
    .finally(() => {
        void database.destroy();
    });
