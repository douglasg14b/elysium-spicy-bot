/** A page the seed made worth looking at, and what to look for on it. */
export interface PreviewPage {
    /** Short, file-name-safe: `shoot.ts` names screenshots after it. */
    readonly name: string;
    /** Dashboard path, e.g. `/flows`. */
    readonly path: string;
    readonly note: string;
}

/**
 * Where the preview server lists its seeded pages. Under `/api` so Vite's proxy forwards
 * it; answered by the preview's own fetch handler, never by the product's routes.
 */
export const PREVIEW_PAGES_PATH = '/api/__preview/pages';
