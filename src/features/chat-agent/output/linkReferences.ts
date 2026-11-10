import { listVisibleChannels, type Viewers } from '../tools/visibleChannels';

/** The names one sigil may be followed by. */
type Names = {
    /** Lower-cased name → every piece of Discord markup it could mean. */
    readonly byName: Map<string, Set<string>>;
    /** The original names' lengths, longest first when read: lower-casing can change a length (İ), and the text is sliced by these. */
    readonly lengths: Set<number>;
};

function noNames(): Names {
    return { byName: new Map(), lengths: new Set() };
}

/** A name found at a sigil: its markup, and how much of the text it spans. */
type Resolved = { readonly markup: string; readonly nameLength: number };

/** The reply with its links, and every `#name` in it that is no channel everyone here can see. */
export type LinkedText = {
    readonly text: string;
    /** Names (without `#`), each once, in order of appearance. */
    readonly unknownChannels: readonly string[];
};

/** What to do with a `#name` that names no channel: leave it, or post it without its `#` so it reads as a word. */
export type UnknownChannelMode = 'keep' | 'unmark';

/**
 * The model's reply with its references made clickable: `#name` becomes `<#id>` and `@name`
 * becomes `<@id>` (a member, by display name or username) or `<@&id>` (a role).
 *
 * The model is told to write names and never ids: it gets names right and invents ids. A
 * name becomes a link only when it names exactly one thing — a channel every viewer can see,
 * or a member or role of the server — matched case-insensitively, longest name first, so
 * `#general-nsfw` is not read as `#general`. A `#name` naming no such channel is reported in
 * `unknownChannels` — and with `'unmark'`, posted without its `#`. Anything else is left as the model wrote it, and
 * so is everything inside `code` and ```code blocks```, where Discord would show the raw id.
 * `@everyone` and `@here` are never links. Markup the model wrote itself despite being told
 * not to is kept only when it names one of those same things; any other is made up, and
 * becomes `#unknown-channel` or `@someone` (logged). Nothing here pings: the send's
 * `allowedMentions` decides that.
 */
export function linkReferences(text: string, viewers: Viewers, unknownChannelMode: UnknownChannelMode = 'keep'): LinkedText {
    if (!text.includes('#') && !text.includes('@')) return { text, unknownChannels: [] };
    const guild = viewers[0].guild;
    const channels = noNames();
    for (const channel of listVisibleChannels(viewers)) addName(channels, channel.name, `<#${channel.id}>`);
    const people = noNames();
    for (const member of guild.members.cache.values()) {
        addName(people, member.displayName, `<@${member.id}>`);
        addName(people, member.user.username, `<@${member.id}>`);
    }
    // As `getServerInfo` lists them: no @everyone, and no integration roles — a bot's is named after the bot.
    for (const role of guild.roles.cache.values()) {
        if (role.id !== guild.id && !role.managed) addName(people, role.name, `<@&${role.id}>`);
    }
    for (const never of NEVER_LINKED) people.byName.delete(never);
    const known = new Set([...channels.byName.values(), ...people.byName.values()].flatMap((markups) => [...markups]));

    // Odd pieces are code: a fenced block or an inline span, left untouched.
    const unknown = new Set<string>();
    const linked = text
        .split(CODE)
        .map((piece, index) => {
            if (index % 2 === 1) return piece;
            const withChannels = link(dropUnknownMarkup(piece, known), '#', channels, { unknown, mode: unknownChannelMode });
            return link(withChannels, '@', people);
        })
        .join('');
    return { text: linked, unknownChannels: [...unknown] };
}

/** Where `link` reports the `#name`s it could not link, and what it does with them. */
type UnknownChannels = { readonly unknown: Set<string>; readonly mode: UnknownChannelMode };

/** The name a `#` starts, as far as name characters go — digits alone are a number (rule #3), not a name. */
function nameAt(text: string, start: number): string | undefined {
    const name = /^[\p{L}\p{N}_-]+/u.exec(text.slice(start))?.[0];
    return name && !/^\d+$/.test(name) ? name : undefined;
}

/** A fenced block or an inline code span; captured, so `split` puts code at the odd indexes. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

/** Discord markup by id: a channel, a role, or a member (with or without the old `!`). */
const MARKUP = /<(#|@&|@!?)(\d+)>/g;

/** Model-written `<#id>`/`<@id>`/`<@&id>` naming nothing in `known` (an invented id, a channel not everyone sees) as plain text. */
function dropUnknownMarkup(text: string, known: ReadonlySet<string>): string {
    return text.replace(MARKUP, (markup: string, sigil: string, id: string) => {
        const normal = sigil === '#' ? `<#${id}>` : sigil === '@&' ? `<@&${id}>` : `<@${id}>`;
        if (known.has(normal)) return normal;
        console.warn(`[chat-agent] model wrote unknown markup ${markup}; posted as text`);
        return sigil === '#' ? '#unknown-channel' : '@someone';
    });
}

/** Characters that may continue a name: a name ends where none follows. */
const NAME_CHARACTER = /[\p{L}\p{N}_-]/u;

/** Names never made links, even if a member or role is called them. */
const NEVER_LINKED = ['everyone', 'here'];

function addName(names: Names, name: string, markup: string): void {
    if (!name) return;
    names.lengths.add(name.length);
    const key = name.toLowerCase();
    const markups = names.byName.get(key) ?? new Set<string>();
    markups.add(markup);
    names.byName.set(key, markups);
}

function link(text: string, sigil: '#' | '@', names: Names, unknownChannels?: UnknownChannels): string {
    if (!text.includes(sigil)) return text;
    // Longest first, so a name is never cut short by a shorter one it starts with.
    const lengths = [...names.lengths].sort((left, right) => right - left);
    let result = '';
    let index = 0;
    while (index < text.length) {
        const at = text.indexOf(sigil, index);
        if (at === -1) break;
        result += text.slice(index, at);
        const isReference = isReferenceStart(text, at);
        const linked = isReference ? resolve(text, at + 1, names, lengths) : undefined;
        const candidate = isReference && !linked && unknownChannels ? nameAt(text, at + 1) : undefined;
        // A name two channels share is real, just ambiguous — not made up.
        const unknownName = candidate && !names.byName.has(candidate.toLowerCase()) ? candidate : undefined;
        if (linked) {
            result += linked.markup;
            index = at + 1 + linked.nameLength;
        } else if (unknownName && unknownChannels) {
            unknownChannels.unknown.add(unknownName);
            result += unknownChannels.mode === 'unmark' ? unknownName : `${sigil}${unknownName}`;
            index = at + 1 + unknownName.length;
        } else {
            result += sigil;
            index = at + 1;
        }
    }
    return result + text.slice(index);
}

/** A sigil starts a reference unless it continues a word (`a@b.com`), a path (`site.com/#rules`) or sits in markup (`<#…>`). */
function isReferenceStart(text: string, at: number): boolean {
    const before = text[at - 1];
    return before === undefined || (before !== '<' && before !== '/' && !NAME_CHARACTER.test(before));
}

/**
 * The longest name that `text` spells from `start`, ending at a name boundary — if it means
 * exactly one thing. Two things sharing that name (two members called Mara) link neither.
 */
function resolve(
    text: string,
    start: number,
    names: Names,
    lengths: readonly number[]
): Resolved | undefined {
    for (const length of lengths) {
        if (start + length > text.length) continue;
        const next = text[start + length];
        if (next !== undefined && NAME_CHARACTER.test(next)) continue;
        const markups = names.byName.get(text.slice(start, start + length).toLowerCase());
        if (!markups) continue;
        const [only] = markups;
        return markups.size === 1 && only ? { markup: only, nameLength: length } : undefined;
    }
    return undefined;
}
