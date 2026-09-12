import { z } from 'zod';
import type { ConditionNodeDefinition } from './types';

export const CONDITION_HAS_ROLE = 'condition.hasRole';

export const hasRoleConfigSchema = z.object({
    roleId: z.string().min(1),
});

export type HasRoleConfig = z.infer<typeof hasRoleConfigSchema>;

export const conditionHasRoleNode: ConditionNodeDefinition<HasRoleConfig> = {
    type: CONDITION_HAS_ROLE,
    kind: 'condition',
    label: 'Has Role?',
    configSchema: hasRoleConfigSchema,
    evaluate(config, context) {
        return context.member.roles.cache.has(config.roleId) ? 'true' : 'false';
    },
};
