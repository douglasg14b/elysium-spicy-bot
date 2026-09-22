import {
    AppShell,
    Avatar,
    Badge,
    Group,
    Image,
    Menu,
    NavLink,
    Stack,
    Text,
    UnstyledButton,
    Loader,
    Center,
} from '@mantine/core';
import {
    IconChartBar,
    IconShieldHalf,
    IconTrendingUp,
    IconTicket,
    IconCake,
    IconBolt,
    IconRoute,
    IconChevronDown,
    IconLogout,
    IconSettings,
} from '@tabler/icons-react';
import { NavLink as RouterNavLink, Outlet, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useBotIdentity } from '../brand/BotIdentityContext';
import { Wordmark } from '../brand/Wordmark';
import { useGuilds } from '../guilds/GuildContext';

interface NavEntry {
    label: string;
    to: string;
    icon: ReactNode;
    isNew?: boolean;
}

const NAV: NavEntry[] = [
    { label: 'Overview', to: '/overview', icon: <IconChartBar size={18} /> },
    { label: 'Warnings', to: '/warnings', icon: <IconShieldHalf size={18} /> },
    { label: 'Leveling', to: '/leveling', icon: <IconTrendingUp size={18} /> },
    { label: 'Tickets', to: '/tickets', icon: <IconTicket size={18} /> },
    { label: 'Birthdays', to: '/birthdays', icon: <IconCake size={18} /> },
    { label: 'Flows', to: '/flows', icon: <IconBolt size={18} />, isNew: true },
    // Directly under Flows: a journey is what a flow installs, and the two are read
    // together often enough that separating them would be a navigation puzzle.
    { label: 'Journeys', to: '/journeys', icon: <IconRoute size={18} />, isNew: true },
    // Last in "Configure" on purpose: everything above configures one feature, this
    // configures the server itself and is what those features read from.
    { label: 'Server Settings', to: '/settings', icon: <IconSettings size={18} /> },
];

/** Two-letter monogram for a guild/user with no icon. */
function monogram(name: string): string {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
}

export function DashboardLayout() {
    const { user, logout } = useAuth();
    const { name: botName, logoUrl } = useBotIdentity();
    const { selected, loading } = useGuilds();
    const location = useLocation();

    return (
        <AppShell header={{ height: 56 }} navbar={{ width: 264, breakpoint: 'sm' }} padding="md" bg="dark.9">
            <AppShell.Header bg="dark.8">
                <Group h="100%" px="md" justify="space-between">
                    <Group gap="sm">
                        <Image src={logoUrl} alt={botName} h={40} w={40} radius="md" fit="contain" />
                        <Wordmark fw={700} size="16px" />
                        <Badge variant="outline" color="gray" radius="xl" size="sm">
                            18+ Admin
                        </Badge>
                    </Group>

                    {user && (
                        <Menu shadow="md" width={200} position="bottom-end">
                            <Menu.Target>
                                <UnstyledButton>
                                    <Group
                                        gap={10}
                                        px={12}
                                        py={5}
                                        bg="dark.6"
                                        style={{ borderRadius: 24, border: '1px solid var(--mantine-color-dark-5)' }}
                                    >
                                        <Avatar
                                            src={
                                                user.avatar
                                                    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
                                                    : undefined
                                            }
                                            radius="xl"
                                            size={34}
                                            color="brand"
                                        >
                                            {monogram(user.username)}
                                        </Avatar>
                                        <Stack gap={0}>
                                            <Text size="13px" fw={600}>
                                                {user.username}
                                            </Text>
                                            <Text size="11px" c="green">
                                                ● Connected via Discord
                                            </Text>
                                        </Stack>
                                        <IconChevronDown size={14} color="var(--mantine-color-dark-2)" />
                                    </Group>
                                </UnstyledButton>
                            </Menu.Target>
                            <Menu.Dropdown>
                                <Menu.Item
                                    leftSection={<IconLogout size={16} />}
                                    onClick={() => void logout()}
                                >
                                    Log out
                                </Menu.Item>
                            </Menu.Dropdown>
                        </Menu>
                    )}
                </Group>
            </AppShell.Header>

            {/* `p` matches the header's `px` so the logo, the server card and the nav
                items share one left edge. Children therefore set no `px` of their own. */}
            <AppShell.Navbar bg="dark.8" p="md">
                <Stack gap="xs" h="100%">
                    <div>
                        <Text
                            size="11px"
                            fw={700}
                            tt="uppercase"
                            c="dark.2"
                            pb={6}
                            style={{ letterSpacing: '.7px' }}
                        >
                            Server
                        </Text>
                        {loading ? (
                            <Center py="sm">
                                <Loader size="xs" color="brand" />
                            </Center>
                        ) : selected ? (
                            <Group gap={10} px="xs" py={8} style={{ borderRadius: 8 }} bg="dark.6">
                                <Avatar src={selected.iconURL ?? undefined} radius="md" size={34} color="gray">
                                    {monogram(selected.name)}
                                </Avatar>
                                <Stack gap={0} style={{ overflow: 'hidden' }}>
                                    <Text size="13.5px" fw={600} truncate>
                                        {selected.name}
                                    </Text>
                                    <Text size="11px" c="dark.2">
                                        {selected.memberCount.toLocaleString()} members
                                    </Text>
                                </Stack>
                            </Group>
                        ) : (
                            <Text size="xs" c="dimmed">
                                No servers yet.
                            </Text>
                        )}
                    </div>

                    <Text
                        size="11px"
                        fw={700}
                        tt="uppercase"
                        c="dark.2"
                        pt="xs"
                        pb={4}
                        style={{ letterSpacing: '.7px' }}
                    >
                        Configure
                    </Text>
                    <Stack gap={2}>
                        {NAV.map((entry) => (
                            <NavLink
                                key={entry.to}
                                component={RouterNavLink}
                                to={entry.to}
                                label={entry.label}
                                leftSection={entry.icon}
                                active={location.pathname === entry.to}
                                variant="filled"
                                color="brand"
                                rightSection={
                                    entry.isNew ? (
                                        <Badge size="xs" color="brand" variant="filled" radius="xl">
                                            New
                                        </Badge>
                                    ) : undefined
                                }
                                // Match the server card's inner padding above.
                                styles={{ root: { borderRadius: 8, paddingInline: 'var(--mantine-spacing-xs)' } }}
                            />
                        ))}
                    </Stack>

                    <Text size="11px" c="dark.2" mt="auto" pt="sm" style={{ borderTop: '1px solid var(--mantine-color-dark-5)' }}>
                        {botName} · <Text span c="green">All systems naughty</Text>
                    </Text>
                </Stack>
            </AppShell.Navbar>

            <AppShell.Main>
                <Outlet />
            </AppShell.Main>
        </AppShell>
    );
}
