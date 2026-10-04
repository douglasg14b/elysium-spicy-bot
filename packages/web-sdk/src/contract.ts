/**
 * The SDK's contract without its client: the generated types and zod schemas, and nothing
 * that fetches.
 *
 * The bot's root `tsconfig.json` resolves `@brattybot/web-sdk` to this file, not to
 * `index.ts`. Root tests reach into dashboard modules (`web/src/flows/**`) that are typed
 * by the generated contract, so the root program has to see it — but the root program is
 * Node code with no DOM library, and the fetch client is written against the DOM's
 * `BodyInit`. Both generated files here are self-contained: `types.gen.ts` imports
 * nothing and `zod.gen.ts` only `zod`.
 *
 * A dashboard module the root reaches that imports anything else from the SDK — a query
 * helper, `ApiError` — fails the root type-check with "has no exported member", which is
 * the point: such a module is not one the bot's tests should be importing.
 */
export * from './gen/types.gen';
export * from './gen/zod.gen';
