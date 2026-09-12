import { Events } from 'discord.js';
import { interactionsRegistry } from '../../features-system/commands';
import { DISCORD_CLIENT } from '../../discordClient';
import { flowDeployCommand, handleFlowDeployCommand } from './commands/flowDeployCommand';
import { FLOW_CUSTOM_ID_PREFIX } from './constants';
import { startFlowRunScheduler } from './engine/flowRunScheduler';
import { handleFlowButtonInteraction } from './engine/flowTriggerDispatch';
import { handleMemberJoin } from './engine/memberJoinDispatch';
import { handleReactionAdd } from './engine/reactionAddDispatch';

let flowsInitialized = false;

export function initFlows(): void {
    if (flowsInitialized) {
        return;
    }

    flowsInitialized = true;

    // Admin slash command to post a flow's trigger button(s) to a channel.
    interactionsRegistry.register(flowDeployCommand, handleFlowDeployCommand);

    // Single `flow:` catch-all dispatcher for dynamic `flow:<flowId>:<nodeId>`
    // button ids. Additive prefix registration — exact-match handlers are
    // untouched and always take precedence.
    interactionsRegistry.registerDynamic(`${FLOW_CUSTOM_ID_PREFIX}:`, (interaction) => {
        if (!interaction.isButton()) {
            return Promise.resolve({
                status: 'skipped' as const,
                message: 'Flow triggers only support buttons for now.',
            });
        }
        return handleFlowButtonInteraction(interaction);
    });

    // Gateway trigger: member joins (requires the GuildMembers intent, present).
    DISCORD_CLIENT.on(Events.GuildMemberAdd, (member) => {
        void handleMemberJoin(member).catch((error) => {
            console.error('[flows] Error handling member join:', error);
        });
    });

    // Gateway trigger: reaction added (requires the GuildMessageReactions intent
    // plus the Message/Reaction partials — both configured on the client).
    DISCORD_CLIENT.on(Events.MessageReactionAdd, (reaction, user) => {
        void handleReactionAdd(reaction, user).catch((error) => {
            console.error('[flows] Error handling reaction add:', error);
        });
    });

    // Durable runs: poll for delays/timeouts that have come due. Started from
    // ClientReady (not here) because resuming needs a usable client — and the
    // scheduler sweeps once immediately so delays that elapsed while the bot was
    // down fire straight away. Mirrors the birthday scheduler's lifecycle.
    DISCORD_CLIENT.once(Events.ClientReady, (readyClient) => {
        startFlowRunScheduler(readyClient);
    });
}

export function resetFlowsInitializationForTests(): void {
    flowsInitialized = false;
}
