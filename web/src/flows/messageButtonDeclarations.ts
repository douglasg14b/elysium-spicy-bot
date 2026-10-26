/**
 * What the Button Click trigger's "+ New message in…" and "+ New button on this message" write
 * into the journey's declarations.
 *
 * Both make the thing in Resources, not beside it: a button exists only on a message resource,
 * so the trigger's picker and the message window always show the same buttons. Pure functions
 * of the list before, each returning a new list, so the page can apply them as one update.
 */

import type { GuildChannel, MessageButton, MessageButtonStyle, ResourceDeclaration } from '@brattybot/web-sdk';
import {
    declarationForAdoptedResource,
    declarationForNewResource,
    otherHolder,
    postableChannels,
    slugifyResourceName,
    uniqueResourceKey,
} from './resourceAdoption';

/** A text channel the journey declares, offered first. */
export interface DeclaredChannelChoice {
    readonly kind: 'declared';
    readonly key: string;
    readonly name: string;
}

/**
 * A text channel in the server the journey does not declare. Picking it declares it too —
 * adopted, or under the key the journey already installed it as.
 */
export interface ServerChannelChoice {
    readonly kind: 'server';
    readonly channel: GuildChannel;
    /**
     * The key the journey installed this channel under, when its declaration has since gone:
     * picking it declares it again under that key, so install finds its binding and reuses it
     * rather than adopting a channel the journey already holds.
     */
    readonly boundKey?: string;
    /** Who else holds it, when somebody does; such a channel is shown but cannot be picked. */
    readonly heldBy?: string;
}

export type NewMessageChannel = DeclaredChannelChoice | ServerChannelChoice;

export interface NewMessageChannelsInput {
    readonly declared: readonly ResourceDeclaration[];
    /** The server's channels, as the builder read them. */
    readonly channels: readonly GuildChannel[];
    /** The journey the declarations are, so its own channels are not another owner's. */
    readonly journeyKey: string | undefined;
    /** Discord id → resource key, for what the journey has installed. */
    readonly boundKeys: ReadonlyMap<string, string>;
}

/**
 * Where a new message can go: the journey's declared text channels, then the server's.
 *
 * A server channel the journey already declares — adopted, or installed under a key still
 * declared — is not offered twice: it is that declared channel (review item 32), and declaring
 * it again would be two adoptions of one channel, which the save refuses. One another journey
 * or the ticket system holds is shown but cannot be picked (review item 13), as the adopt
 * picker shows it.
 */
export function newMessageChannels(input: NewMessageChannelsInput): {
    readonly declared: DeclaredChannelChoice[];
    readonly server: ServerChannelChoice[];
} {
    const declaredChannels = input.declared.filter((resource) => resource.kind === 'textChannel');
    const declaredKeys = new Set(declaredChannels.map((resource) => resource.key));
    const adopted = new Set(declaredChannels.flatMap((resource) => resource.adoptDiscordId ?? []));

    const server = postableChannels(input.channels).flatMap((channel): ServerChannelChoice[] => {
        if (adopted.has(channel.id)) return [];
        const boundKey = input.boundKeys.get(channel.id);
        if (boundKey !== undefined && declaredKeys.has(boundKey)) return [];

        const holder = otherHolder(channel.owner, input.journeyKey);
        if (holder) return [{ kind: 'server', channel, heldBy: holder.label }];
        if (boundKey !== undefined) return [{ kind: 'server', channel, boundKey }];
        // Held by this journey under a key nothing here can name — the install record has not
        // been read. Adopting it again would be a second claim on one channel, so it waits.
        if (channel.owner) return [{ kind: 'server', channel, heldBy: channel.owner.label }];
        return [{ kind: 'server', channel }];
    });

    return {
        declared: declaredChannels.map((resource) => ({ kind: 'declared', key: resource.key, name: resource.defaultName })),
        server,
    };
}

/** A list with a new message in it, and that message's key, for the trigger to pick. */
export interface DeclaredMessage {
    readonly resources: ResourceDeclaration[];
    readonly messageKey: string;
}

/**
 * `current` with a new message posted in `where`, declaring the channel first when it is one
 * of the server's.
 *
 * The message is seeded as the Resources panel seeds one (step 2's pick 14): "New message",
 * one embed titled with its name, so the save takes it the moment it exists. Its first button
 * comes from "+ New button".
 */
export function declareMessageIn(current: readonly ResourceDeclaration[], where: NewMessageChannel): DeclaredMessage {
    const resources = [...current];
    const channelKey = where.kind === 'declared' ? where.key : declareServerChannel(resources, where);
    const message = declarationForNewResource({ name: '', kind: 'message', existing: resources, parentKey: channelKey });
    return { resources: [...resources, message], messageKey: message.key };
}

/**
 * The key a server channel goes under, adding its declaration to `resources` when it has none:
 * the key it was installed under, else a new adoption named after it.
 */
function declareServerChannel(resources: ResourceDeclaration[], where: ServerChannelChoice): string {
    const { channel, boundKey } = where;
    // The list may have moved on since the menu was drawn; a channel declared meanwhile is used.
    const existing = resources.find(
        (resource) =>
            resource.kind === 'textChannel' && (resource.adoptDiscordId === channel.id || resource.key === boundKey)
    );
    if (existing) return existing.key;

    const declaration: ResourceDeclaration =
        boundKey !== undefined
            ? { key: boundKey, kind: 'textChannel', defaultName: channel.name }
            : declarationForAdoptedResource({ target: channel, kind: 'textChannel', existing: resources });
    resources.push(declaration);
    return declaration.key;
}

/** What "+ New button" was asked for. */
export interface NewButton {
    readonly label: string;
    readonly style: MessageButtonStyle;
}

/** A list with a new button on one of its messages, and that button's key. */
export interface DeclaredButton {
    readonly resources: ResourceDeclaration[];
    readonly buttonKey: string;
}

/**
 * `current` with a button added to message `messageKey`, keyed by its label and kept unique
 * among the message's other buttons — the rule the message window keys a new button by.
 */
export function addButtonToMessage(
    current: readonly ResourceDeclaration[],
    messageKey: string,
    button: NewButton
): DeclaredButton {
    const message = current.find((resource) => resource.kind === 'message' && resource.key === messageKey);
    const existing: readonly MessageButton[] = message?.buttons ?? [];
    const label = button.label.trim();
    const buttonKey = uniqueResourceKey(slugifyResourceName(label) || 'button', existing);

    return {
        resources: current.map((resource) =>
            resource === message
                ? { ...resource, buttons: [...existing, { key: buttonKey, label, style: button.style }] }
                : resource
        ),
        buttonKey,
    };
}
