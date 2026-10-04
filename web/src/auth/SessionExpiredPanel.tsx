import { useEffect, useState } from 'react';
import { Button, getDefaultZIndex, Group, Modal, Stack, Text } from '@mantine/core';
import { IconBrandDiscord } from '@tabler/icons-react';
import { useAuth, type SessionRecheck } from './AuthContext';

interface SessionExpiredPanelProps {
    /** The session ran out; see `AuthContext`. */
    readonly opened: boolean;
}

/**
 * Over the page while a session that ran out mid-session is signed in again, in a new tab.
 *
 * It blocks the page without touching it. Nothing underneath is disabled or unmounted,
 * and the requests the page had going are held by the session gate, not failed. Focus
 * moves into the panel — an input that loses focus keeps its text — and Mantine's
 * `returnFocus` puts it back where it was when the panel closes.
 *
 * Like every modal, it carries React Flow's `nokey` opt-out (the theme's `Modal` default).
 * Without it, the builder's selected card stays selected under the panel, and the first
 * Backspace the operator types — mid-word when the panel opened — deletes it.
 *
 * Mounted always and opened by `opened`, rather than mounted when needed, so the modal's
 * own close is what returns focus.
 */
export function SessionExpiredPanel({ opened }: SessionExpiredPanelProps) {
    return (
        <Modal
            opened={opened}
            onClose={() => undefined}
            withCloseButton={false}
            closeOnClickOutside={false}
            closeOnEscape={false}
            centered
            zIndex={getDefaultZIndex('max')}
            title="Your session safeworded out"
        >
            <SessionExpiredBody />
        </Modal>
    );
}

/** The panel's content: mounted only while it is open, so a notice does not outlive it. */
function SessionExpiredBody() {
    const { recheckSession } = useAuth();
    const [notice, setNotice] = useState<string | null>(null);

    /*
     * Coming back to this tab or window is the likeliest moment the sign-in has finished in
     * the other, so it is asked then, quietly: a failure here is not something the operator
     * asked about.
     */
    useEffect(() => {
        const askQuietly = (): void => {
            void recheckSession();
        };
        window.addEventListener('focus', askQuietly);
        return () => window.removeEventListener('focus', askQuietly);
    }, [recheckSession]);

    // No `loading` on the button: it disables it, and focus would fall out of the panel.
    const ask = async (): Promise<void> => {
        setNotice(recheckNotice(await recheckSession()));
    };

    return (
        // Focus lands here rather than on a button, so a key still being typed when the
        // panel opened presses nothing.
        <Stack gap="md" data-autofocus tabIndex={-1} style={{ outline: 'none' }}>
            <Text size="sm" c="dimmed">
                Everything on this page is right where you left it. Sign in again in a new tab, then come back here and
                carry on — nothing gets saved until you do.
            </Text>
            {notice && (
                <Text size="sm" c="orange.4" role="status">
                    {notice}
                </Text>
            )}
            <Group justify="flex-end" gap="sm">
                <Button variant="default" onClick={() => void ask()}>
                    I&apos;ve signed in
                </Button>
                <Button
                    component="a"
                    href="/api/auth/login"
                    target="_blank"
                    rel="noopener"
                    color="brand"
                    leftSection={<IconBrandDiscord size={18} />}
                >
                    Sign in again
                </Button>
            </Group>
        </Stack>
    );
}

/** What the panel says about a check the operator asked for. Nothing when it worked. */
function recheckNotice(outcome: SessionRecheck): string | null {
    switch (outcome) {
        case 'stillSignedOut':
            return 'Nice try. Still no session — finish signing in on the other tab first.';
        case 'unreachable':
            return "Couldn't reach the server to check. Give it another go.";
        case 'restored':
        case 'replaced':
            return null;
    }
}
