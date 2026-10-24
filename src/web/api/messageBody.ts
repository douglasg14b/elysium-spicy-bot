import { z } from '@hono/zod-openapi';
import { messageShape } from '../../shared/discordMessage';

/**
 * A Discord message — plain text and up to ten embeds — as the wire states it, named
 * `DiscordMessage` in the spec.
 *
 * Built by the same `messageShape` as the block's own schema, so the two carry one structure
 * and one set of per-part limits and sentences. Three things differ:
 *
 * - a picture is a plain string — the block's refined `pictureRefSchema` judges its form on
 *   the server, since a request schema cannot carry a refinement to the browser;
 * - the rules spanning parts (`messageProblems`) are left to the server's re-check, for the
 *   same reason;
 * - `fields`, `inline` and `timestamp` are optional rather than defaulted, so the parsed type
 *   is the block's input (`DiscordMessageInput`) — what a node stores, what a field's default
 *   declares, and what the generated type says.
 *
 * No route sends it on its own yet; it is registered as a component (`openApiDocument.ts`) so
 * the SDK exports `zDiscordMessage` and the `DiscordMessage` type, and it is the
 * `defaultValue` of a `message` config field (`nodeBody.ts`). `messageWireDrift.test.ts` holds
 * the two to the same verdicts.
 */
export const DiscordMessageSchema = z
    .object(messageShape({ picture: z.string(), fillDefaults: false }).shape)
    .openapi('DiscordMessage', {
        description:
            'A Discord message: optional plain text above up to ten embeds. A picture is an upload ' +
            '(`upload:<uuid>`), an http(s) link, or text holding a token; the server judges its form, and the ' +
            'rules spanning parts, when it re-checks the node.',
    });
