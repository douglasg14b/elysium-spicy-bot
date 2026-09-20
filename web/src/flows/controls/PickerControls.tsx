/**
 * The two snowflake pickers. Nobody ever types a raw id, per the block contract's
 * `rolePicker`/`channelPicker` entries.
 *
 * Both offer two kinds of thing: objects that exist in the guild, and resources this
 * flow *declares* but that provisioning has not created yet. Declared resources are
 * the point of the provisioning step — an author builds the whole flow and installs
 * the structure afterwards, instead of creating channels by hand to have something to
 * pick.
 *
 * A declared resource is stored as a **resource key in a sidecar config field**, not
 * as the value itself: `roleId` keeps holding a snowflake (the block hands it to
 * `roles.add()` unchanged), and `roleIdKey` records which declaration it came from.
 * Install fills the snowflake in. Keeping the key is what makes a
 * deleted-and-recreated channel repairable by re-installing rather than by editing
 * every flow that referenced it.
 */

import { useMemo } from 'react';
import { Select, Text } from '@mantine/core';
import { roleColorHex } from '../nodeMeta';
import { asText, resourceKeyFieldFor, type ControlProps } from './types';
import type { BlockConfigField, ResourceDeclaration, ResourceKind } from '../../api/types';

type RolePickerField = Extract<BlockConfigField, { control: 'rolePicker' }>;
type ChannelPickerField = Extract<BlockConfigField, { control: 'channelPicker' }>;

/**
 * Option values for declared resources are namespaced.
 *
 * A resource key and a snowflake are both strings, and a guild whose role is somehow
 * named like a key must not be mistaken for a declaration. The prefix makes the two
 * spaces disjoint by construction rather than by assuming ids stay numeric.
 */
const DECLARED_PREFIX = 'resource:';

export function declaredOptionValue(key: string): string {
    return `${DECLARED_PREFIX}${key}`;
}

export function parseDeclaredOption(value: string): string | undefined {
    return value.startsWith(DECLARED_PREFIX) ? value.slice(DECLARED_PREFIX.length) : undefined;
}

/**
 * What the picker should show as selected.
 *
 * The resource key wins when present: it is canonical, and a config carrying both a
 * key and a stale snowflake should read as the resource it names, not as whatever the
 * id used to point at.
 */
export function currentValue(value: unknown, resourceKey: unknown): string | null {
    const key = asText(resourceKey);
    if (key) return declaredOptionValue(key);
    return asText(value) || null;
}

interface DeclaredGroupOptions {
    resources: ResourceDeclaration[];
    kinds: readonly ResourceKind[];
    prefix: string;
}

/** Declared resources of the right kinds, as a labelled option group. */
function declaredGroup({ resources, kinds, prefix }: DeclaredGroupOptions) {
    const matching = resources.filter((resource) => kinds.includes(resource.kind));
    if (matching.length === 0) return undefined;

    return {
        group: 'Declared by this flow — not created yet',
        items: matching.map((resource) => ({
            value: declaredOptionValue(resource.key),
            label: `${prefix}${resource.defaultName}`,
        })),
    };
}

/** Searchable role picker showing each role's own colour as a leading dot. */
export function RolePickerControl({
    field,
    value,
    onChange,
    context,
    config,
    error,
}: ControlProps<RolePickerField>) {
    const resourceKeyField = resourceKeyFieldFor(field.key);
    const current = currentValue(value, config?.[resourceKeyField]);

    const options = useMemo(() => {
        // Highest roles first, as Discord itself lists them.
        const existing = [...context.roles]
            .sort((first, second) => second.position - first.position)
            .map((role) => ({ value: role.id, label: `@${role.name}` }));

        const declared = declaredGroup({
            resources: context.declaredResources,
            kinds: ['role'],
            prefix: '@',
        });

        return declared
            ? [declared, { group: 'Roles in this server', items: existing }]
            : existing;
    }, [context.roles, context.declaredResources]);

    const selected = context.roles.find((role) => role.id === asText(value));
    const declaredKey = asText(config?.[resourceKeyField]);

    return (
        <>
            <Select
                label={field.label}
                description={field.description}
                placeholder="Pick a role"
                error={error}
                data={options}
                value={current}
                onChange={(next) => {
                    const resourceKey = next ? parseDeclaredOption(next) : undefined;
                    if (resourceKey) {
                        // The snowflake is unknown until install; the key is what this
                        // flow actually means. Clearing the id avoids leaving a stale
                        // one that would look valid to the executor.
                        context.setConfigKey(resourceKeyField, resourceKey);
                        onChange('');
                        return;
                    }
                    context.setConfigKey(resourceKeyField, undefined);
                    onChange(next ?? '');
                }}
                searchable
                nothingFoundMessage="No roles found"
                allowDeselect={false}
                leftSection={
                    selected ? (
                        <span
                            style={{
                                width: 11,
                                height: 11,
                                borderRadius: '50%',
                                display: 'block',
                                background: roleColorHex(selected.color),
                            }}
                        />
                    ) : undefined
                }
            />
            {declaredKey && <PendingHint />}
        </>
    );
}

/** Searchable channel picker. */
export function ChannelPickerControl({
    field,
    value,
    onChange,
    context,
    config,
    error,
}: ControlProps<ChannelPickerField>) {
    const resourceKeyField = resourceKeyFieldFor(field.key);
    const current = currentValue(value, config?.[resourceKeyField]);

    const options = useMemo(() => {
        const existing = context.channels.map((channel) => ({
            value: channel.id,
            label: `# ${channel.name}`,
        }));

        // Categories are excluded: a message goes in a text channel, and offering a
        // category here would produce a config the executor cannot use.
        const declared = declaredGroup({
            resources: context.declaredResources,
            kinds: ['textChannel'],
            prefix: '# ',
        });

        return declared
            ? [declared, { group: 'Channels in this server', items: existing }]
            : existing;
    }, [context.channels, context.declaredResources]);

    const declaredKey = asText(config?.[resourceKeyField]);

    return (
        <>
            <Select
                label={field.label}
                description={field.description}
                placeholder="Pick a channel"
                error={error}
                data={options}
                value={current}
                onChange={(next) => {
                    const resourceKey = next ? parseDeclaredOption(next) : undefined;
                    if (resourceKey) {
                        context.setConfigKey(resourceKeyField, resourceKey);
                        onChange('');
                        return;
                    }
                    context.setConfigKey(resourceKeyField, undefined);
                    onChange(next ?? '');
                }}
                searchable
                nothingFoundMessage="No channels found"
                allowDeselect={false}
            />
            {declaredKey && <PendingHint />}
        </>
    );
}

/**
 * Say plainly that the flow cannot run yet.
 *
 * A picked-but-uninstalled resource is a perfectly valid thing to be mid-authoring,
 * and silently looking identical to a real selection is how an author discovers the
 * problem at run time instead of here.
 */
function PendingHint() {
    return (
        <Text size="11px" c="yellow" mt={4}>
            Not created yet — install this flow&apos;s resources before running it.
        </Text>
    );
}
