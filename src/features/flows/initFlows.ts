import { Events } from 'discord.js';
import { interactionsRegistry } from '../../features-system/commands';
import { DISCORD_CLIENT } from '../../discordClient';
import { ensureBlocksDiscovered } from './blocks/registry';
import { flowDeployCommand, handleFlowDeployCommand } from './commands/flowDeployCommand';
import { FLOW_CUSTOM_ID_PREFIX } from './constants';
import { startFlowRunScheduler } from './engine/flowRunScheduler';
import { handleFlowButtonInteraction } from './engine/flowTriggerDispatch';
import { handleMemberJoin } from './engine/memberJoinDispatch';
import { handleReactionAdd } from './engine/reactionAddDispatch';

let initialization: Promise<void> | undefined;

/**
 * Wire the flow engine up.
 *
 * Awaited, and awaited early, because blocks are discovered from the filesystem:
 * nothing that can start or resume a run — the deploy command, the `flow:` button
 * dispatcher, the two gateway listeners, the durable-run scheduler — is
 * registered until the registry is populated. The in-process web server starts
 * after this returns, so the builder's palette and graph validation cannot race
 * the scan either.
 *
 * Idempotent by memoizing the work rather than by flipping a flag: a second
 * caller awaits the same completion. A flag set before the await would tell that
 * caller initialization had finished while the scan was still running, which is
 * the very race this function exists to close.
 */
export function initFlows(): Promise<void> {
    initialization ??= initializeFlows();
    return initialization;
}

async function initializeFlows(): Promise<void> {
    await ensureBlocksDiscovered();

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
