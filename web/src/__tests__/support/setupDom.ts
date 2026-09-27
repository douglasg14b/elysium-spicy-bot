/**
 * The jsdom gaps Mantine falls into, and Testing Library's teardown.
 *
 * Each stub below is a browser API jsdom does not implement and Mantine calls during an
 * ordinary render — not a behaviour being faked for a test's convenience. Without them a
 * component test fails inside Mantine with a `TypeError` that names neither the component
 * nor the missing API, which reads as a product bug.
 *
 * Nothing here decides what a component does. Layout is the one thing jsdom genuinely
 * cannot answer (it computes no sizes), so anything whose behaviour depends on measured
 * geometry is out of reach of these tests and belongs in a live check.
 */

import { notifications } from '@mantine/notifications';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/*
 * Testing Library unmounts after each test by itself only when the runner exposes a
 * global `afterEach`. Vitest's globals are off in this repo, so without this every
 * render stays mounted and the next test's queries find the previous test's DOM.
 *
 * Mantine keeps notifications in a module-level store that outlives the unmount, so one
 * test's "#0001 claimed." would still be showing in the next, and past the display limit
 * a new one is queued out of sight.
 */
afterEach(() => {
    cleanup();
    notifications.clean();
});

/*
 * `useMediaQuery` and the colour-scheme manager both read it on mount. Answering "no
 * match" is what a desktop browser at the default width answers for every query Mantine
 * asks, so it describes the layout operators actually use.
 */
Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
    }),
});

/*
 * `ScrollArea` and the combobox's floating dropdown observe their own size. jsdom never
 * lays anything out, so there is never a resize to report — an observer that reports
 * none is the faithful stub, not a simplification.
 */
class NoLayoutResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
}
window.ResizeObserver = NoLayoutResizeObserver;

/*
 * The combobox scrolls the highlighted option into view as the arrow keys move it, and
 * the resources panel scrolls a chip's jump target. There is no viewport to scroll.
 */
Element.prototype.scrollIntoView = () => undefined;
