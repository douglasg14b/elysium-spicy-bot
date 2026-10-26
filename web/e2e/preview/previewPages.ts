/** A page the seed made worth looking at, and what to look for on it. */
export interface PreviewPage {
    /** Short, file-name-safe: `shoot.ts` names screenshots after it. */
    readonly name: string;
    /** Dashboard path, e.g. `/flows`. */
    readonly path: string;
    readonly note: string;
    /**
     * What a person would click after the page loads to reach the state worth a picture — a
     * card, then the button opening a window — in order. `shoot.ts` does them before shooting;
     * for a page opened by hand, the note says what to click.
     */
    readonly steps?: readonly PreviewStep[];
}

/**
 * One click: on a button by its accessible name, on the first element showing some text, or on
 * a text box by its accessible name — which is how a select opens its options.
 */
export type PreviewStep =
    | { readonly clickButton: string }
    | { readonly clickText: string }
    | { readonly clickTextbox: string };

/**
 * Where the preview server lists its seeded pages. Under `/api` so Vite's proxy forwards
 * it; answered by the preview's own fetch handler, never by the product's routes.
 */
export const PREVIEW_PAGES_PATH = '/api/__preview/pages';
