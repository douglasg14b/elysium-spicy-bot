import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { BlockManifest } from '../../features/flows/blocks/manifest';
import { listBlockDefinitions } from '../../features/flows/blocks/registry';
import type { AppEnv } from '../types';
import { NodeDescriptorSchema } from './nodeBody';
import { apiRouter, AUTHED_ERRORS, jsonResponse } from './openApi';

/**
 * The manifest members that exist for the server alone and are never served.
 *
 * The single source of truth for this route's exposure surface, which is defined
 * by subtraction: **every other manifest member is sent to the browser.** A member
 * added for the server rather than the builder belongs in this list — and adding it
 * here is not enough on its own: {@link NonWireMembersAreWithheld} is a type error
 * until the handler's destructure peels it off too. It surfaces in `tsc`, not in the
 * test suite, so read the typecheck rather than the tests when changing this.
 */
export const NON_WIRE_MEMBERS = ['configSchema', 'run'] as const satisfies readonly (keyof BlockManifest)[];

type NonWireMember = (typeof NON_WIRE_MEMBERS)[number];

/**
 * Everything about a block that crosses the wire: the whole manifest minus
 * {@link NON_WIRE_MEMBERS}.
 *
 * The rules the builder checks a field against as an author types are not here: they
 * reach the browser at build time, generated from `configSchema` into the SDK
 * (`FlowBlockFieldRules`, see `features/flows/logic/blockFieldRules.ts`).
 *
 * Expressed as a subtraction from {@link BlockManifest} rather than a hand-written
 * mirror of it, so a manifest field added for the builder is typed here the moment
 * it exists instead of after someone remembers to copy it across. That makes a
 * *forgotten* field impossible, which is the trade being made: the cost is that a
 * server-only field is public unless it is named above.
 *
 * The spec states it as `NodeDescriptorSchema` (`nodeBody.ts`), held to this type both
 * ways, so a manifest member added for the builder fails to compile there until the
 * schema says how it travels — and the browser's type is generated from that schema.
 */
export type NodeDescriptor = Omit<BlockManifest, NonWireMember>;

/**
 * Strip the non-wire members off one manifest.
 *
 * Subtraction, not construction: a hand-built object would silently omit a new
 * manifest field, and the omission would only surface as a missing control in the
 * browser.
 *
 * **Deliberately unannotated.** The inferred return type is the mechanism, not an
 * oversight: {@link NonWireMembersAreWithheld} reads back what this really removed,
 * and writing `: NodeDescriptor` here would collapse that inference to the
 * annotation and silently reduce the check to `Omit` agreeing with itself. The call
 * site pins the public shape instead.
 */
export const toDescriptor = (definition: BlockManifest) => {
    const { configSchema: _configSchema, run: _run, ...descriptor } = definition;
    return descriptor;
};

/** What {@link toDescriptor} actually withholds, read back off its rest object. */
type WithheldByHandler = Exclude<keyof BlockManifest, keyof ReturnType<typeof toDescriptor>>;

/**
 * Fails to compile unless {@link toDescriptor} withholds exactly
 * {@link NON_WIRE_MEMBERS} — no more (a member silently dropped from the builder)
 * and no less (a server-only member silently served).
 *
 * `Omit` alone cannot police the second case: the rest object stays structurally
 * assignable to {@link NodeDescriptor} whether or not it still carries a member that
 * was supposed to be withheld, so a name added to the list and nowhere else would
 * compile and keep serving. Checking both directions against the destructure closes
 * that. Type-level only; erased at runtime.
 */
type NonWireMembersAreWithheld = [WithheldByHandler] extends [NonWireMember]
    ? [NonWireMember] extends [WithheldByHandler]
        ? true
        : never
    : never;

/** Do not delete as unused: removing it erases the guard above. */
const nonWireMembersAreWithheld: NonWireMembersAreWithheld = true;

void nonWireMembersAreWithheld;

const getNodeTypesRoute = createRoute({
    method: 'get',
    path: '/',
    operationId: 'getNodeTypes',
    tags: ['flows'],
    summary: 'Every block the Flow Builder can offer',
    responses: {
        200: jsonResponse(
            'Every registered block, as the builder draws it.',
            z.object({ nodes: z.array(NodeDescriptorSchema).readonly() })
        ),
        ...AUTHED_ERRORS,
    },
});

/**
 * The block catalogue that drives the builder's palette. Not guild-scoped — the
 * registry is process-wide — but still behind the `requireAuth` middleware applied
 * where this router is mounted (`src/web/api/index.ts`).
 *
 * The registry is populated by `initFlows` before the web server starts, so this
 * route always sees every block. If that boot order is ever broken the lookup
 * raises rather than serving an empty palette.
 *
 * Everything the builder needs to draw a node — its palette entry, its card, and
 * its inspector form — is served here, so the whole manifest crosses the wire bar
 * {@link NON_WIRE_MEMBERS}: `run` is a function, and `configSchema` is a Zod schema
 * that stays server-authoritative as the sole authority on `node.data`.
 *
 * The browser types the response from the spec (`NodeDescriptor` in the dashboard SDK),
 * which states it in `nodeBody.ts`.
 */
export function nodeRoutes(): OpenAPIHono<AppEnv> {
    return apiRouter((router) => {
        router.openapi(getNodeTypesRoute, (c) => {
            const nodes: readonly NodeDescriptor[] = listBlockDefinitions().map(toDescriptor);
            return c.json({ nodes }, 200);
        });
        return undefined;
    });
}
