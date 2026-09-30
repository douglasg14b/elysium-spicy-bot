import { useEffect } from 'react';
import { Button, Center, Stack, Text, Title } from '@mantine/core';
import { useRouteError } from 'react-router-dom';

/**
 * What the router shows when rendering the dashboard throws.
 *
 * The data router catches render errors itself, and without this its default screen
 * prints the stack trace to whoever is looking. The error goes to the console instead,
 * where a developer looks for it.
 */
export function CrashPage() {
    const error = useRouteError();

    useEffect(() => {
        console.error('[dashboard] render failed:', error);
    }, [error]);

    return (
        <Center mih="100vh" bg="dark.9" px="md">
            <Stack gap="sm" align="center" maw={420}>
                <Title order={3}>Well, that broke.</Title>
                <Text c="dimmed" size="sm" ta="center">
                    Something in the dashboard fell over. Reload and try again.
                </Text>
                <Button color="brand" onClick={() => window.location.reload()}>
                    Reload
                </Button>
            </Stack>
        </Center>
    );
}
