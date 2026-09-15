import { ActionRowBuilder, ButtonBuilder, ComponentType, DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import type { GuildTextBasedChannel, Message, MessageActionRowComponent } from 'discord.js';

/**
 * Release the controls on the message a park was waiting on, by disabling them.
 *
 * A block that parks by posting buttons leaves behind something that outlives the
 * park: the message sits in the channel with live controls on it long after the
 * run has moved on. A press and a `wakeAt` coming due both arrive here, by way of
 * the resume path, so neither closing route can forget to tidy up. Which of the
 * two happened is deliberately not distinguished: from the channel's side it is
 * one fact, and a message announcing *how* it closed would tell everyone who can
 * see it something only the presser is told.
 *
 * **Cancellation does not reach here yet, and is the caller's job when it does.**
 * `FlowRunsRepo.cancel` has no production call site — nothing in the running bot
 * cancels a run, because the operations view that would expose it does not exist —
 * and a cancellation would not go through the resume path in any case. Terminal
 * transitions clear `waitMessageId`, so a cancelled run's controls are already
 * refused by the claim; what is missing is only the edit, and whatever first
 * cancels a run should call this itself.
 *
 * **Disabled rather than deleted.** The posted message is the only record in the
 * channel that the run asked anything at all, and deleting it would erase that for
 * everyone who saw it. Disabling leaves the exchange legible and makes pressing
 * impossible in the client.
 *
 * **This is tidiness, not the guard.** Discord greys the controls out for anyone
 * who loads the message afterwards, but a client holding a stale render can still
 * send the press, and an edit that fails leaves the controls live indefinitely.
 * What actually stops a stale press advancing the run is the park-scoped claim in
 * `FlowRunsRepo.claimForResume` — this only means a member rarely gets far enough
 * to be refused. Treating the edit as the guard would be trusting a remote
 * client's rendering with the run's integrity.
 *
 * Knows nothing about what the controls were *for*: it rebuilds whatever rows the
 * message carries and disables them. That is what lets it live in the engine,
 * where the block that happens to ask questions may not be named.
 */
export async function releaseWaitMessageControls(
    channel: GuildTextBasedChannel | undefined,
    messageId: string | null | undefined
): Promise<void> {
    if (!channel || !messageId) {
        // A run that parked nowhere, or a park that posted nothing. Not a failure:
        // a delay and a gateway wait both look exactly like this.
        return;
    }

    try {
        const message = await channel.messages.fetch(messageId);
        await message.edit({ components: controlsReleased(message.components) });
    } catch (error) {
        // Swallowed deliberately, which is sound *here specifically*: this runs
        // after the run has already moved on, so there is nothing left to abort,
        // and failing a run because a cosmetic edit lost a race would end a
        // member's journey over a tidy-up. The press it guards against is refused
        // by the claim either way.
        //
        // Classified rather than logged as one line, following the same reasoning
        // as `flowRunResume.ts`'s channel handling: a message somebody deleted is
        // nothing to do, whereas a permission the bot has lost will recur on every
        // question this guild ever asks, and the two are not the same operational
        // fact even though neither stops the run.
        if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) {
            // Deleted, or purged with its channel. There is nothing left to
            // disable, which is the outcome this function wanted anyway.
            return;
        }

        console.warn(
            `[flows] Could not release the controls on message ${messageId}; they may stay pressable. ` +
                'The run has moved on regardless, and a press on them is refused by the claim' +
                (error instanceof DiscordAPIError && PERMANENT_EDIT_REFUSALS.has(error.code)
                    ? ' — but this is a permission the bot is missing, so it will recur on every question in this channel:'
                    : ':'),
            error
        );
    }
}

/**
 * The refusals that will not fix themselves.
 *
 * Separated from a transient 5xx or rate limit purely so the log says which it
 * was: nothing here is retried, because the run has already moved on by the time
 * this function is reached. `MissingAccess` and `MissingPermissions` mean the bot
 * can no longer edit in this channel, so every question asked there will leave its
 * buttons live — worth saying once per occurrence rather than leaving an operator
 * to infer it from a stack trace.
 */
const PERMANENT_EDIT_REFUSALS: ReadonlySet<number | string> = new Set<number | string>([
    RESTJSONErrorCodes.MissingAccess,
    RESTJSONErrorCodes.MissingPermissions,
]);

/**
 * The message's own button rows, every button in them disabled.
 *
 * Rebuilt from what the message actually carries rather than from any block's
 * config, so a message posted by a build or an author since changed keeps the
 * controls it really has.
 *
 * **Custom ids are left intact.** A disabled button that kept its id still parses
 * if a stale client replays it, and is then refused by the claim for the true
 * reason; one with a rewritten id would be refused as malformed, which would say
 * something untrue about why it did not work.
 *
 * Rows that are not button rows are dropped rather than rebuilt. Nothing in this
 * engine posts one today — `SupportedInteractionBuilder` carries no select menus —
 * so this cannot silently discard live controls; and rebuilding a component kind
 * this function does not understand would be worse than omitting it, because
 * `ButtonBuilder.from` would either throw or produce something other than what was
 * there.
 */
function controlsReleased(rows: Message['components']): ActionRowBuilder<ButtonBuilder>[] {
    const narrowed: ActionRowBuilder<ButtonBuilder>[] = [];

    for (const row of rows) {
        if (row.type !== ComponentType.ActionRow) {
            continue;
        }

        const buttons = row.components.filter(
            (control): control is Extract<MessageActionRowComponent, { type: ComponentType.Button }> =>
                control.type === ComponentType.Button
        );
        if (buttons.length === 0) {
            continue;
        }

        narrowed.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                buttons.map((button) => ButtonBuilder.from(button).setDisabled(true))
            )
        );
    }

    return narrowed;
}
