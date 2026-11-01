import type { ReactNode } from 'react';
import { Avatar, Group, Text } from '@mantine/core';
import type { MemberFace } from './memberFace';

interface MemberFaceCellProps {
    readonly face: MemberFace;
    /** The name's colour; `brand.4` where the name is itself a control. */
    readonly nameColor?: string;
    /** Markers drawn after the name — the leaderboard's Bot and Gone badges. */
    readonly children?: ReactNode;
}

/** A person in a table row: their picture (or monogram), their name, and their @handle under it. */
export function MemberFaceCell({ face, nameColor, children }: MemberFaceCellProps) {
    return (
        <Group gap={10} wrap="nowrap">
            <Avatar src={face.avatarUrl ?? undefined} radius="xl" size={30} color="brand">
                {face.monogram}
            </Avatar>
            <div style={{ overflow: 'hidden', textAlign: 'left' }}>
                <Group gap={6} wrap="nowrap">
                    {/* `lh` set: a button's own line height clipped an underscore's descender. */}
                    <Text size="13.5px" fw={600} c={nameColor} lh={1.45} lineClamp={1}>
                        {face.name}
                    </Text>
                    {children}
                </Group>
                {face.handle ? (
                    <Text size="11.5px" c="dark.2" lineClamp={1}>
                        @{face.handle}
                    </Text>
                ) : null}
            </div>
        </Group>
    );
}
