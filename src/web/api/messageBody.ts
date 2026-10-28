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

/** A button on one of the journey's message resources, by the message's key and the button's. */
const JourneyButtonRefSchema = z.object({ messageKey: z.string(), buttonKey: z.string() }).openapi('JourneyButtonRef', {
    description: "One button on one of the flow's journey's messages: the message resource's key and the button's key.",
});

/**
 * A button under a message a block posts, by the posting flow and node and the button's key.
 * `flowId` is written even when the poster is the listening flow itself.
 */
const BlockButtonRefSchema = z
    .object({ flowId: z.string(), nodeId: z.string(), buttonKey: z.string() })
    .openapi('BlockButtonRef', {
        description:
            "One button under a message a block posts (Post Embed's, Open Ticket's): the posting flow's id, the " +
            "posting node's id and the button's key. The flow id is set even when it is the listener's own.",
    });

/**
 * What a `messageButton` config field holds: one button on one of the journey's messages
 * (`JourneyButtonRef`), or one under a block's post (`BlockButtonRef`). Named
 * `MessageButtonRef` in the spec.
 *
 * The `defaultValue` of a `messageButton` config field (`nodeBody.ts`), which is how it reaches
 * the spec, so the builder takes the control's value type from the SDK rather than writing its
 * own. Plain strings: the picker writes only keys and ids it was offered, and the server judges
 * them when it re-checks the node — the key rule in the block's schema, the declarations in
 * `messageButtonIssues`, the posting node in `blockButtonIssues`.
 */
export const MessageButtonRefSchema = z
    .union([JourneyButtonRefSchema, BlockButtonRefSchema])
    .openapi('MessageButtonRef', {
        description:
            "One button a Button Click listens to: on one of the flow's journey's messages, or under a block's post.",
    });
