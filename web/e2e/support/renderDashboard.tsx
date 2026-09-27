import { MemoryRouter } from 'react-router-dom';
import { App } from '../../src/App';
import { renderWithProviders, type RenderedWithProviders } from '../../src/__tests__/support/renderWithProviders';

/**
 * Render the whole dashboard, signed in, at `path`: the same `App` `main.tsx` mounts, with
 * a memory router in place of the browser's. Pair with `installDashboardApi`, which
 * answers the session, bot identity and guild list the shell asks for before any page.
 *
 * For scenarios that cross pages, such as the flows list handing off to the builder. A
 * scenario about one dialog renders the dialog.
 */
export function renderDashboard(path: string): RenderedWithProviders {
    return renderWithProviders(
        <MemoryRouter initialEntries={[path]}>
            <App />
        </MemoryRouter>
    );
}
