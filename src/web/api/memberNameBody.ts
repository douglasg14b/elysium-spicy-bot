import { z } from '@hono/zod-openapi';
import type { MemberNameRow } from '../../features-system/member-names';

/**
 * Who an id is in a server, as the dashboard reads it (`docs/plans/member-names.md`, §3).
 *
 * Each schema is made with `@hono/zod-openapi`'s `z`; `memberNameRoutes` declares it,
 * `router.openapi` type-checks every `c.json(...)` against it, and the spec names it as a
 * component the SDK is generated from.
 */

/** How many ids one request may name. */
export const MEMBER_NAME_IDS_MAX = 100;

/**
 * The `ids` query: 1 to {@link MEMBER_NAME_IDS_MAX} user ids, comma-separated, no spaces.
 * One pattern carries both the shape and the count, so the browser checks it as the server
 * does; a twenty-digit id past a snowflake's 64 bits is the handler's to refuse.
 */
export const MemberNameQuerySchema = z.object({
    ids: z
        .string()
        .regex(
            new RegExp(`^\\d{17,20}(?:,\\d{17,20}){0,${MEMBER_NAME_IDS_MAX - 1}}$`),
            `Send 1 to ${MEMBER_NAME_IDS_MAX} user ids, separated by commas.`
        )
        .openapi({ description: `1 to ${MEMBER_NAME_IDS_MAX} user ids, comma-separated.` }),
});

const MemberNameSchema = z
    .object({
        userId: z.string(),
        username: z.string(),
        globalName: z.string().nullable(),
        nickname: z.string().nullable(),
        nicknames: z.array(z.string()),
        isBot: z.boolean(),
        inServer: z.boolean(),
        leftAt: z.string().nullable(),
    })
    .openapi('MemberName', {
        description:
            'Who an id is in this server. `username` and `globalName` are the account\'s, `nickname` this server\'s — ' +
            'the last one seen, for somebody who left. `nicknames` is every server nickname seen, newest first. ' +
            '`inServer` false with no `leftAt` (ISO) means the bot did not see them go. Show `nickname`, else ' +
            '`globalName`, else `username`.',
    });

type MemberNameBody = z.infer<typeof MemberNameSchema>;

export const MemberNameListSchema = z
    .object({
        members: z.array(MemberNameSchema),
    })
    .openapi('MemberNameList', {
        description:
            'One entry per id the bot knows or could look up. An id missing from it is unknown for now — Discord has ' +
            'no such account, or the lookup was capped and fills in on a later request.',
    });

/** A stored row as the dashboard reads it. */
export function memberName(row: MemberNameRow): MemberNameBody {
    return {
        userId: row.userId,
        username: row.username,
        globalName: row.globalName,
        nickname: row.nickname,
        nicknames: row.nicknames,
        isBot: row.isBot,
        inServer: row.inServer,
        leftAt: row.leftAt?.toISOString() ?? null,
    };
}
