import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClientProvider } from '@tanstack/react-query';
import { setupClient } from '@brattybot/web-sdk';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { theme } from './theme';
import { App } from './App';
import { createDashboardQueryClient } from './api/queryClient';
import { CrashPage } from './pages/CrashPage';

// Same origin: the spec's paths already carry `/api`, and Vite proxies it in dev.
setupClient({ baseUrl: '' });

const queryClient = createDashboardQueryClient();

/*
 * A data router, because only a data router can hold a `useBlocker` — the flow builder
 * asks before a navigation drops unsaved work. One catch-all route hands every path to
 * `App`, whose own `<Routes>` still declare the pages, so auth, the guild context and
 * the layout sit exactly where they did under `<BrowserRouter>`. A data router also
 * catches render errors, which `CrashPage` answers.
 */
const router = createBrowserRouter([{ path: '*', element: <App />, errorElement: <CrashPage /> }]);

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark">
                <Notifications position="top-right" />
                <RouterProvider router={router} />
            </MantineProvider>
        </QueryClientProvider>
    </React.StrictMode>
);
