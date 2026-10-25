import { commandSkipped } from '../../../features-system/commands';
import type { InteractionHandlerResult, MessageComponentInteraction } from '../../../features-system/commands/types';

/**
 * What a press on a message resource's button answers while nothing listens to it, sent
 * only to the presser. In the bot's voice, for Douglas to tune.
 */
export const NOTHING_HOOKED_UP = "Nothing's hooked up to this yet. Poke it all you like, babe — it isn't going to put out.";

/**
 * The one handler for every `mbtn:<buttonKey>` press — the buttons under a message a journey
 * posts (`messageButtons.ts` in provisioning, which owns the prefix). Registered once, by
 * `initFlows`: the registry refuses a second handler for a prefix.
 *
 * **The hand-off to step 3.** In step 2 it reads nothing, writes nothing, and wakes no
 * parked Wait for Event run — whether a message button should, as a `flow:` press does, is
 * step 3's call. Step 3 replaces only this body: message id → its binding → the one trigger
 * listening to this button → that trigger's gate → the run, with {@link NOTHING_HOOKED_UP}
 * as the answer when nothing listens.
 *
 * Answers through the result rather than replying itself: the registry sends a `skipped`
 * result's message as an ephemeral reply.
 */
export function handleMessageButtonPress(interaction: MessageComponentInteraction): Promise<InteractionHandlerResult> {
    if (!interaction.isButton()) {
        return Promise.resolve(commandSkipped('Message resources only carry buttons.'));
    }
    return Promise.resolve(commandSkipped(NOTHING_HOOKED_UP));
}
