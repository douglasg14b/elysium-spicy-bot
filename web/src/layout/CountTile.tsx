import { Card, Text, UnstyledButton } from '@mantine/core';

interface CountTileProps {
    readonly label: string;
    readonly value: number;
    /** Whether the list is filtered to what this tile counts. */
    readonly active: boolean;
    readonly onClick: () => void;
}

/**
 * One number in a list page's counts strip, clickable into the filter it describes. Whether
 * it is the filter in force is said with `aria-pressed`, not only with its border colour.
 */
export function CountTile({ label, value, active, onClick }: CountTileProps) {
    return (
        <UnstyledButton onClick={onClick} aria-pressed={active}>
            <Card
                p="xs"
                px="md"
                bg={active ? 'dark.6' : 'dark.7'}
                style={{
                    borderColor: active ? 'var(--mantine-color-brand-6)' : undefined,
                }}
            >
                <Text size="11px" c="dark.2" fw={700} tt="uppercase">
                    {label}
                </Text>
                <Text size="20px" fw={800} lh={1.2}>
                    {value}
                </Text>
            </Card>
        </UnstyledButton>
    );
}
