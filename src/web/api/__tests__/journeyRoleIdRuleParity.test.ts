import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { zPermissionIntent } from '../../../../packages/web-sdk/src/gen/zod.gen';
import { parseDeclaredRoleReference } from '../../../features/provisioning/logic/declaredRoleReference';
import { PermissionRoleIdSchema } from '../journeyBody';

/**
 * The rule for one entry of a permission's `roleIds`, three ways, over one table of ids.
 *
 *  - **What the server used to accept**: a `.refine()` over `parseDeclaredRoleReference`.
 *    Kept here as the reference, because the pattern that replaced it — so the browser
 *    could be given the rule — claims to mean exactly that.
 *  - **The server's rule now**, `PermissionRoleIdSchema`.
 *  - **The browser's rule**, the committed SDK's generated zod — the pattern after it has
 *    been through the spec and hey-api, where a backslash or a lookahead could be mangled.
 *
 * The browser must never refuse an id the server accepts, and on this rule the three must
 * agree outright, sentence included.
 */

const FORMER_SENTENCE =
    'A declared role reference must name a valid resource key (lowercase letters, numbers and single hyphens).';

/** The schema the pattern replaced, as it was written. */
const formerRule = z
    .string()
    .min(1)
    .refine(
        (roleId) => {
            const key = parseDeclaredRoleReference(roleId);
            return key === undefined || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key);
        },
        { message: FORMER_SENTENCE }
    );

const browserRule = zPermissionIntent.shape.roleIds.unwrap().element;

const ACCEPTED = [
    '847263518290110',
    '100000000000000001',
    'resource:in-approval',
    'resource:a',
    'resource:a1-b2-c3',
    'not-a-snowflake-but-not-a-reference',
    'Resource:Upper',
    'resources:x',
    ' resource:padded',
    'role with\nnewline',
    'résumé',
];

const REFUSED = [
    '',
    'resource:',
    'resource:Bad_Key',
    'resource:-leading',
    'resource:trailing-',
    'resource:double--hyphen',
    'resource:x:y',
    'resource:has space',
    'resource:key\n',
    'resource:ÜBER',
];

describe('the declared role reference rule', () => {
    it('the table means what it says under the former refine', () => {
        // A sample in the wrong list would make the comparisons below agree for nothing.
        expect(ACCEPTED.filter((roleId) => !formerRule.safeParse(roleId).success)).toEqual([]);
        expect(REFUSED.filter((roleId) => formerRule.safeParse(roleId).success)).toEqual([]);
    });

    it.each([...ACCEPTED, ...REFUSED])('the server rule agrees with the former refine on %j', (roleId) => {
        const former = formerRule.safeParse(roleId);
        const server = PermissionRoleIdSchema.safeParse(roleId);

        expect(server.success).toBe(former.success);
        expect(server.error?.issues[0]?.message).toBe(former.error?.issues[0]?.message);
    });

    it.each([...ACCEPTED, ...REFUSED])(
        'the browser rule never refuses what the server accepts and words a refusal the same: %j',
        (roleId) => {
            const server = PermissionRoleIdSchema.safeParse(roleId);
            const browser = browserRule.safeParse(roleId);

            expect(browser.success).toBe(server.success);
            expect(browser.error?.issues[0]?.message).toBe(server.error?.issues[0]?.message);
        }
    );
});
