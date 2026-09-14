import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const TRIGGER_MEMBER_JOIN = 'trigger.memberJoin';

/** Fires when a member joins the guild (GuildMemberAdd gateway event). */
export const memberJoinConfigSchema = z.object({});

export type MemberJoinConfig = z.infer<typeof memberJoinConfigSchema>;

export const block: BlockManifest<MemberJoinConfig> = {
    type: TRIGGER_MEMBER_JOIN,
    kind: 'trigger',
    label: 'Member Joins',
    description: 'Start the run the moment someone walks through the door. Greet them, or vet them.',
    group: 'triggers',
    icon: '🚪',
    configSchema: memberJoinConfigSchema,
    configFields: [],
    cardSummary: [{ text: 'Any new member' }],
    note: 'No knobs on this one. It fires for every new arrival — wire it straight into whatever welcome you have planned.',
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['subject', 'actor'],
    capabilities: [],
    startedBy: 'memberJoin',
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
