import type { z } from 'zod';

/**
 * Whether a schema's rules run in the order the browser's generated zod runs them.
 *
 * zod reports a value's issues in the order its rules were declared, and the server answers
 * a refusal with the first. The SDK's zod is generated from the spec, not from the schema,
 * and hey-api writes a string's rules as format, then length, then pattern, and a number's
 * as whole-number, then bounds — whatever order the schema declared them in. So a schema
 * declaring `.regex(…).min(1, …)` refuses `''` with the pattern's sentence on the server and
 * with the length's in the browser. Declared in the generated order, the two agree.
 *
 * Only the rules that can both fail on one value and travel to the browser are ranked: on a
 * string, length rules and `.regex()`; on a number, `.int()` and bounds. Two lengths, or two
 * bounds, can never both fail. A string format other than `.regex()` is not ranked: the only
 * one a request schema holds is a format schema (`z.iso.datetime()`), whose own check runs
 * first on both sides, and a format check worded by hand already fails the emit.
 *
 * Used where a schema's sentences are turned into the browser's: `attachRequestMessages`
 * for route schemas, and `browserFieldRules` for a block's own config schema.
 *
 * @param checkDefs - The schema node's checks, in declaration order.
 * @param ownerType - The node's zod type (`def.type`).
 * @returns Why the order disagrees, or `undefined` when it does not.
 */
export function ruleOrderProblem(
    checkDefs: readonly z.core.$ZodCheckDef[],
    ownerType: z.core.$ZodTypeDef['type']
): string | undefined {
    let latest: RankedRule | undefined;
    for (const checkDef of checkDefs) {
        const rule = rankOf(checkDef, ownerType);
        if (!rule) continue;
        if (latest && rule.rank < latest.rank) {
            return (
                `${latest.name} is declared before ${rule.name}, but the browser's generated zod runs ` +
                `${rule.name} first, so a value breaking both would be refused with a different sentence ` +
                `there than on the server. Declare ${rule.name} first.`
            );
        }
        latest = rule;
    }
    return undefined;
}

/** A rule whose place in the generated order is fixed: lower runs first. */
interface RankedRule {
    readonly rank: number;
    /** How a failure names it. */
    readonly name: string;
}

/** Where `checkDef` falls in the generated order for a node of `ownerType`; `undefined` when it is not ranked. */
function rankOf(checkDef: z.core.$ZodCheckDef, ownerType: z.core.$ZodTypeDef['type']): RankedRule | undefined {
    if (checkDef.check === 'custom') {
        return undefined;
    }
    // `check` discriminates zod's built-in checks; `custom` is the one kind outside `$ZodChecks`, handled above.
    const def = checkDef as z.core.$ZodChecks['_zod']['def'];
    switch (ownerType) {
        case 'string':
            if (def.check === 'min_length' || def.check === 'max_length' || def.check === 'length_equals') {
                return { rank: 1, name: 'a length rule' };
            }
            if (def.check === 'string_format' && def.format === 'regex') {
                return { rank: 2, name: '`.regex()`' };
            }
            return undefined;
        case 'number':
            if (def.check === 'number_format') {
                return { rank: 0, name: '`.int()`' };
            }
            if (def.check === 'greater_than' || def.check === 'less_than') {
                return { rank: 1, name: 'a bound' };
            }
            return undefined;
        default:
            return undefined;
    }
}
