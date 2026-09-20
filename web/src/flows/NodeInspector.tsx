/**
 * Right-hand inspector. Renders the selected block's declared `configFields`, in
 * order, through the shared control library — editing `data` live (no Apply button;
 * changes land in local graph state and are persisted by the toolbar's Save).
 *
 * This file knows no block types. Everything it draws comes off the descriptor.
 */

import { Alert, Button, CopyButton, Divider, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconTrash } from '@tabler/icons-react';
import type {
    FlowValidationIssue,
    GuildChannel,
    GuildRole,
    NodeDescriptor,
    ResourceDeclaration,
} from '../api/types';
import { renderControl } from './controls/renderControl';
import type { ControlContext } from './controls/types';
import { KIND_STYLES } from './nodeMeta';
import { describeUnplacedIssue, placeIssues } from './validationIssues';
import { resolveOutputName, variableToken, type AvailableVariable } from './variables';

interface NodeInspectorProps {
    /** The block this node instantiates, absent when its type is unknown to this build. */
    descriptor: NodeDescriptor | undefined;
    nodeType: string;
    label: string;
    config: Record<string, unknown>;
    roles: GuildRole[];
    channels: GuildChannel[];
    /**
     * Variables blocks upstream of this node write, for its copy fields to offer.
     *
     * Computed by the page, which is the only place holding the whole graph. The
     * inspector draws one node and cannot walk anything.
     */
    variables: AvailableVariable[];
    /** What this flow declares but has not installed yet, for the pickers to offer. */
    declaredResources: ResourceDeclaration[];
    /**
     * Why the last save refused this node, if it did.
     *
     * Only this node's — the page holds the whole list and hands each inspector its
     * slice, so the inspector never has to know which node it is drawing twice.
     */
    issues: readonly FlowValidationIssue[];
    onChange: (patch: Record<string, unknown>) => void;
    onDelete: () => void;
}

export function NodeInspector({
    descriptor,
    nodeType,
    label,
    config,
    roles,
    channels,
    variables,
    declaredResources,
    issues,
    onChange,
    onDelete,
}: NodeInspectorProps) {
    if (!descriptor) {
        return <UnknownNodeInspector nodeType={nodeType} issues={issues} onDelete={onDelete} />;
    }

    const style = KIND_STYLES[descriptor.kind];
    const placed = placeIssues(
        issues,
        descriptor.configFields.map((field) => field.key)
    );
    const context: ControlContext = {
        roles,
        channels,
        variables,
        declaredResources,
        // A picker's resource key is a sibling of its own field, so it patches the
        // node directly rather than going through its single-key `onChange`.
        setConfigKey: (key, value) => onChange({ [key]: value }),
    };

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
                    {descriptor.icon}
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
                {descriptor.description}
            </Text>

            <Divider />

            {/*
             * Above the fields, not below: an issue with no control to sit under is
             * the one the author is least likely to find, so it goes where they are
             * already looking after a failed save.
             */}
            {placed.nodeLevel.length > 0 ? (
                <Alert
                    color="red"
                    variant="light"
                    p="xs"
                    icon={<IconAlertTriangle size={16} />}
                    title="This block can't save"
                >
                    <Stack gap={2}>
                        {placed.nodeLevel.map((issue) => (
                            <Text size="11.5px" key={`${issue.field ?? ''}:${issue.message}`}>
                                {describeUnplacedIssue(issue)}
                            </Text>
                        ))}
                    </Stack>
                </Alert>
            ) : null}

            <Stack gap="md">
                {descriptor.configFields.map((field) => (
                    <div key={field.key}>
                        {renderControl(
                            field,
                            config[field.key],
                            (value) => onChange({ [field.key]: value }),
                            context,
                            config,
                            placed.byField.get(field.key)
                        )}
                    </div>
                ))}

                {descriptor.note ? (
                    <Text size="11.5px" c="dimmed">
                        {descriptor.note}
                    </Text>
                ) : null}

                <ProducedVariables descriptor={descriptor} config={config} />
            </Stack>

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

/**
 * What this block hands to the ones after it, and how to spell it.
 *
 * The answer to "I picked something at random — now what?". The block writes a
 * variable, and the only way to use it is a `{{var.name}}` token in some later
 * block's copy; before this, nothing on screen said so. The token is shown in
 * full and copyable, because the next thing the author does is paste it into a
 * different node's message field.
 *
 * An `authored` output with its field still empty is reported as pending rather
 * than hidden: the block *will* produce something, and "name it first" is the
 * actionable version of an empty section.
 */
function ProducedVariables({
    descriptor,
    config,
}: {
    descriptor: NodeDescriptor;
    config: Record<string, unknown>;
}) {
    if (descriptor.outputs.length === 0) {
        return null;
    }

    return (
        <>
            <Divider label="Hands on to later blocks" labelPosition="left" />

            <Stack gap={8}>
                {descriptor.outputs.map((output) => {
                    const name = resolveOutputName(output, config);
                    const key = output.naming === 'fixed' ? output.key : output.fromField;

                    return (
                        <div key={key}>
                            <Text size="11.5px" fw={700}>
                                {output.label}
                            </Text>
                            {output.description ? (
                                <Text size="11px" c="dimmed">
                                    {output.description}
                                </Text>
                            ) : null}
                            {name ? (
                                <CopyButton value={variableToken(name)}>
                                    {({ copied, copy }) => (
                                        <Tooltip
                                            label={copied ? 'Copied' : 'Copy — paste it into a later block'}
                                            withArrow
                                        >
                                            <UnstyledButton
                                                onClick={copy}
                                                mt={3}
                                                style={{
                                                    display: 'inline-block',
                                                    borderRadius: 6,
                                                    padding: '2px 7px',
                                                    fontSize: 11.5,
                                                    fontWeight: 600,
                                                    fontFamily: 'var(--mantine-font-family-monospace)',
                                                    color: copied
                                                        ? 'var(--mantine-color-teal-4)'
                                                        : 'var(--mantine-color-cyan-4)',
                                                    background: 'rgba(0,162,255,.12)',
                                                    border: '1px solid rgba(0,162,255,.3)',
                                                }}
                                            >
                                                {variableToken(name)}
                                            </UnstyledButton>
                                        </Tooltip>
                                    )}
                                </CopyButton>
                            ) : (
                                <Text size="11px" c="yellow.5" mt={3}>
                                    Give it a name above and later blocks can read it.
                                </Text>
                            )}
                        </div>
                    );
                })}
            </Stack>
        </>
    );
}

/**
 * Inspector for a node whose block this build does not have.
 *
 * There is nothing to configure — we do not know what its fields were — so the only
 * honest offer is to remove it.
 */
function UnknownNodeInspector({
    nodeType,
    issues,
    onDelete,
}: {
    nodeType: string;
    issues: readonly FlowValidationIssue[];
    onDelete: () => void;
}) {
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
                        background: 'rgba(237,66,69,.18)',
                    }}
                >
                    ⚠️
                </span>
                <div style={{ overflow: 'hidden' }}>
                    <Text fw={800} size="15px" truncate>
                        Unknown block
                    </Text>
                    <Text size="11px" c="red.4" tt="uppercase" fw={700} style={{ letterSpacing: '.5px' }}>
                        Broken node
                    </Text>
                </div>
            </Group>

            <Text size="12.5px" c="dimmed">
                This flow references a block this build doesn&apos;t have, so there&apos;s nothing
                to configure. Saving won&apos;t work until it&apos;s gone.
            </Text>

            <Text size="12px" c="red.4" style={{ wordBreak: 'break-all' }}>
                {nodeType}
            </Text>

            {/*
             * There are no controls here to place an issue under — that is what makes
             * this node unknown — so every one it has is listed. Shown rather than
             * dropped: the save named this node, and a panel that said nothing about
             * why would look like the save failed elsewhere.
             */}
            {issues.map((issue) => (
                <Text size="11.5px" c="red.4" key={`${issue.field ?? ''}:${issue.message}`}>
                    {describeUnplacedIssue(issue)}
                </Text>
            ))}

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
