import type { ButtonInteraction } from 'discord.js';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';

/**
 * Renders a ticket failure as user-facing copy.
 *
 * `Result`'s error slot is typed `Error | string`, but `FailResult`'s
 * constructor normalises strings to `Error` at runtime — so `.error` is always
 * an `Error` object regardless of what the declared type says, and interpolating
 * it directly yields the literal text `Error: ❌ …`. Narrowing the service's
 * return types instead does not work: `fail('literal')` produces
 * `FailResult<string>`, which is not assignable to `FailResult<Error>`.
 *
 * Both shapes are handled here so no caller has to know which lie it is holding.
 */
export function ticketErrorMessage(error: Error | string): string {
    return typeof error === 'string' ? error : error.message;
}

/**
 * Tells the member why their button press failed, and returns the handler result.
 *
 * Returning `{ status: 'error', message }` is *not* enough on its own. The
 * registry only auto-replies while the interaction is neither replied nor
 * deferred (`interactionsRegistry.ts`), so once a handler has called
 * `deferUpdate` every message it returns is recorded and then discarded. That
 * silence lands on exactly the cases worth reporting: two moderators racing the
 * claim button, a close that lost to another close, a database outage.
 *
 * `followUp` rather than `editReply`, matching `flowChoiceDispatch`: after
 * `deferUpdate` there is no reply to edit, and `editReply` would instead rewrite
 * the ticket message the button is attached to — blanking the embed and
 * replacing it with an error.
 */
export async function replyTicketFailure(
    interaction: ButtonInteraction,
    message: string
): Promise<InteractionHandlerResult> {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: message, ephemeral: true });
        } else {
            await interaction.reply({ content: message, ephemeral: true });
        }
    } catch (error) {
        console.error('Failed to deliver ticket failure message:', error);
    }

    return { status: 'error', message };
}
