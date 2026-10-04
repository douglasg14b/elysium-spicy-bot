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
import { channelOptionLabel, postableChannels } from '../resourceAdoption';
import { asText, resourceKeyFieldFor, type ControlProps } from './types';
import type { BlockConfigField, BlockOutputValueKind } from '@brattybot/web-sdk';
import type { ResourceDeclaration, ResourceKind } from '../../api/types';
import { pickerVariableOf, variableToken, type AvailableVariable } from '../variables';

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
    const pickedVariable = pickerVariableOf(asText(value));
    const pickedMissing =
        pickedVariable !== undefined &&
        !context.variables.some((variable) => variable.name === pickedVariable && variable.valueKind === 'channel');

    const options = useMemo(() => {
        /*
         * Categories are excluded **here**, which is a change from what this comment
         * used to claim.
         *
         * It previously said categories were excluded while doing nothing to exclude
         * them — true only because `GET /channels` filtered them out on the server, two
         * files away and across the wire. The endpoint now sends them so a category can
         * be adopted, which would have made this list offer one as a place to post: a
         * config the executor cannot use, failing in a live guild after publish.
         *
         * `postableChannels` is the same predicate the adoption picker uses, so the two
         * cannot disagree about what "somewhere to post" means.
         */
        const existing = postableChannels(context.channels).map((channel) => ({
            value: channel.id,
            label: channelOptionLabel(channel),
        }));

        const declared = declaredGroup({
            resources: context.declaredResources,
            kinds: ['textChannel'],
            prefix: '# ',
        });

        const fromBlocks = variableGroup(context.variables, 'channel', pickedVariable);

        const groups = [fromBlocks, declared].filter((group) => group !== undefined);
        return groups.length > 0
            ? [...groups, { group: 'Channels in this server', items: existing }]
            : existing;
    }, [context.channels, context.declaredResources, context.variables, pickedVariable]);

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
                    // A cleared optional pick removes the key, as an emptied optional
                    // text box does; a required one keeps writing `''`.
                    onChange(next ?? (field.optional ? undefined : ''));
                }}
                searchable
                nothingFoundMessage="No channels found"
                allowDeselect={false}
                clearable={field.optional ?? false}
            />
            {declaredKey && <PendingHint />}
            {pickedMissing && pickedVariable && (
                <Text size="11px" c="yellow" mt={4}>
                    {context.variables.some((variable) => variable.name === pickedVariable)
                        ? `${variableToken(pickedVariable)} is recorded above, but it is not a channel. Pick another.`
                        : `Nothing above this block records ${variableToken(pickedVariable)} on this path — ` +
                          'the run will stop here. Wire in the block that finds it, or pick another channel.'}
                </Text>
            )}
        </>
    );
}

/**
 * In-scope variables of one kind, as a labelled option group.
 *
 * The option's value is the token itself, so picking one stores `{{var.<name>}}`
 * in the field — the same spelling copy uses, resolved by the engine just before
 * the block runs. A name already picked but no longer in scope is kept as an
 * option, so the field shows what it holds rather than going blank while the
 * config still says otherwise.
 */
function variableGroup(
    variables: readonly AvailableVariable[],
    kind: BlockOutputValueKind,
    picked: string | undefined
) {
    const items = variables
        .filter((variable) => variable.valueKind === kind)
        .map((variable) => ({
            value: variableToken(variable.name),
            // The name as `{{var.…}}` spells it, then which block finds it — the
            // same two facts the variable chips under a copy field show.
            label: `${variable.producerIcon} ${variable.name} · from ${variable.producerLabel}`,
        }));

    if (picked !== undefined && !items.some((item) => item.value === variableToken(picked))) {
        items.push({ value: variableToken(picked), label: `${variableToken(picked)} — not found above` });
    }

    return items.length > 0 ? { group: 'From earlier blocks', items } : undefined;
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
