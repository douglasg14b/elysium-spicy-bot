/**
 * Where Vitest's jsdom environment and Node's `fetch` disagree, settled for the `dom` and `e2e`
 * projects — named for the first of them, `Request`; the rest came after:
 *
 *  - `Request`, taught to take jsdom's `AbortSignal` and a relative URL (any page; both projects).
 *  - Node's `Blob` and `File` (a page uploading a picture; both projects).
 *  - Node's `FormData`, `Uint8Array` and `ArrayBuffer` (the bot sending a message with files, so
 *    the `e2e` project; harmless in `dom`, where nothing else reads them).
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

import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
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

/*
 * Node's `Blob`, `File` and `FormData`, in place of jsdom's — the same disagreement once
 * more, both ways round:
 *
 *  - A page uploading a picture hands the `File` it was given straight to the SDK as the
 *    request body, and Node's `Request` takes only its own `Blob`: jsdom's is turned into the
 *    text "[object File]", so the server would receive eleven bytes of nonsense.
 *  - The bot sends a message with files as multipart (`@discordjs/rest` appends a `Blob` to a
 *    `FormData`), and jsdom's `FormData` refuses any `Blob` but its own.
 *
 * In a browser, and in the bot, each of these comes from one implementation with the fetch
 * that sends it, as they now do here. Node's `FormData` is not importable by name, so it is
 * taken from a form Node's own `Response` parses.
 */
globalThis.Blob = NodeBlob;
globalThis.File = NodeFile;
/*
 * And Node's `Uint8Array` and `ArrayBuffer`: the environment hands out jsdom's, so a `Buffer`
 * — Node's — is not `instanceof Uint8Array`, and `@discordjs/rest` (which asks exactly that
 * before attaching a file) writes the bytes out as text, every byte over 0x7F turned into
 * U+FFFD. Read off a `Buffer`, since the names themselves now answer with jsdom's.
 */
globalThis.Uint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as Uint8ArrayConstructor;
globalThis.ArrayBuffer = Buffer.alloc(1).buffer.constructor as ArrayBufferConstructor;
const emptyForm = new Response('', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
globalThis.FormData = (await emptyForm.formData()).constructor as typeof FormData;
