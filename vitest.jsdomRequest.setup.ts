/**
 * Node's `Request`, taught to take jsdom's `AbortSignal` and a relative URL.
 *
 * Vitest's jsdom environment replaces `AbortController` and `AbortSignal` with jsdom's,
 * but leaves `Request` as Node's — and Node's refuses any signal that is not its own
 * ("RequestInit: Expected signal to be an instance of AbortSignal"). A data router builds
 * a `Request` with an `AbortController` signal for every navigation, so under jsdom the
 * dashboard's first link click threw. The two implementations are the environment's
 * disagreement, not the dashboard's, so this is where it is settled: every signal handed
 * to a `Request` is followed by a Node one, abort for abort.
 *
 * The URL is the same disagreement. A browser resolves `new Request('/api/…')` against
 * the page; Node has no page and throws "Failed to parse URL". The generated API client
 * builds exactly that `Request` (its base URL is `''`, same origin), so a relative URL is
 * resolved against jsdom's `location` here, as the browser would.
 *
 * Here rather than in `web/src/__tests__/support/setupDom.ts` because it needs
 * `node:util`, and the dashboard's type-check has no Node types.
 */

import { transferableAbortController } from 'node:util';

const NodeRequest = globalThis.Request;

/** A Node signal that aborts when `signal` does, with the same reason. */
function followedByNodeSignal(signal: AbortSignal): AbortSignal {
    const follower = transferableAbortController();
    if (signal.aborted) {
        follower.abort(signal.reason);
    } else {
        signal.addEventListener('abort', () => follower.abort(signal.reason), { once: true });
    }
    return follower.signal;
}

/*
 * jsdom's page URL. Declared here because this file is type-checked by the root
 * tsconfig, which has Node's types and not the DOM's.
 */
declare const location: { readonly href: string };

/** `input`, with a relative URL string resolved against the page as a browser would. */
function resolvedAgainstPage(input: ConstructorParameters<typeof NodeRequest>[0]): ConstructorParameters<typeof NodeRequest>[0] {
    return typeof input === 'string' ? new URL(input, location.href).href : input;
}

class JsdomRequest extends NodeRequest {
    constructor(input: ConstructorParameters<typeof NodeRequest>[0], init?: RequestInit) {
        super(
            resolvedAgainstPage(input),
            init?.signal ? { ...init, signal: followedByNodeSignal(init.signal) } : init
        );
    }
}

globalThis.Request = JsdomRequest;
