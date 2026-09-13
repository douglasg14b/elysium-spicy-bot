import { z } from 'zod';
import type { TriggerNodeDefinition } from '../types';

export const TRIGGER_MEMBER_JOIN = 'trigger.memberJoin';

/** Fires when a member joins the guild (GuildMemberAdd gateway event). */
export const memberJoinConfigSchema = z.object({});

export type MemberJoinConfig = z.infer<typeof memberJoinConfigSchema>;

export const block: TriggerNodeDefinition<MemberJoinConfig> = {
    type: TRIGGER_MEMBER_JOIN,
    kind: 'trigger',
    label: 'Member Joins',
    configSchema: memberJoinConfigSchema,
};
