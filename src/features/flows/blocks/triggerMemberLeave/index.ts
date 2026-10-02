import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const TRIGGER_MEMBER_LEAVE = 'trigger.memberLeave';

/** Fires when a member leaves the guild by any route (GuildMemberRemove gateway event). */
export const memberLeaveConfigSchema = z.object({});

export type MemberLeaveConfig = z.infer<typeof memberLeaveConfigSchema>;

/**
 * Start a run when somebody leaves — walked out, kicked or banned, since the gateway
 * event cannot say which.
 *
 * **Establishes `subject` only.** No `actor`: a member who was kicked or banned did not
 * cause their own leaving, and nothing here can tell those apart from walking out. No
 * `channel`: a departure happens nowhere in particular.
 *
 * The subject has already gone by the time this runs, so it is the way a flow reacts to
 * a departure — a parked run whose member leaves fails when it wakes instead, because
 * resuming re-fetches the member.
 */
export const block: BlockManifest<MemberLeaveConfig> = {
    type: TRIGGER_MEMBER_LEAVE,
    kind: 'trigger',
    label: 'Member Leaves',
    description: "Start the run the moment someone's gone — walked out, kicked or banned. It can't tell which.",
    group: 'triggers',
    icon: '🚶',
    configSchema: memberLeaveConfigSchema,
    configFields: [],
    cardSummary: [{ text: 'Anyone who leaves' }],
    note:
        "They're already gone when this fires. Blocks that only need to know who it was — checking or closing " +
        'their records — work fine. Anything that acts on them (roles, DMs) fails, and role or booster checks ' +
        "answer from whatever the bot last knew, which for someone it never cached is nothing at all. A run " +
        'that parks after this fails when it wakes, because the member is no longer there to resume.',
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['subject'],
    capabilities: [],
    startedBy: 'memberLeave',
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
