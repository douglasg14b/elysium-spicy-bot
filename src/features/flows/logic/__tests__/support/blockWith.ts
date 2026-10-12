import { z } from 'zod';
import type { BlockSchemaSource } from '../../blockFieldRules';

/**
 * A made-up block, `test.block`, with one text field `key` whose rule is `schema` — for
 * the cases that hold a rule the field-rule derivation or the spec emit must refuse.
 */
export function blockWith(key: string, schema: z.ZodType): BlockSchemaSource {
    return {
        type: 'test.block',
        configSchema: z.object({ [key]: schema }),
        configFields: [{ key, label: 'Field', control: 'text' }],
    };
}
