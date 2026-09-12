/**
 * Right-hand inspector. Renders a hand-built Mantine form for the selected node's
 * type, editing `data` live (no Apply button — changes land in local graph state and
 * are persisted by the toolbar's Save). Role/channel fields always use pickers, so
 * nobody ever types a raw snowflake.
 */

import {
    Button,
    ColorInput,
    Divider,
    Group,
    NumberInput,
    SegmentedControl,
    Select,
    Stack,
    Text,
    Textarea,
    TextInput,
} from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useMemo } from 'react';
import type { GuildChannel, GuildRole } from '../api/types';
import { KIND_STYLES, kindOf, nodeDescription, nodeEmoji, roleColorHex } from './nodeMeta';

interface NodeInspectorProps {
    nodeType: string;
    label: string;
    config: Record<string, unknown>;
    roles: GuildRole[];
    channels: GuildChannel[];
    onChange: (patch: Record<string, unknown>) => void;
    onDelete: () => void;
}

/** Narrow an unknown `data` value to a string for controlled inputs. */
function text(config: Record<string, unknown>, key: string): string {
    const value = config[key];
    return typeof value === 'string' ? value : '';
}

/** Units offered by the duration editor, largest-first for `splitDuration`. */
const DURATION_UNITS = [
    { ms: 86_400_000, label: 'days' },
    { ms: 3_600_000, label: 'hours' },
    { ms: 60_000, label: 'minutes' },
    { ms: 1_000, label: 'seconds' },
] as const;

/**
 * Pick the largest unit that divides `ms` evenly, so 3600000 shows as "1 hours"
 * rather than "3600 seconds". Defaults to minutes when there is no value.
 */
function splitDuration(ms: number | null): { value: number | null; unit: number } {
    if (ms === null || ms <= 0) return { value: null, unit: 60_000 };
    for (const { ms: size } of DURATION_UNITS) {
        if (ms % size === 0) return { value: ms / size, unit: size };
    }
    return { value: Math.round(ms / 1000), unit: 1_000 };
}

export function NodeInspector({
    nodeType,
    label,
    config,
    roles,
    channels,
    onChange,
    onDelete,
}: NodeInspectorProps) {
    const kind = kindOf(nodeType);
    const style = KIND_STYLES[kind];

    const roleOptions = useMemo(
        () =>
            [...roles]
                .sort((a, b) => b.position - a.position)
                .map((role) => ({ value: role.id, label: `@${role.name}` })),
        [roles]
    );
    const channelOptions = useMemo(
        () => channels.map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
        [channels]
    );

    /** A role picker with the role's own colour as a leading dot. */
    function roleField(key: string, fieldLabel: string, description: string) {
        const current = roles.find((r) => r.id === text(config, key));
        return (
            <Select
                label={fieldLabel}
                description={description}
                placeholder="Pick a role"
                data={roleOptions}
                value={text(config, key) || null}
                onChange={(value) => onChange({ [key]: value ?? '' })}
                searchable
                nothingFoundMessage="No roles found"
                allowDeselect={false}
                leftSection={
                    current ? (
                        <span
                            style={{
                                width: 11,
                                height: 11,
                                borderRadius: '50%',
                                display: 'block',
                                background: roleColorHex(current.color),
                            }}
                        />
                    ) : undefined
                }
            />
        );
    }

    function channelField(key: string, fieldLabel: string, description: string) {
        return (
            <Select
                label={fieldLabel}
                description={description}
                placeholder="Pick a channel"
                data={channelOptions}
                value={text(config, key) || null}
                onChange={(value) => onChange({ [key]: value ?? '' })}
                searchable
                nothingFoundMessage="No channels found"
                allowDeselect={false}
            />
        );
    }

    /**
     * Duration editor that stores milliseconds but shows a sane number + unit, so
     * nobody hand-computes 604800000. When `optional`, clearing the number removes
     * the key entirely — the server rejects a non-positive value but allows absence.
     */
    function durationField(key: string, fieldLabel: string, description: string, optional = false) {
        const ms = typeof config[key] === 'number' ? (config[key] as number) : null;
        const { value, unit } = splitDuration(ms);

        const emit = (nextValue: number | null, nextUnit: number) => {
            if (nextValue === null || Number.isNaN(nextValue) || nextValue <= 0) {
                onChange({ [key]: optional ? undefined : 0 });
                return;
            }
            onChange({ [key]: Math.round(nextValue * nextUnit) });
        };

        return (
            <div>
                <Text size="12px" fw={700} mb={4}>
                    {fieldLabel}
                </Text>
                <Group gap="xs" align="flex-start" wrap="nowrap">
                    <NumberInput
                        placeholder={optional ? 'No limit' : '5'}
                        min={0}
                        step={1}
                        value={value ?? ''}
                        onChange={(next) =>
                            emit(typeof next === 'number' ? next : Number(next) || null, unit)
                        }
                        style={{ flex: 1 }}
                    />
                    <Select
                        data={DURATION_UNITS.map((u) => ({ value: String(u.ms), label: u.label }))}
                        value={String(unit)}
                        onChange={(next) => emit(value, Number(next) || 60_000)}
                        allowDeselect={false}
                        w={120}
                    />
                </Group>
                <Text size="11.5px" c="dimmed" mt={4}>
                    {description}
                </Text>
            </div>
        );
    }

    function fields() {
        switch (nodeType) {
            case 'trigger.buttonClick':
                return (
                    <>
                        <TextInput
                            label="Button label"
                            description="What the button says. 1–80 characters."
                            placeholder="Agree to rules"
                            maxLength={80}
                            value={text(config, 'label')}
                            onChange={(e) => onChange({ label: e.currentTarget.value })}
                        />
                        <div>
                            <Text size="sm" fw={500} mb={4}>
                                Button style
                            </Text>
                            <SegmentedControl
                                fullWidth
                                size="xs"
                                color="brand"
                                data={['Primary', 'Secondary', 'Success', 'Danger']}
                                value={text(config, 'style') || 'Primary'}
                                onChange={(value) => onChange({ style: value })}
                            />
                        </div>
                    </>
                );

            case 'trigger.memberJoin':
                return (
                    <Text size="13px" c="dimmed">
                        No knobs on this one. It fires for every new arrival — wire it straight into
                        whatever welcome you have planned.
                    </Text>
                );

            case 'trigger.reactionAdd':
                return (
                    <>
                        {channelField(
                            'channelId',
                            'Channel',
                            'Where the watched message lives.'
                        )}
                        <TextInput
                            label="Message ID"
                            description="Right-click the message › Copy Message ID (needs Developer Mode)."
                            placeholder="1234567890123456789"
                            value={text(config, 'messageId')}
                            onChange={(e) => onChange({ messageId: e.currentTarget.value })}
                        />
                        <TextInput
                            label="Emoji"
                            description="The reaction to watch for — a literal emoji, or a custom one's name."
                            placeholder="🌶️"
                            value={text(config, 'emoji')}
                            onChange={(e) => onChange({ emoji: e.currentTarget.value })}
                        />
                    </>
                );

            case 'condition.hasRole':
                return roleField(
                    'roleId',
                    'Role to check',
                    'True branch runs if they have it, false if they do not.'
                );

            case 'condition.inChannel':
                return channelField(
                    'channelId',
                    'Channel to check',
                    'True branch runs when the event happened here.'
                );

            case 'action.assignRole':
                return roleField(
                    'roleId',
                    'Role to assign',
                    "Pick from your server's roles. This one unlocks the good stuff."
                );

            case 'action.removeRole':
                return roleField('roleId', 'Role to remove', 'Taken from the triggering member.');

            case 'action.sendDM':
                return (
                    <Textarea
                        label="Message"
                        description="Sent straight to their DMs. Keep it classy-ish."
                        placeholder="Welcome to Afterdark 😈"
                        autosize
                        minRows={4}
                        maxRows={10}
                        value={text(config, 'message')}
                        onChange={(e) => onChange({ message: e.currentTarget.value })}
                    />
                );

            case 'action.sendMessage':
                return (
                    <>
                        {channelField('channelId', 'Channel', 'Where the message gets posted.')}
                        <Textarea
                            label="Message"
                            placeholder="Say something spicy…"
                            autosize
                            minRows={4}
                            maxRows={10}
                            value={text(config, 'message')}
                            onChange={(e) => onChange({ message: e.currentTarget.value })}
                        />
                    </>
                );

            case 'action.postEmbed':
                return (
                    <>
                        {channelField('channelId', 'Channel', 'Where the embed gets posted.')}
                        <TextInput
                            label="Title"
                            placeholder="House Rules"
                            value={text(config, 'title')}
                            onChange={(e) => onChange({ title: e.currentTarget.value })}
                        />
                        <Textarea
                            label="Description"
                            placeholder="The fine print nobody reads…"
                            autosize
                            minRows={4}
                            maxRows={10}
                            value={text(config, 'description')}
                            onChange={(e) => onChange({ description: e.currentTarget.value })}
                        />
                        <ColorInput
                            label="Accent colour"
                            description="The stripe down the side of the embed."
                            format="hex"
                            value={text(config, 'color') || '#00A2FF'}
                            onChange={(value) => onChange({ color: value })}
                            swatches={['#00A2FF', '#43b581', '#faa61a', '#eb459e', '#ed4245']}
                        />
                    </>
                );

            case 'action.delay':
                return (
                    <>
                        {durationField(
                            'durationMs',
                            'Wait for',
                            'The flow parks here and picks up afterwards — it survives a bot restart.'
                        )}
                        <Text size="11.5px" c="dimmed">
                            Max 30 days. Put one of these inside a loop and the flow will keep
                            cycling — the visit cap still stops it running away.
                        </Text>
                    </>
                );

            case 'action.waitForEvent':
                return (
                    <>
                        <Select
                            label="Wait for"
                            description="Parks the flow until this member does the thing."
                            data={[
                                { value: 'buttonClick', label: 'They click a flow button' },
                                { value: 'reactionAdd', label: 'They add a reaction' },
                                { value: 'memberJoin', label: 'They rejoin the server' },
                            ]}
                            value={text(config, 'eventKind') || 'buttonClick'}
                            onChange={(value) => onChange({ eventKind: value ?? 'buttonClick' })}
                            allowDeselect={false}
                        />
                        {durationField(
                            'timeoutMs',
                            'Give up after',
                            'Optional. On timeout the flow leaves via the Timeout handle — wire it up, or the run fails.',
                            true
                        )}
                    </>
                );

            default:
                return (
                    <Text size="13px" c="dimmed">
                        This node type has no configuration.
                    </Text>
                );
        }
    }

    return (
        <Stack gap="md" p="md" h="100%" style={{ overflowY: 'auto' }}>
            <Group gap={10} wrap="nowrap">
                <span
                    style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 15,
                        flexShrink: 0,
                        background: style.softBg,
                    }}
                >
                    {nodeEmoji(nodeType)}
                </span>
                <div style={{ overflow: 'hidden' }}>
                    <Text fw={800} size="15px" truncate>
                        {label}
                    </Text>
                    <Text size="11px" c="dark.2" tt="uppercase" fw={700} style={{ letterSpacing: '.5px' }}>
                        {style.label} node
                    </Text>
                </div>
            </Group>

            <Text size="12.5px" c="dimmed">
                {nodeDescription(nodeType)}
            </Text>

            <Divider />

            <Stack gap="md">{fields()}</Stack>

            <Divider mt="auto" />

            <Button
                variant="light"
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={onDelete}
            >
                Delete node
            </Button>
        </Stack>
    );
}
