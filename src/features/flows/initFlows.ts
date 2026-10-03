import { Events } from 'discord.js';
import { interactionsRegistry } from '../../features-system/commands';
import { DISCORD_CLIENT } from '../../discordClient';
import { registerActivitySubscriber } from '../../features-system/activity';
import { registerLevelUpSubscriber } from '../leveling';
import { registerResourceWriteBack } from '../provisioning';
import { applyResourcesToFlows } from './logic/applyResourcesToFlows';
import { ensureBlocksDiscovered } from './blocks/registry';
import { flowDeployCommand, handleFlowDeployCommand } from './commands/flowDeployCommand';
import { FLOW_CHOICE_CUSTOM_ID_PREFIX, FLOW_CUSTOM_ID_PREFIX } from './constants';
import { flowsRepo } from './data/flowsRepo';
import { handleFlowChoiceInteraction } from './engine/flowChoiceDispatch';
import { startFlowRunScheduler } from './engine/flowRunScheduler';
import { handleFlowButtonInteraction } from './engine/flowTriggerDispatch';
import { handleLevelUp } from './engine/levelUpDispatch';
import { handleMemberJoin } from './engine/memberJoinDispatch';
import { handleMemberLeave } from './engine/memberLeaveDispatch';
import { handleMessage } from './engine/messageTriggerDispatch';
import { messageTriggerIndex } from './engine/messageTriggerIndex';
import { handleReactionAdd } from './engine/reactionAddDispatch';

let initialization: Promise<void> | undefined;

/**
 * Wire the flow engine up.
 *
 * Awaited, and awaited early, because blocks are discovered from the filesystem:
 * nothing that can start or resume a run — the deploy command, the `flow:` button
 * dispatcher, the gateway listeners, the durable-run scheduler — is
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

    // Tell provisioning where to write the ids it creates.
    //
    // Registered from this side because the dependency only runs one way: flows
    // consume the provisioning barrel, and provisioning must not know flows exist.
    // Without this line an install still succeeds and simply writes nothing back.
    registerResourceWriteBack(applyResourcesToFlows);

    // Tell leveling to notify us when somebody levels up.
    //
    // Registered from this side for the same reason as the write-back above: leveling is
    // a base capability and must not know flows exist. Without this line a level-up still
    // announces and simply starts no runs.
    //
    // Safe despite `initLeveling()` running before `initFlows()` in `bot.ts`: this hands
    // over a callback rather than reading the block registry, and the registry is only
    // consulted when a level-up actually arrives — long after `ensureBlocksDiscovered`
    // above has completed.
    registerLevelUpSubscriber(handleLevelUp);

    // Tell activity to hand us every message it records: to wake runs waiting on one, then
    // to start Message Sent runs — in that order, inside one subscriber, so a run this
    // message starts is never woken by the same message.
    //
    // A subscriber rather than a `MessageCreate` listener of our own, so the activity row
    // is written before a woken or started run reads the record. The message-wait index
    // is empty until the scheduler's startup sweep loads it, which is after ClientReady —
    // and no message arrives before that anyway. The trigger index loads each guild on
    // its first message.
    registerActivitySubscriber(handleMessage);

    // Drop the in-memory Message Sent triggers after every committed flow write — a save,
    // a switch on or off, a delete, an install writing ids back — so what fires changes
    // without a restart. Registered from this side so `data/` never imports `engine/`.
    flowsRepo.registerAfterWrite(() => messageTriggerIndex.invalidate());

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

    // Answers to questions parked runs asked: `flowc:<runId>:<nodeId>:<index>`.
    //
    // Sits safely beside `flow:` because `resolveDynamicHandler` keeps the
    // longest matching prefix — not because of the trailing colons, which is the
    // tempting and wrong reading. See `FLOW_CHOICE_CUSTOM_ID_PREFIX`.
    interactionsRegistry.registerDynamic(`${FLOW_CHOICE_CUSTOM_ID_PREFIX}:`, (interaction) => {
        if (!interaction.isButton()) {
            return Promise.resolve({
                status: 'skipped' as const,
                message: 'Flow answers only support buttons for now.',
            });
        }
        return handleFlowChoiceInteraction(interaction);
    });

    // Gateway trigger: member joins (requires the GuildMembers intent, present).
    DISCORD_CLIENT.on(Events.GuildMemberAdd, (member) => {
        void handleMemberJoin(member).catch((error) => {
            console.error('[flows] Error handling member join:', error);
        });
    });

    // Gateway trigger: member leaves, by any route. Requires the GuildMembers intent
    // and the GuildMember partial — without the partial, discord.js drops the event
    // for any member it had not cached.
    DISCORD_CLIENT.on(Events.GuildMemberRemove, (member) => {
        void handleMemberLeave(member).catch((error) => {
            console.error('[flows] Error handling member leave:', error);
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
