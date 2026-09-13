import { database } from '../../../features-system/data-persistence/database';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { flowsRepo } from '../data/flowsRepo';
import { buildOnboardingFlowGraph } from './onboardingFlow';

/**
 * Seed the canonical onboarding flow for a guild:
 *   trigger.buttonClick ("Agree to Rules") -> action.assignRole -> action.sendDM.
 *
 * Usage (sqlite dev DB):
 *   DB_TYPE=sqlite SQLITE_DB_PATH=./data/bot.sqlite \
 *   DISCORD_APP_ID=x DISCORD_BOT_TOKEN=x OPENROUTER_API_KEY=x OPENAI_API_KEY=x \
 *   pnpm tsx src/features/flows/templates/seedOnboardingFlow.ts <guildId> <memberRoleId> [welcomeMessage]
 *
 * Then deploy the button in Discord with:  /flow-deploy flow-id:<printed flowId>
 */
async function main(): Promise<void> {
    const [, , guildId, memberRoleId, welcomeMessageArg] = process.argv;

    if (!guildId || !memberRoleId) {
        console.error(
            'Usage: tsx src/features/flows/templates/seedOnboardingFlow.ts <guildId> <memberRoleId> [welcomeMessage]'
        );
        process.exitCode = 1;
        return;
    }

    const welcomeMessage =
        welcomeMessageArg ??
        'Welcome, you filthy little rule-follower. You have your role now — go enjoy the server. 😈';

    const { graph } = buildOnboardingFlowGraph({ memberRoleId, welcomeMessage });

    // Saving validates the graph against what each block declares, so the
    // registry has to be populated first. The bot does this in init; a script
    // has to say so itself.
    await ensureBlocksDiscovered();

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
