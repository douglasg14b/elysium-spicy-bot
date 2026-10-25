import { holdsCopyToken } from '../../../shared/copyTokens';
import { messageConfigSchema, messageCopyLocations, messagePictures } from '../../../shared/discordMessage';
import type { ResourceDeclaration } from './resourceDeclaration';

/** One reason a message resource cannot be posted as declared, and the part to fix. */
export interface MessageResourceProblem {
    /**
     * The part as the editor names it, numbered from one — `embed 2 footer`, `button 3` — or
     * `embed 2` for something in an embed with no part of its own. Absent for the message as
     * a whole.
     */
    readonly where?: string;
    readonly message: string;
}

/** Copy holding a `{{token}}`: a posted message has no run to fill one in. */
const TOKEN_IN_TEXT =
    "No tokens here — this message sits in its channel for everyone, so there's nobody to fill {{…}} in for, " +
    'and it would go out braces and all. Spell it out.';

/** A picture holding a `{{token}}`, for the same reason. */
const TOKEN_IN_PICTURE =
    "No tokens here — this message sits in its channel for everyone, so there's nobody to fill {{…}} in for. " +
    'Pick an upload or paste a link.';

/**
 * Where a problem at `path` sits, as the editor names it: the part itself when the path is
 * one of the message's parts, else the embed it is inside, else nowhere — the message as a
 * whole. The window places a sentence the same way (`placeMessageIssues`).
 *
 * The part names come from the one walk over a message (`messageCopyLocations` and
 * `messagePictures`), so a part is named here exactly as everywhere else.
 */
function whereIn(message: unknown, path: readonly PropertyKey[]): string | undefined {
    const joined = path.map(String).join('.');
    const part = [...messageCopyLocations(message), ...messagePictures(message)].find(
        (candidate) => candidate.path.join('.') === joined
    );
    if (part) return part.where;

    const [first, embed] = path;
    return first === 'embeds' && typeof embed === 'number' ? `embed ${embed + 1}` : undefined;
}

/**
 * Why a message resource cannot be posted as declared, in the order an author meets them,
 * or nothing when it can. Pure: the uploads, which need this server's, are judged apart
 * (`messageUploadProblems`).
 *
 *  1. **The message is one Discord takes**: `messageConfigSchema`, which holds every part's
 *     own rule, the rules spanning parts (`messageProblems`) and the picture and title-link
 *     forms — the rules a Post Embed node is saved under.
 *  2. **No `{{tokens}}`, anywhere**: not in its copy, not in a picture, not in a button's
 *     label. A posted message has no member and no run, so nothing can fill one in — not
 *     even `{{guild.name}}`, which would need a second renderer outside flows and make every
 *     message drift when the server is renamed. Literal `{{…}}` text is refused with them.
 *  3. **Each button's key is its own**, since the key is what a press is routed by.
 *
 * A declaration with no `message` has nothing to judge: that it must carry one is the
 * structural rule `validateJourneyDeclaration` asks.
 */
export function messageResourceProblems(declaration: ResourceDeclaration): readonly MessageResourceProblem[] {
    const { message } = declaration;
    if (!message) return [];

    const problems: MessageResourceProblem[] = [];

    const parsed = messageConfigSchema.safeParse(message);
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            const where = whereIn(message, issue.path);
            problems.push({ ...(where ? { where } : {}), message: issue.message });
        }
    }

    for (const location of messageCopyLocations(message)) {
        if (holdsCopyToken(location.value)) {
            problems.push({ where: location.where, message: location.checkRendered ? TOKEN_IN_PICTURE : TOKEN_IN_TEXT });
        }
    }

    const buttons = declaration.buttons ?? [];
    for (const [index, button] of buttons.entries()) {
        if (holdsCopyToken(button.label)) {
            problems.push({ where: `button ${index + 1}`, message: TOKEN_IN_TEXT });
        }
    }

    const seenKeys = new Set<string>();
    for (const [index, button] of buttons.entries()) {
        if (seenKeys.has(button.key)) {
            problems.push({
                where: `button ${index + 1}`,
                message: `Another button on this message already has the key "${button.key}". Give each its own — it's how a press finds its way.`,
            });
        }
        seenKeys.add(button.key);
    }

    return problems;
}

/**
 * One problem with a message resource as an operator reads it: `"Rules panel" embed 2
 * footer: …`, the resource's name in quotes, then the part. An upload problem
 * (`MessageUploadProblem`) has the same shape and is worded the same way.
 */
export function describeMessageResourceProblem(name: string, problem: MessageResourceProblem): string {
    return problem.where ? `"${name}" ${problem.where}: ${problem.message}` : `"${name}": ${problem.message}`;
}
