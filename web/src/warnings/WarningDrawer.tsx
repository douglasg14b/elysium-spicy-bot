import type { ReactNode } from 'react';
import { Badge, Button, Divider, Drawer, Group, Stack, Text } from '@mantine/core';
import { IconPencil, IconShieldCheck } from '@tabler/icons-react';
import type { Warning } from '@brattybot/web-sdk';
import { formatTimestampWithYear } from '../format/timestamps';
import type { MemberNames } from '../members/memberNames';
import { formatWarningDay, WARNING_STATUS_PRESENTATION, warningIsOpen, warningPersonLabel } from './warningPresentation';

interface WarningDrawerProps {
    /** The warning to show, or null while the drawer is closed. */
    readonly warning: Warning | null;
    /** Who its people are now, from the page's one names request. */
    readonly names: MemberNames;
    readonly onClose: () => void;
    readonly onEdit: (warning: Warning) => void;
    readonly onRelease: (warning: Warning) => void;
}

/**
 * One warning in full: the description the table cuts short, the record of who issued, last
 * edited and released it (and why), and the two actions — neither offered on a released
 * warning, which is the record of a closed matter.
 */
export function WarningDrawer({ warning, names, onClose, onEdit, onRelease }: WarningDrawerProps) {
    return (
        <Drawer
            opened={warning !== null}
            onClose={onClose}
            position="right"
            size="md"
            closeButtonProps={{ 'aria-label': 'Close' }}
            title={
                warning ? (
                    <Group gap="sm">
                        <Text ff="monospace" fw={700}>
                            {warning.slug}
                        </Text>
                        <Badge variant="light" color={WARNING_STATUS_PRESENTATION[warning.status].tone} radius="sm">
                            {WARNING_STATUS_PRESENTATION[warning.status].label}
                        </Badge>
                    </Group>
                ) : null
            }
        >
            {warning && <WarningRecord warning={warning} names={names} onEdit={onEdit} onRelease={onRelease} />}
        </Drawer>
    );
}

interface WarningRecordProps {
    readonly warning: Warning;
    readonly names: MemberNames;
    readonly onEdit: (warning: Warning) => void;
    readonly onRelease: (warning: Warning) => void;
}

function WarningRecord({ warning, names, onEdit, onRelease }: WarningRecordProps) {
    return (
        <Stack gap="md">
            <div>
                <Text size="11px" c="dark.2" fw={700} tt="uppercase" mb={4}>
                    Member
                </Text>
                <Text size="15px" fw={700}>
                    {warningPersonLabel(warning.member, names)}
                </Text>
            </div>
            <div>
                <Text size="11px" c="dark.2" fw={700} tt="uppercase" mb={4}>
                    Rule
                </Text>
                <Text size="14px" fw={600}>
                    {warning.rule}
                </Text>
            </div>
            <div>
                <Text size="11px" c="dark.2" fw={700} tt="uppercase" mb={4}>
                    What happened
                </Text>
                <Text size="13.5px" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {warning.description}
                </Text>
            </div>

            <Divider color="dark.5" />

            <Stack gap={8}>
                <RecordLine label="Issued">
                    {formatWarningDay(warning.issuedOn)} by {warningPersonLabel(warning.issuedBy, names)}
                </RecordLine>
                <RecordLine label={warning.status === 'expired' ? 'Dropped off' : 'Drops off'}>
                    {formatWarningDay(warning.dropsOffOn)}
                </RecordLine>
                {warning.edited ? (
                    <RecordLine label="Last edited">
                        {formatTimestampWithYear(warning.edited.at)} by {warningPersonLabel(warning.edited.by, names)}
                    </RecordLine>
                ) : null}
                {warning.released ? (
                    <>
                        <RecordLine label="Released">
                            {formatTimestampWithYear(warning.released.at)} by {warningPersonLabel(warning.released.by, names)}
                        </RecordLine>
                        <RecordLine label="Why">
                            {warning.released.reason ?? 'Released before reasons were kept — nobody wrote one down.'}
                        </RecordLine>
                    </>
                ) : null}
            </Stack>

            {warningIsOpen(warning) ? (
                <Group gap="sm" mt="sm">
                    <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => onEdit(warning)}>
                        Edit
                    </Button>
                    <Button
                        variant="light"
                        color="red"
                        leftSection={<IconShieldCheck size={16} />}
                        onClick={() => onRelease(warning)}
                    >
                        Release
                    </Button>
                </Group>
            ) : null}
        </Stack>
    );
}

interface RecordLineProps {
    readonly label: string;
    readonly children: ReactNode;
}

/** One line of the record: a label column and what it says. */
function RecordLine({ label, children }: RecordLineProps) {
    return (
        <Group gap="sm" align="flex-start" wrap="nowrap">
            <Text size="12.5px" c="dark.2" w={90} style={{ flexShrink: 0 }}>
                {label}
            </Text>
            <Text size="13px" style={{ overflowWrap: 'anywhere' }}>
                {children}
            </Text>
        </Group>
    );
}
