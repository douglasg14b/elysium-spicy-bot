import { describe, expect, it } from 'vitest';
import {
    DECLARED_ROLE_PREFIX_VALUE as browserPrefix,
    declaredRoleOptionValue,
    parseDeclaredRoleReference as browserParse,
} from '../../../../../web/src/flows/declaredRoleReference';
import {
    DECLARED_ROLE_PREFIX,
    declaredRoleReference,
    declaredRoleReferencesIn,
    parseDeclaredRoleReference,
} from '../declaredRoleReference';

/**
 * How a permission names a role the journey creates, rather than one that exists.
 *
 * The prefix lives in two files — here and in `web/src/flows/` — for the reason the
 * whole `api/types.ts` mirror exists: an `import type` from `src/` inside the web
 * workspace drags the bot tree into `tsc -b` and the build fails. So the two are held
 * equal by this test instead of by the compiler.
 *
 * A drift here is silent and total: the browser writes `resource:in-approval`, the
 * server looks for some other prefix, sees a plain snowflake, creates no ordering
 * edge and no validation error, and the install fails mid-apply against a role id
 * that is really a key. Nothing else in the suite would notice.
 */
describe('declared role references', () => {
    it('uses the same prefix on the server and in the browser', () => {
        expect(DECLARED_ROLE_PREFIX).toBe(browserPrefix);
    });

    it('round-trips a key the browser wrote through the server parser', () => {
        // The actual wire path: the panel writes the value, the server reads it.
        expect(parseDeclaredRoleReference(declaredRoleOptionValue('in-approval'))).toBe(
            'in-approval'
        );
        expect(browserParse(declaredRoleReference('in-approval'))).toBe('in-approval');
    });

    it('reads a plain snowflake as not a reference', () => {
        // The distinction the whole scheme rests on. A false positive here would
        // treat a real role id as a resource key and refuse a valid journey.
        expect(parseDeclaredRoleReference('847263518290110')).toBeUndefined();
    });

    it('collects every referenced key across intents, without duplicates', () => {
        const keys = declaredRoleReferencesIn([
            {
                roleIds: [declaredRoleReference('in-approval'), '847263518290110'],
            },
            { roleIds: [declaredRoleReference('in-approval')] },
            { roleIds: [declaredRoleReference('verified')] },
            { roleIds: undefined },
        ]);

        expect([...keys].sort()).toEqual(['in-approval', 'verified']);
    });

    it('collects nothing from absent permissions', () => {
        expect(declaredRoleReferencesIn(undefined)).toEqual([]);
    });
});
