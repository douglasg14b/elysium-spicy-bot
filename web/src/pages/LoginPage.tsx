import { Button, Card, Center, Image, Stack, Text, Badge, Group } from '@mantine/core';
import { IconBrandDiscord } from '@tabler/icons-react';

/**
 * Unauthenticated landing. Login is a full-page redirect to the server's OAuth
 * kickoff (`/api/auth/login`) — not an in-app fetch — so the browser follows Discord's
 * 302s and lands back on `/` with a session cookie set.
 */
export function LoginPage() {
    return (
        <Center mih="100vh" bg="dark.9" px="md">
            <Card w={420} p="xl" bg="dark.7" withBorder>
                <Stack gap="lg" align="center">
                    <Image src="/spicybot-logo.png" alt="SpicyBot" h={72} w={72} radius="lg" fit="contain" />
                    <Stack gap={4} align="center">
                        <Text fw={800} size="24px">
                            Spicy
                            <Text span c="brand">
                                Bot
                            </Text>
                        </Text>
                        <Badge variant="light" color="gray" radius="xl" size="sm">
                            18+ Admin
                        </Badge>
                    </Stack>

                    <Text c="dimmed" size="sm" ta="center">
                        The control room for your naughtiest server. Log in with Discord — only allowlisted
                        admins get past the velvet rope.
                    </Text>

                    <Button
                        component="a"
                        href="/api/auth/login"
                        fullWidth
                        size="md"
                        color="brand"
                        leftSection={<IconBrandDiscord size={20} />}
                    >
                        Log in with Discord
                    </Button>

                    <Group gap={6} justify="center">
                        <Text size="xs" c="dimmed">
                            Not on the list? Then this isn&apos;t your party.
                        </Text>
                    </Group>
                </Stack>
            </Card>
        </Center>
    );
}
