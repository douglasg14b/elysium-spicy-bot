import { Badge, Card, Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { useGuilds } from '../guilds/GuildContext';
import { PAGE_MAX_WIDTH } from '../theme';

interface ComingSoonPageProps {
    title: string;
    blurb: string;
    icon?: ReactNode;
}

/** Wired-up-but-not-built-yet feature page. Keeps the nav honest without faking data. */
export function ComingSoonPage({ title, blurb, icon }: ComingSoonPageProps) {
    const { selected } = useGuilds();

    return (
        <Stack gap="lg" maw={PAGE_MAX_WIDTH}>
            <div>
                <Text size="12.5px" c="dark.2">
                    <Text span c="dark.1" fw={600}>
                        {selected?.name ?? 'Server'}
                    </Text>{' '}
                    › Configure › {title}
                </Text>
                <Group gap={10} mt={4}>
                    {icon}
                    <Title order={1} size="24px">
                        {title}
                    </Title>
                    <Badge variant="light" color="gray" radius="xl">
                        Coming soon
                    </Badge>
                </Group>
                <Text c="dimmed" size="13.5px" mt={4} maw={540}>
                    {blurb}
                </Text>
            </div>

            <Card p="xl">
                <Text c="dimmed" size="sm">
                    This panel isn&apos;t wired up yet. It lands in a later phase — for now, enjoy the
                    anticipation.
                </Text>
            </Card>
        </Stack>
    );
}
