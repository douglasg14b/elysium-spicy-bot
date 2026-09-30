import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useLeaveGuard } from '../useLeaveGuard';

/**
 * The browser's own prompt on reload or close. The in-app half — the router's blocker — is
 * the builder's e2e suite, `web/e2e/flowLeavePrompt.test.tsx`.
 */

function Guarded({ unsaved }: { readonly unsaved: boolean }) {
    useLeaveGuard(unsaved);
    return null;
}

function renderGuarded(unsaved: boolean) {
    const router = createMemoryRouter([{ path: '*', element: <Guarded unsaved={unsaved} /> }]);
    return render(<RouterProvider router={router} />);
}

/** Whether the page asked the browser to hold a reload, as the browser would find out. */
function reloadIsHeld(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
}

describe('useLeaveGuard, on reload or close', () => {
    it('asks while there are unsaved changes', () => {
        renderGuarded(true);
        expect(reloadIsHeld()).toBe(true);
    });

    it('does not ask when everything is saved', () => {
        renderGuarded(false);
        expect(reloadIsHeld()).toBe(false);
    });

    it('stops asking once the page is gone', () => {
        const { unmount } = renderGuarded(true);
        unmount();
        expect(reloadIsHeld()).toBe(false);
    });
});
