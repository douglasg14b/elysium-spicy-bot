/**
 * The dashboard's client for the bot's API, generated from the spec the routes emit.
 *
 * Everything under `gen/` is generated — `pnpm sdk:generate` rewrites it, and editing it
 * by hand is undone by the next run. What is hand-written is the setup and the error.
 *
 * Every SDK call, and every query and mutation built from the TanStack helpers, throws
 * {@link ApiError} on a refusal. The generated signatures name the response's `ErrorBody`
 * instead, because the generator cannot see `setupClient`'s interceptor; `ApiError`
 * carries `error` so that type holds, but narrow with `instanceof ApiError` to reach
 * `status` and `issues` — and because a network failure is not an `ApiError` at all.
 */
export * from './gen/@tanstack/react-query.gen';
export * from './gen/sdk.gen';
export * from './gen/types.gen';
export * from './gen/zod.gen';
export { ApiError, apiErrorFromBody, type ApiIssue } from './apiError';
export { setupClient, type SetupClientOptions } from './setupClient';
