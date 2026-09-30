import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { theme } from './theme';
import { App } from './App';
import { CrashPage } from './pages/CrashPage';

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
        <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark">
            <Notifications position="top-right" />
            <RouterProvider router={router} />
        </MantineProvider>
    </React.StrictMode>
);
