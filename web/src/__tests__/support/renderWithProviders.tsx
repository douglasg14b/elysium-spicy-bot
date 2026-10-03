import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { createDashboardQueryClient } from '../../api/queryClient';
import { theme } from '../../theme';

export interface RenderedWithProviders extends RenderResult {
    /** A user-event session bound to this render, so typing goes through real key events. */
    readonly user: UserEvent;
}

/**
 * Render a dashboard component inside the providers `main.tsx` gives it.
 *
 * The same theme and forced dark scheme as the real app, so a component reading a theme
 * colour or the scheme sees what it sees in the browser rather than Mantine's defaults.
 *
 * `env="test"` is Mantine's own switch for this, and it does two things the tests depend
 * on: it turns transitions off, so a `Collapse` or `Modal` is open on the render that
 * opens it rather than a frame-timed animation later, and it turns portals off, so a
 * modal, a dropdown and a notification render inside the test container where
 * `screen` finds them.
 *
 * `<Notifications />` is mounted because the dialogs report outcomes through
 * `notifications.show` — without the host the call is accepted and nothing appears, so a
 * test asserting what the operator was told would fail for a reason unrelated to the
 * component.
 *
 * A fresh query cache per render, from the factory `main.tsx` uses, so pages on the
 * generated SDK cache and retry as they do in the browser and no answer outlives its test.
 */
export function renderWithProviders(ui: ReactElement): RenderedWithProviders {
    const user = userEvent.setup();
    const rendered = render(
        <QueryClientProvider client={createDashboardQueryClient()}>
            <MantineProvider theme={theme} forceColorScheme="dark" env="test">
                <Notifications />
                {ui}
            </MantineProvider>
        </QueryClientProvider>
    );
    return { ...rendered, user };
}
