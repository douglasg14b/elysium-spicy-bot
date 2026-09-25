import type { Client, Guild } from 'discord.js';
import { levelingConfigRepo } from './data/levelingConfigRepo';
import { levelingProgressRepo } from './data/levelingProgressRepo';
import { announceLevelUp } from './levelUpAnnouncer';
import { getLevelFromTotalXp } from './logic/xpCalculator';

/**
 * Grant XP on purpose, as a flow does, rather than as a reward for activity.
 *
 * Leveling's own grants run through `LevelingService`, which is driven by gateway events
 * and holds a voice-session coordinator. A flow has neither, so this is a separate entry
 * point rather than a method reached through that instance — which is also unexported.
 */
export type AwardFlowXpInput = {
    readonly client: Client;
    readonly guild: Guild;
    readonly userId: string;
    /** Positive. A flow cannot take XP away; see `FlowXpRefusal`. */
    readonly xpAmount: number;
};

/**
 * Why a grant did not happen, when the reason is the caller's to report.
 *
 * `disabled` is not a failure: a guild that has not turned leveling on has no progress
 * rows and no curve, and inventing them because a flow asked would make the feature
 * half-on in a way no operator chose.
 */
export type FlowXpRefusal = 'disabled' | 'not-positive';

export type AwardFlowXpResult =
    | {
          readonly ok: true;
          readonly previousLevel: number;
          readonly newLevel: number;
          readonly totalXp: number;
      }
    | { readonly ok: false; readonly refusal: FlowXpRefusal };

/**
 * Award XP to a member from a flow, announcing any level-up it causes.
 *
 * **Deliberately does not notify level-up subscribers.** A flow-awarded level-up
 * announces to the guild exactly as an earned one does, but it does not start further
 * flow runs: two flows that each award XP on the other's level-up trigger would drive
 * each other without a fixed point, and nothing in the engine bounds that. The member
 * still sees the level-up; a `trigger.levelReached` simply does not fire for it.
 *
 * Granted as activity type `flow`, which carries no cooldown and no per-kind counter, so
 * an award always lands and never disturbs the member's real message or reaction windows.
 */
export async function awardFlowXp(input: AwardFlowXpInput): Promise<AwardFlowXpResult> {
    if (!Number.isSafeInteger(input.xpAmount) || input.xpAmount <= 0) {
        return { ok: false, refusal: 'not-positive' };
    }

    const config = await levelingConfigRepo.getByGuildId(input.guild.id);
    if (!config?.enabled) {
        return { ok: false, refusal: 'disabled' };
    }

    const grantResult = await levelingProgressRepo.grantXp({
        guildId: input.guild.id,
        userId: input.userId,
        xpAmount: input.xpAmount,
        activityType: 'flow',
        // Zero rather than a real window: `flow` has no last-granted timestamp to
        // compare against, so this cannot gate. Stated explicitly so a future reader
        // does not conclude the cooldown was forgotten.
        cooldownMs: 0,
        grantedAt: new Date(),
    });

    /*
     * `grantXp` returns null only when a cooldown blocked the grant. A `flow` grant has
     * no cooldown, so this is unreachable — but it is a `| null` return and treating it
     * as a level-up of zero would report a climb that did not happen.
     */
    if (!grantResult) {
        return { ok: false, refusal: 'not-positive' };
    }

    const previousLevel = getLevelFromTotalXp(grantResult.previousTotalXp);
    const newLevel = getLevelFromTotalXp(grantResult.newTotalXp);

    for (let level = previousLevel + 1; level <= newLevel; level++) {
        await announceLevelUp({
            client: input.client,
            guild: input.guild,
            config,
            userId: input.userId,
            level,
            totalXp: grantResult.newTotalXp,
        });
    }

    return {
        ok: true,
        previousLevel,
        newLevel,
        totalXp: grantResult.newTotalXp,
    };
}
