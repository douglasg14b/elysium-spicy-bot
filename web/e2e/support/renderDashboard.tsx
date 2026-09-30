import { configure } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useRouteError } from 'react-router-dom';
import { App } from '../../src/App';
import { renderWithProviders, type RenderedWithProviders } from '../../src/__tests__/support/renderWithProviders';

/**
 * A whole-dashboard render answers every request through the real routes, a real database
 * and TestDiscord, so a page's first paint is several round trips, not one mocked promise.
 * Testing-library's default 1s for `findBy*` sits inside the spread of that under a full
 * parallel run: `flowIncomplete` and `resourceAdoption` failed their first-load wait there
 * and passed alone. Set once here, where every whole-app scenario enters, rather than as a
 * per-call timeout each test would have to remember.
 */
configure({ asyncUtilTimeout: 5000 });

/** The in-memory router a dashboard render runs on, as `createMemoryRouter` returns it. */
export type DashboardRouter = ReturnType<typeof createMemoryRouter>;

export interface RenderedDashboard extends RenderedWithProviders {
    /** For what a click cannot do, such as the browser's back button: `router.navigate(-1)`. */
    readonly router: DashboardRouter;
}

/**
 * Render the whole dashboard, signed in, at `path`: the same `App` `main.tsx` mounts, on
 * the same one catch-all data route, with a memory router in place of the browser's. Pair
 * with `installDashboardApi`, which answers the session, bot identity and guild list the
 * shell asks for before any page.
 *
 * For scenarios that cross pages, such as the flows list handing off to the builder. A
 * scenario about one dialog renders the dialog.
 */
export function renderDashboard(path: string): RenderedDashboard {
    const router = createMemoryRouter([{ path: '*', element: <App />, errorElement: <RethrowRouteError /> }], {
        initialEntries: [path],
    });
    return { ...renderWithProviders(<RouterProvider router={router} />), router };
}

/**
 * Put a render error back on the throw. The data router would otherwise catch it and paint
 * an error screen, and the test would fail later as a missing element, far from the cause.
 */
function RethrowRouteError(): never {
    throw useRouteError();
}
