/**
 * Shared shapes for the control library.
 *
 * A control renders from a {@link BlockConfigField} declaration alone, plus the
 * current value and a way to change it. Nothing here knows a block type: the only
 * switch in this directory is on `field.control`, which is the control vocabulary
 * the block contract defines as its extension point.
 */

import type {
    BlockConfigField,
    DiscordMessage,
    Eligibility,
    GuildChannel,
    GuildEmoji,
    GuildRole,
    GuildSettings,
    GuildUpload,
    MessageButton,
    MessageButtonRef,
    ResourceDeclaration,
    TicketTypeView,
} from '@brattybot/web-sdk';
import { zMessageButtonStyle } from '@brattybot/web-sdk';
import type { ButtonListenersView } from '../buttonListeners';
import type { AvailableVariable, RequirementAvailability } from '../variables';

/**
 * What a control needs from the page beyond its own declaration.
 *
 * Only the pickers and the copy fields read this, but passing one object keeps
 * every control's signature identical, so the dispatcher never special-cases who
 * gets what.
 */
export interface ControlContext {
    roles: GuildRole[];
    channels: GuildChannel[];
    /**
     * The guild's own declared ticket types, for the ticket-type picker. Read from the
     * same config the tickets page edits, so a type an operator adds there is offered
     * here without anything in the builder knowing its name.
     */
    ticketTypes: TicketTypeView[];
    /**
     * Variables some upstream block writes, for the copy fields to offer.
     *
     * A property of the *node*, not of the field, which is why it arrives through
     * the context rather than the declaration: the same `longText` field offers
     * different variables depending on what is wired above it.
     */
    variables: AvailableVariable[];
    /**
     * Which run-context requirements can be relied on at this node.
     *
     * A property of the node for the same reason `variables` is: a member, an actor or a
     * channel is there or not depending on what is wired above. The copy fields grey a
     * token chip, and the choice controls disable an option, whose requirement is not —
     * see `requirementAvailableAt` in `../variables.ts`. Save is what refuses.
     */
    requirements: RequirementAvailability;
    /**
     * Resources this flow declares but that may not exist in the guild yet.
     *
     * Offered by the pickers beside real channels and roles, which is the capability
     * the whole provisioning step is for: an author builds the flow first and installs
     * the structure after, rather than creating channels by hand to have something to
     * pick.
     */
    declaredResources: ResourceDeclaration[];
    /**
     * Write a config key other than the control's own.
     *
     * For a sidecar beside the control's own key. The pickers write the resource-key
     * sidecar: picking a declared resource writes both `<field>` (the snowflake, empty
     * until install) and `<field>Key` (the resource key, which is canonical). A `message`
     * field writes its buttons into the key its `buttonsKey` names, so the message value
     * keeps the shape every message shares.
     *
     * Two keys rather than one structured value because `roleId` is handed straight
     * to `roles.add()` by the block — a structured value there would change seven
     * block schemas, every executor read, and need a migration for saved graphs, to
     * express something a sibling key already says.
     */
    setConfigKey: (key: string, value: string | MessageButton[] | undefined) => void;
    /**
     * The server's time zone — the one it picked, or `null`, beside the zone an unpicked
     * server runs on — for a control whose value is a time on the server's clock.
     *
     * Fetched once by the page rather than by the control (no control fetches), and only
     * there once that fetch has answered: absent while it is on its way or after it
     * failed, when such a control simply says nothing about the zone.
     */
    serverTimeZone?: ServerTimeZone;
    /**
     * The server's uploaded pictures, and the way to add one — for a control with picture
     * parts (`message`). The page reads and sends; the control fetches nothing.
     */
    uploads: GuildUploads;
    /**
     * The server's own emoji, for a control drawing or making a message's buttons
     * (`messageButton`): each button's face, and "+ New button"'s emoji grid.
     *
     * Read by the page, as the time zone is, and only there once that read has answered:
     * absent while it is on its way or after it failed, when the grid offers only the standard
     * emoji and no button's emoji is called gone.
     */
    serverEmojis?: readonly GuildEmoji[];
    /**
     * Change the journey's declarations — the same list the Resources dialog edits, saved by
     * the same autosave whether the dialog is open or not.
     *
     * Only `messageButton` writes through this, for "+ New message in…" and "+ New button on
     * this message": a button exists only on a message resource, so making one from the
     * trigger makes it in Resources. An updater rather than a list, so it applies to the list
     * as it stands when React runs it, not as this render saw it.
     */
    declareResources: (update: (current: readonly ResourceDeclaration[]) => ResourceDeclaration[]) => void;
    /**
     * Who listens to the journey's buttons and to its blocks' posted buttons, and which blocks
     * post some — the server's answer with this flow's own picks and posts replaced by what is
     * on the canvas — and which flow and node this control is drawn for, so a button another
     * flow holds can be told from this one's own, and a block's message window can name who
     * listens to its own buttons.
     */
    listeners: ButtonListenersView;
    /**
     * Which journey the declarations are, and what it has installed — so "+ New message in…"
     * tells a channel this journey holds from one another owner does.
     */
    journey: JourneyHoldings;
}

/** A journey as "+ New message in…" needs it. */
export interface JourneyHoldings {
    /** Its key, or `undefined` for a flow on no journey yet: then every holder is somebody else. */
    readonly key: string | undefined;
    /**
     * Discord id → resource key, for what it has installed: a message goes in a channel the
     * journey already holds under that channel's own key, rather than adopting it a second time.
     */
    readonly boundKeys: ReadonlyMap<string, string>;
}

/** A server's uploaded pictures, as the page hands them to a control. */
export interface GuildUploads {
    /**
     * The server's uploads, newest first, without their bytes. Empty until the page's read
     * answers, and after one that failed — a picture can still be uploaded or linked then.
     */
    readonly items: readonly GuildUpload[];
    /**
     * Keep a picture for this server. Resolves with it as kept — the one already kept, when
     * the server held these exact bytes — and throws the server's refusal (`ApiError`): too
     * big, not a picture, or the server full.
     */
    readonly upload: (file: File) => Promise<GuildUpload>;
    /** Where the browser shows one of this server's uploads from. */
    readonly imageUrl: (uploadId: string) => string;
}

/** A server's time zone setting, as the guild-settings endpoint reports it. */
export type ServerTimeZone = Pick<GuildSettings, 'timeZone' | 'defaultTimeZone'>;

/** The config key holding a picker's resource key, beside the snowflake itself. */
export function resourceKeyFieldFor(fieldKey: string): string {
    return `${fieldKey}Key`;
}

/**
 * Emit a change for one config key.
 *
 * `undefined` means *remove the key* — how an `optional` duration says "unset"
 * rather than writing a zero the server would reject. The consumer deletes it
 * outright rather than leaving it present-but-`undefined`; see `updateNodeConfig`
 * in `FlowBuilderPage` for why the difference is load-bearing.
 *
 * `boolean` is `toggle`'s value, `string[]` is `textList`'s, `Record<string, unknown>[]` is `objectList`'s,
 * `Eligibility` is `eligibility`'s, `DiscordMessage` is `message`'s and `MessageButtonRef`
 * is `messageButton`'s — the generated types, so no hand-written shape lives in the
 * builder. All five are a **new value every time** rather than a mutated one: the patch lands in React state, so a
 * control that edited its current value in place would write a value the renderer
 * cannot tell apart from the old one. `objectList` is the first where that rule has to hold at
 * two levels — a new array of the *same* entry objects is just as invisible.
 *
 * A union of the concrete value types rather than `unknown`, deliberately. It is
 * the one place that says what a `node.data` value may be, so a control emitting
 * a shape no schema accepts fails here rather than at save time in front of an
 * author.
 *
 * `Record<string, unknown>[]` is as narrow as this can honestly be: an entry's
 * keys are declared per field by the block's `columns`, which is data rather than
 * a type, so there is no shape here to be more specific about. The schema is the
 * authority, exactly as it is for every other control.
 */
export type ControlChange = (
    value:
        | string
        | number
        | boolean
        | string[]
        | Record<string, unknown>[]
        | Eligibility
        | DiscordMessage
        | MessageButtonRef
        | undefined
) => void;

/**
 * One complaint addressed below a field, to the part it names — `embeds.0.title` inside a
 * message. The path is relative to the field, dotted as the server addresses it.
 */
export interface NestedIssue {
    readonly path: string;
    readonly message: string;
}

/** Props every control in this directory takes. */
export interface ControlProps<TField extends BlockConfigField = BlockConfigField> {
    field: TField;
    /** The current `node.data` value for `field.key`, whatever shape it is on the wire. */
    value: unknown;
    onChange: ControlChange;
    context: ControlContext;
    /**
     * The whole node's config, for the rare control that reads a sibling key.
     *
     * The pickers read their resource-key sidecar from it, and a `message` field its
     * buttons. Passed to every control so the dispatcher stays free of special cases.
     */
    config?: Record<string, unknown>;
    /**
     * What the server last found wrong with this field, if anything — at the last save,
     * or the last re-check as focus left a field.
     *
     * On {@link ControlProps} rather than on each control that wants it, so every
     * control — present and future — gets field-level errors without its own
     * plumbing. Mantine inputs all take an `error` prop, so most controls spend one
     * line on it.
     *
     * A control that cannot place an error (the list controls, whose issues arrive
     * on a dotted path naming an entry rather than the field) may ignore this; the
     * inspector renders anything unplaced at node level rather than dropping it.
     */
    error?: string;
    /**
     * Complaints about the parts inside this field's value, each with its path relative to
     * the field — only for a control that can show a part's complaint where the part is
     * (`message`; see `placeIssues`). Every other control's dotted issues stay at node level.
     */
    issues?: readonly NestedIssue[];
}

/** Narrow an unknown `node.data` value to a string for controlled inputs. */
export function asText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** Narrow an unknown `node.data` value to a finite number, or `null` when unset. */
export function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Narrow an unknown `node.data` value to a list of strings.
 *
 * Non-string entries are dropped rather than coerced. A saved graph whose list
 * holds a number got there through an API the schema rejects, so showing it as
 * `"3"` would invite an author to keep a value the save will not take.
 */
export function asTextList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Narrow an unknown `node.data` value to a message's buttons, for the message window.
 *
 * Only what the window needs to draw a button is asked — a key and a style, both strings —
 * and anything else is dropped, as `asTextList` drops a non-string. A button breaking a rule
 * (a label too long, a key with a capital) is kept: the window shows it so the author can
 * fix it, and the server's re-check says what is wrong.
 *
 * The stored list itself when every entry passes, and one shared empty list when there is
 * none, so the value is the same object from render to render while nothing changes — the
 * window's Cancel writes the buttons back only when they are not.
 */
export function asMessageButtons(value: unknown): readonly MessageButton[] {
    if (!Array.isArray(value)) return NO_BUTTONS;
    return value.every(isButtonShaped) ? value : value.filter(isButtonShaped);
}

const NO_BUTTONS: readonly MessageButton[] = [];

/**
 * Whether an entry is a button the window can draw: a string key, one of the four styles (the
 * window colours a face by its style, and has no colour for any other), a string label or none,
 * and an object emoji or none. Lengths and patterns are not asked — those the author can fix.
 */
function isButtonShaped(entry: unknown): entry is MessageButton {
    if (typeof entry !== 'object' || entry === null) return false;
    const { key, style, label, emoji } = entry as Record<string, unknown>;
    return (
        typeof key === 'string' &&
        zMessageButtonStyle.safeParse(style).success &&
        (label === undefined || typeof label === 'string') &&
        (emoji === undefined || (typeof emoji === 'object' && emoji !== null && typeof (emoji as Record<string, unknown>).name === 'string'))
    );
}
