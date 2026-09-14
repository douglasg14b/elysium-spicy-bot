import type { Channel, GuildTextBasedChannel } from 'discord.js';

/**
 * The channel a run is operating in, or nothing when the event did not happen in
 * one the run can use.
 *
 * Two dispatchers need this and would otherwise each write their own narrowing,
 * which is how two call sites end up disagreeing about what counts as a usable
 * channel. The rule is stated once here instead.
 *
 * Each rejected case is a real, modelled state rather than a swallowed problem:
 * an interaction can genuinely carry no channel, a DM is not somewhere a guild
 * run can post, and a forum or media parent holds threads rather than messages.
 * A voice or stage channel is **kept** — both carry a text chat in v14, so both
 * are somewhere a run can legitimately be.
 *
 * The context models an absent channel precisely so none of those has to be
 * treated as an error — a member join establishes no channel at all and is an
 * entirely ordinary run.
 */
export function asGuildTextChannel(candidate: Channel | null | undefined): GuildTextBasedChannel | undefined {
    if (!candidate || candidate.isDMBased() || !candidate.isTextBased()) {
        return undefined;
    }

    return candidate;
}
