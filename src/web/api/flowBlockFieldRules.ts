import { z } from '@hono/zod-openapi';
import { listBlockDefinitions } from '../../features/flows/blocks/registry';
import {
    browserFieldRules,
    type BlockSchemaSource,
    type FieldBrowserRules,
} from '../../features/flows/logic/blockFieldRules';

/** The spec component holding every block's field rules, keyed by block type. */
export const FLOW_BLOCK_FIELD_RULES = 'FlowBlockFieldRules';

/**
 * What the Flow Builder checks a node's config against as the author types, for every
 * block: an object keyed by block type, each holding that block's drawn fields.
 *
 * Registered as a component of its own by `buildOpenApiDocument`. No route sends or
 * receives it; it is in the spec so the SDK generates it (`zFlowBlockFieldRules`), and the
 * builder looks a node up in it by `node.type` (`web/src/flows/liveFieldIssues.ts`).
 *
 * Built from **fresh** nodes of the library's zod, never from a block's own schema nodes:
 * `attachRequestMessages` writes each rule's sentence into its node's metadata, and
 * metadata on a block's own field would come back out of that block's JSON Schema export
 * as a keyword. The one thing reused is a block's `.regex()` *check*, so the pattern keeps
 * the block's own sentence.
 *
 * @param definitions - The blocks to describe; every registered block by default.
 */
export function flowBlockFieldRulesSchema(
    definitions: readonly BlockSchemaSource[] = listBlockDefinitions()
): z.ZodType {
    const byType = Object.fromEntries(
        definitions.map((definition) => [
            definition.type,
            z.object(
                Object.fromEntries(
                    [...browserFieldRules(definition)].map(([key, rules]) => [key, fieldSchema(rules).optional()])
                )
            ),
        ])
    );
    return z.object(byType).openapi({
        description:
            "What the Flow Builder may check about each block's config fields as an author types, keyed by " +
            "block type, each rule carrying the server's own sentence. Not the config's type: every field is " +
            'optional here, and a field the browser cannot check faithfully is unknown. The server checks the ' +
            'rest when the flow is saved or re-checked.',
    });
}

/**
 * One field's rules as a zod schema; its sentences become `x-messages` when the document is
 * built. The browser shows a field's first failing rule, so the order here — minimum,
 * maximum, pattern; whole number, then bounds — is the order the blocks write them in.
 */
function fieldSchema(rules: FieldBrowserRules): z.ZodType {
    switch (rules.kind) {
        case 'string': {
            const limited = rules.limits.reduce((schema, { keyword, limit, sentence }) => {
                switch (keyword) {
                    case 'minLength':
                        return schema.min(limit, sentence);
                    case 'maxLength':
                        return schema.max(limit, sentence);
                }
            }, z.string());
            return rules.pattern ? limited.check(rules.pattern) : limited;
        }
        case 'number':
            // The whole-number rule first, as `.int()` comes first on the blocks: a fraction
            // stops there, on the server and in the browser alike.
            return rules.limits.reduce((schema, { keyword, limit, sentence }) => {
                switch (keyword) {
                    case 'minimum':
                        return schema.gte(limit, sentence);
                    case 'maximum':
                        return schema.lte(limit, sentence);
                    case 'exclusiveMinimum':
                        return schema.gt(limit, sentence);
                    case 'exclusiveMaximum':
                        return schema.lt(limit, sentence);
                }
            }, rules.integer === undefined ? z.number() : z.number().int(rules.integer));
        case 'array':
            return rules.limits.reduce((schema, { keyword, limit, sentence }) => {
                switch (keyword) {
                    case 'minItems':
                        return schema.min(limit, sentence);
                    case 'maxItems':
                        return schema.max(limit, sentence);
                }
            }, z.array(z.unknown()));
        case 'unchecked':
            return z.unknown();
    }
}
