import { Center, Loader } from '@mantine/core';
import {
    IconCake,
    IconChartBar,
    IconTrendingUp,
} from '@tabler/icons-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { BotIdentityProvider } from './brand/BotIdentityContext';
import { GuildProvider } from './guilds/GuildContext';
import { DashboardLayout } from './layout/DashboardLayout';
import { LoginPage } from './pages/LoginPage';
import { WarningsPage } from './pages/WarningsPage';
import { ComingSoonPage } from './pages/ComingSoonPage';
import { FlowsListPage } from './pages/FlowsListPage';
import { FlowBuilderPage } from './pages/FlowBuilderPage';
import { JourneysListPage } from './pages/JourneysListPage';
import { ServerSettingsPage } from './pages/ServerSettingsPage';
import { TicketsListPage } from './pages/TicketsListPage';
import { TicketDetailPage } from './pages/TicketDetailPage';
import { TicketsConfigPage } from './pages/TicketsConfigPage';

/**
 * Root. Gates on auth: unauthenticated users get the login page; authenticated ones
 * get the dashboard shell + feature routes. Warnings is the default active route
 * (the one feature with real config in Phase 1).
 *
 * Bot identity sits outside the gate: the login page brands itself too, and it renders
 * with no session.
 */
export function App() {
    return (
        <BotIdentityProvider>
            <AuthProvider>
                <Gate />
            </AuthProvider>
        </BotIdentityProvider>
    );
}

function Gate() {
    const { user, loading } = useAuth();

    if (loading) {
        return (
            <Center mih="100vh" bg="dark.9">
                <Loader color="brand" />
            </Center>
        );
    }

    if (!user) {
        return <LoginPage />;
    }

    return (
        <GuildProvider>
            <Routes>
                <Route element={<DashboardLayout />}>
                    <Route index element={<Navigate to="/warnings" replace />} />
                    <Route path="/warnings" element={<WarningsPage />} />
                    <Route
                        path="/overview"
                        element={
                            <ComingSoonPage
                                title="Overview"
                                blurb="A bird's-eye view of your server's activity and the bot's greatest hits."
                                icon={<IconChartBar size={22} color="var(--mantine-color-brand-6)" />}
                            />
                        }
                    />
                    <Route
                        path="/leveling"
                        element={
                            <ComingSoonPage
                                title="Leveling"
                                blurb="Reward the regulars. XP, ranks, and the flex cards that come with them."
                                icon={<IconTrendingUp size={22} color="var(--mantine-color-brand-6)" />}
                            />
                        }
                    />
                    <Route path="/tickets" element={<TicketsListPage />} />
                    {/*
                     * `/tickets/config` is declared **before** `/tickets/:ticketId` because
                     * the two genuinely overlap — without an order to point at, `config`
                     * reads as a ticket id. React Router v6 ranks static segments above
                     * dynamic ones so either order in fact resolves correctly; it is
                     * written this way because that is what a reader checks, and relying on
                     * the ranking silently would make a later router change a routing bug.
                     *
                     * Note this is a different situation from the `/flows` comment below,
                     * which is about matching nav order between paths that do not overlap.
                     */}
                    <Route path="/tickets/config" element={<TicketsConfigPage />} />
                    <Route path="/tickets/:ticketId" element={<TicketDetailPage />} />
                    <Route
                        path="/birthdays"
                        element={
                            <ComingSoonPage
                                title="Birthdays"
                                blurb="Never miss a member's big day. The bot brings the cake (well, the announcement)."
                                icon={<IconCake size={22} color="var(--mantine-color-brand-6)" />}
                            />
                        }
                    />
                    <Route path="/flows" element={<FlowsListPage />} />
                    {/*
                     * Above `/flows/:flowId` would be harmless — the paths do not
                     * overlap — but it is listed after `/flows` to match the nav order
                     * an operator sees: flows, then the journeys they install.
                     */}
                    <Route path="/journeys" element={<JourneysListPage />} />
                    <Route path="/flows/:flowId" element={<FlowBuilderPage />} />
                    <Route path="/settings" element={<ServerSettingsPage />} />
                    <Route path="*" element={<Navigate to="/warnings" replace />} />
                </Route>
            </Routes>
        </GuildProvider>
    );
}
