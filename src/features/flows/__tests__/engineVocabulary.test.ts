/**
 * The leakage gate: the flow engine's core may not learn a use case.
 *
 * M1's premise is that the engine is a general interpreter — it knows flows, runs,
 * nodes and blocks, and it does *not* know that one of its flows happens to onboard
 * new members. The onboarding journey is a template built out of blocks, not a
 * concept the interpreter has heard of. That premise decays quietly: nothing stops a
 * future change from adding `isOnboardingFlow` to the executor, and once one such
 * name lands the next is easier to justify.
 *
 * **An allowlist, not a denylist.** A denylist of this journey's nouns would report
 * green while the engine accreted subsystem knowledge under different words — it can
 * only catch the leak you already thought of. The allowlist names what the engine is
 * *about*, so a word that is neither engine vocabulary nor general programming
 * vocabulary has to be argued onto the list before it can ship.
 *
 * ## What this gate does and does not claim
 *
 * It checks **declared identifiers in code** — not comments, not string literals.
 * Both exclusions are deliberate and neither is free:
 *
 * - **Comments** explain the engine, and explaining it by example ("e.g. the
 *   onboarding template") is good writing, not leakage. A gate that flagged prose
 *   would be argued with until it was disabled.
 * - **String literals** are user-facing copy and log lines. The engine's own logs
 *   legitimately quote flow names, which are user data.
 *
 * So the honest claim is bounded: **the engine cannot grow a use-case-shaped name at
 * a declaration site** — a `const`/`let`/`function`/`class`/`interface`/`type`/`enum`
 * binding, or a member declared inside an interface, type literal, class or enum.
 * Parameters and destructured bindings are *not* scanned, and a use case smuggled in
 * entirely through comments and strings would pass.
 *
 * Those are real holes, and the alternative — scan every identifier — was measured
 * and rejected: over the real engine it produced 1439 unrecognised words, nearly all
 * English connectives and language keywords, a signal-to-noise ratio at which a gate
 * gets suppressed rather than obeyed. Interface members were added after a review
 * pointed out that `interface FlowRunContext { onboardingStage: string }` is a
 * use-case name by any reading; that widening cost 27 further words on the generic
 * list, which is roughly the price per unit of coverage here.
 *
 * ## Why there are two lists
 *
 * {@link DOMAIN_VOCABULARY} is what the engine is about. {@link GENERIC_VOCABULARY}
 * is words that carry no domain meaning in *any* codebase (`result`, `queue`,
 * `filter`). Splitting them is what makes the gate usable: without the second list,
 * all 143 declared-identifier words in today's engine would fail, and the fix would
 * be to inflate the domain list with generic terms until it stopped discriminating.
 *
 * The split was verified before it was trusted: with both lists in place, today's
 * engine has **zero** unrecognised words, and every one of the nine named
 * use-case nouns below is still caught. That is the property that makes a failure
 * here meaningful — the gate is not merely passing, it is passing with no slack.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FLOWS_DIR = join(REPO_ROOT, 'src', 'features', 'flows');

/**
 * The engine core, which must stay use-case free.
 *
 * `templates/` is deliberately outside: the onboarding journey is *supposed* to name
 * onboarding, welcome copy and rules. So are `commands/` and `logic/` (Discord
 * surfaces, not the interpreter) and `blocks/<block>/` (a block is a named Discord
 * capability and may say `role` or `embed`). What is inside is the interpreter, its
 * persistence, and the block *contract* — the parts that would be wrong to specialise.
 */
const GATED_PATHS = [
    { path: join(FLOWS_DIR, 'engine'), recursive: true },
    { path: join(FLOWS_DIR, 'data'), recursive: true },
    { path: join(FLOWS_DIR, 'constants.ts'), recursive: false },
    { path: join(FLOWS_DIR, 'blocks'), recursive: false },
] as const;

/** The words the gated files may use as domain nouns. */
const DOMAIN_VOCABULARY = [
    // Engine structure
    'flow', 'graph', 'node', 'edge', 'block', 'manifest', 'descriptor', 'registry',
    'position', 'config', 'handle', 'outcome', 'step', 'visit', 'log', 'validation',
    'conformance', 'discovery',
    // Run lifecycle
    'run', 'status', 'suspend', 'resume', 'claim', 'park', 'wake', 'wait', 'delay',
    'retry', 'cancel', 'schedule', 'poll', 'tick', 'sweep', 'context', 'snapshot',
    // What a run is about, who moved it, and what it carries. All three are named
    // on the PRD's own leakage allowlist, so adding them states an engine concept
    // rather than widening what the engine may say: `subject` and `actor` are the
    // two halves of the member split, and `variable` is the bag one block leaves
    // for another. None of them names a use case.
    'subject', 'actor', 'variable',
    // Who may start or advance a run. An engine concept rather than a feature:
    // §5.4 makes eligibility a property of *every* trigger, so the interpreter is
    // the only place it can live — a check enforced per block would be absent from
    // whichever surface nobody remembered. `principal` names who is admitted;
    // neither word says what the guarded flow is *for*, which is the line this
    // gate draws.
    //
    // **The concept is named `eligibility`, not `audience`, because of this
    // test.** `audience` is a PROVEN_REJECTION — "the audience for this welcome
    // message" is exactly the use-case noun the gate exists to keep out — and
    // admitting it would have blinded the check to that leak to buy one word.
    // The PRD calls the feature an audience gate; the engine calls it
    // eligibility, which is also §5.4's own word for it.
    //
    // Note what is deliberately **not** here either: `moderator`. That would be
    // the engine naming a guild's staff structure — `roles` and `permission`
    // already express it without the engine knowing whose they are.
    'eligibility', 'eligible', 'ineligible', 'gate', 'principal',
    // Block taxonomy
    'trigger', 'condition', 'action', 'kind', 'group', 'output', 'capability',
    'capabilities', 'requirement', 'control', 'tone',
    // How a block presents itself: the manifest's own presentation members. These
    // are engine vocabulary because the *contract* names them — a block declares an
    // `icon` and a `placeholder`, and the interpreter carries them to the browser
    // without knowing what any particular one says.
    'icon', 'description', 'note', 'placeholder', 'swatches', 'prefix', 'suffix',
    'timeout',
    // Discord nouns the engine genuinely handles
    'guild', 'member', 'user', 'channel', 'role', 'message', 'embed', 'button',
    'reaction', 'emoji', 'interaction', 'client', 'event', 'permission',
    // Persistence nouns
    'repo', 'table', 'column', 'migration', 'row', 'entity', 'version', 'dialect',
];

/**
 * Words with no domain meaning in any codebase.
 *
 * Kept separate from {@link DOMAIN_VOCABULARY} so the domain list stays a readable
 * statement of what the engine is about. Adding here is cheap and uninteresting;
 * adding to the domain list is the deliberate act.
 */
const GENERIC_VOCABULARY = [
    // Arrived with the generalised context-requirement check: a table whose every
    // entry says when the thing is absent and what to advise. Neither carries
    // domain meaning in any codebase.
    //
    // **`rule` is deliberately NOT here**, and that is the gate doing its job. The
    // check was first written around a `REQUIREMENT_RULES` table, which would have
    // needed `rule` — but {@link fold} stems plurals, so recognising `rule` also
    // recognises `rules`, and `rules` is a proven rejection: it is an onboarding
    // noun ("agree to the rules"). Admitting it would have blinded this gate to
    // exactly the leak it exists to catch. The table was renamed to
    // `CHECKED_REQUIREMENTS` instead of widening the list.
    'absent', 'advice',
    // Arrived with copy rendering: a block declares that a field carries authored
    // copy, and the executor expands `{{…}}` in it before the block runs. Both are
    // generic in any codebase — a token is a lexical unit and rendering is turning
    // one representation into another — and neither names anything this product
    // does. `fold` stems them, so `tokens`, `renders` and `rendered` come too;
    // checked against PROVEN_REJECTIONS, which they do not touch.
    'token', 'tokens', 'render', 'renderable',
    // The rest of the copy-rendering and write-channel machinery. Every one is a
    // word about *mechanism* rather than about anything this product does: copy is
    // text, a seed is starting state, a resolver resolves, a drain empties, and
    // merged/size/expanded/describe are as domain-free as words get. Checked
    // against PROVEN_REJECTIONS — none of them folds onto a use-case noun, so the
    // gate keeps the no-slack property its own third test asserts.
    'copy', 'seed', 'resolver', 'drain', 'drained', 'merged', 'size', 'expanded',
    'describe',
    // Slice C's words, every one about mechanism rather than about anything this
    // product does. `cause` is the ES2022 `Error` option carrying why a lookup
    // failed. `equals`/`assert`/`true`/`agree` are the type-level equality check
    // holding the snapshot's interface and its Zod schema to one shape — a `type`
    // rather than a pair of assignments, because mutual assignability silently
    // misses an optional key on one side. `candidate`/`usable`/`fetched`/`report`
    // are the channel narrowing that now names what it rejected instead of
    // returning a bare undefined.
    //
    // Checked against PROVEN_REJECTIONS: `fold` only strips a suffix to reach a
    // recognised stem, so none of these can reach `onboarding`, `rules`,
    // `ticket`, `prompt` or the rest. The no-slack property still holds.
    'cause', 'equals', 'assert', 'true', 'agree',
    'candidate', 'usable', 'fetched', 'report',
    // The eligibility check's mechanism, as opposed to its vocabulary: a decision
    // is the answer, a refusal the negative one, `refuse` the act of giving it,
    // `evaluate` the act of deciding, `facts` what it decides over, and
    // `held`/`resolvable` the permission read. Domain-free in any codebase — the
    // *domain* words this check needed went into DOMAIN_VOCABULARY deliberately,
    // and these did not. `fold` stems `refusal`/`refuses` to `refuse`; none of
    // them reaches a proven rejection.
    'decision', 'refuse', 'refusal', 'evaluate', 'facts', 'held', 'resolvable',
    // `enforced` names which sources a dispatcher actually checks, and `declares`
    // is the verb the whole conformance file already runs on. Both mechanism.
    //
    // **`rule` is deliberately not here**, and that is this gate working twice
    // over. The conformance check was first written around a `declaresRule`
    // local, which would have needed it — but `fold` stems plurals, and `rules`
    // is a proven rejection. The local was renamed to `offersEligibility`,
    // exactly as the `REQUIREMENT_RULES` note above prescribes.
    'enforced', 'declares', 'offers',
    'result', 'parsed', 'default', 'update', 'current', 'definition', 'definitions',
    'next', 'declared', 'declaration', 'dependencies', 'error', 'errors', 'field',
    'fields', 'schema', 'type', 'reason', 'options', 'option', 'source', 'list',
    'start', 'started', 'starts', 'label', 'outgoing', 'reachable', 'named', 'names',
    'name', 'missing', 'validate', 'check', 'seen', 'data', 'satisfies', 'database',
    'create', 'input', 'saved', 'base', 'exec', 'execute', 'executor', 'segment',
    'completed', 'fail', 'failure', 'pending', 'here', 'onto', 'nothing', 'persist',
    'resolve', 'matching', 'matches', 'target', 'success', 'rebuild', 'rebuilt',
    'advance', 'scheduler', 'interval', 'running', 'startup', 'reclaim', 'reclaimed',
    'stop', 'reset', 'tests', 'from', 'queue', 'after', 'because', 'stack',
    'adjacency', 'walk', 'write', 'read', 'structural', 'authored', 'cycle', 'issue',
    'issues', 'partial', 'marker', 'count', 'transition', 'illegal', 'legal', 'patch',
    'lifecycle', 'query', 'find', 'filter', 'updated', 'value', 'values', 'wanted',
    'optional', 'prose', 'vocabulary', 'shape', 'keys', 'where', 'text', 'truncate',
    'choices', 'choice', 'rejected', 'length', 'without', 'terminates', 'accepts',
    'string', 'depth', 'inner', 'object', 'array', 'property', 'part', 'discoverable',
    'discover', 'discovered', 'entries', 'directories', 'directory', 'imported',
    'import', 'module', 'path', 'found', 'ensure', 'require', 'suspension', 'card',
    'summary', 'palette', 'join', 'reply', 'woke', 'stranded', 'gateway',
    'empty', 'hide', 'when', 'quote', 'root', 'complete', 'release', 'branch',
    'narrow', 'used', 'enabled', 'exit', 'configured', 'attempts',
    'allowed', 'detail', 'code', 'file', 'with', 'limit', 'content', 'ephemeral',
    'valid',
    // Step 3 slice A, where the resume reason stopped being one of two strings and
    // became a variant that can carry which option a person picked. `index` is the
    // position of that option; `driven` is the conformance guard that drives a
    // suspending block with one reason of each shape.
    //
    // Two words the slice first added here and then did not need, both worth
    // recording because each was a way of making this gate quieter rather than
    // more correct:
    //
    //  - `case` is not an identifier anywhere in this codebase. {@link codeOnly}
    //    blanks strings, so `case 'timeout':` reached {@link MEMBER} as `case  :`
    //    and read as a member declaration. Admitting it would have blinded the
    //    gate to every future real word containing "case"; the scanner was fixed
    //    instead.
    //  - `all` is three characters, so {@link MIN_WORD_LENGTH} discards it before
    //    the allowlist is ever consulted. It was added on the theory that renaming
    //    `everyResumeKindIsDriven` to `resumeKindsAllDriven` traded `every` for
    //    `all` — but nothing was traded, because `all` is never scanned. The
    //    rename still stands on its own; the reasoning written for it did not.
    //
    // Note what is NOT needed: `choice` and `choices` were already recognised,
    // which is the good sign — the engine had the word for "one of several offered
    // things" before this slice, and the new variant reuses it rather than teaching
    // the engine a new concept. The block that *offers* choices is another matter:
    // `prompt` is a proven rejection, so it cannot be named in the engine core, and
    // the prompt block correctly lives under `blocks/` where this gate does not
    // reach.
    //
    // Checked against PROVEN_REJECTIONS: `fold` only strips a suffix to reach a
    // recognised stem, and neither of these can reach one. No slack added.
    'index', 'driven',
    // Step 3 slice B1, the first config control whose value is a list. All three
    // describe *how a declaration is checked*, not what a flow is for:
    // `probe` is the technique `checkFieldMaxLength` already documents — parse a
    // constructed value at a boundary rather than read Zod's internals — and the
    // other two are what a list has. `entry` in particular is the singular the
    // engine has always needed alongside the `entries` it already recognised.
    'probe', 'entry', 'bounds',
    // Step 3 slice D, which lets a park name the message whose controls are
    // holding it so they can be disabled once it closes.
    //
    // `components` is discord.js's own key for the rows attached to a message —
    // `message.edit({ components })` — so it is API surface rather than anything
    // this product does. It is reported only because {@link MEMBER} is anchored on
    // `{` and cannot tell an object literal's key from a declared member, which
    // this file already names as the deliberate cheaper error.
    //
    // Note what this slice did NOT need, which is the good sign: `wait`, `message`,
    // `control`, `claim`, `park` and `release` were all already recognised, so the
    // park-scoped claim and the control release are stated entirely in words the
    // engine already had. Four identifiers were renamed rather than admitted here —
    // `retire`, `expected`, `ending` and `settle` — each replaced by an existing
    // word (`release`, `claimed`, `current`, and an inlined branch) rather than
    // widening the list. `stale`, the word the slice is *about*, is deliberately
    // still absent: it appears only in comments, where this gate does not reach and
    // should not.
    'components',
];

/**
 * Use-case nouns this gate exists to keep out, asserted against below.
 *
 * Not the check itself — the check is the allowlist, and these would fail it whether
 * or not they were listed here. They are here so the gate's own test can prove it
 * rejects what it was built to reject, and so a reader can see concretely what
 * "the engine learning a use case" means.
 */
const PROVEN_REJECTIONS = [
    'onboarding', 'journey', 'welcome', 'rules', 'verification',
    'ticket', 'audience', 'prompt', 'application',
];

const RECOGNISED = new Set([...DOMAIN_VOCABULARY, ...GENERIC_VOCABULARY]);

/**
 * Strip comments and string literals — see the file header for why.
 *
 * **One pass, not five.** Blanking comments before strings fails *open*, which a
 * review caught: in `const url = 'https://example.com';` the `//` inside the literal
 * is eaten as a line comment, orphaning the opening quote, which then pairs with the
 * next literal in the file and blanks every declaration in between. The word this
 * gate exists to reject can disappear from the scan entirely. A single alternation
 * cannot interleave, because whichever construct opens first consumes its own close.
 */
function codeOnly(source: string): string {
    return source.replace(
        /`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
        ' '
    );
}

const DECLARATION = /\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Members declared inside an interface, type literal, class or enum.
 *
 * Scanned as well as the bindings above, because `interface FlowRunContext {
 * onboardingStage: string }` is a use-case-shaped name for a type on any reading,
 * and the keyword-anchored pattern above sees only the name after `interface`.
 *
 * Anchored on `{`, `;`, `,` or a line start rather than on a line start alone: the
 * first draft used `^...$`-style anchoring and a re-run of the violation battery
 * caught it missing the single-line form `{ onboardingStage: string }`, which is the
 * form somebody adding one field actually writes.
 *
 * It deliberately does not try to parse object *literals*, whose keys are data
 * rather than declarations — in practice that means a handful of extra words on
 * {@link GENERIC_VOCABULARY}, which is the cheaper error.
 *
 * `case` and `default` are excluded because a switch arm is the one other thing in
 * TypeScript that puts a bare word before a colon. {@link codeOnly} blanks the
 * string first, so `case 'timeout':` arrives here as `case  :` and reads exactly
 * like a member declaration — which is how `case` came to be reported as an
 * identifier that appears nowhere in the codebase. Excluding the keywords fixes
 * the scanner; allowlisting `case` would instead have blinded this gate to every
 * future real identifier containing the word.
 */
const MEMBER =
    /(?:^|[{;,])\s*(?:readonly\s+)?(?!(?:case|default)\s*[:\s])([A-Za-z_][A-Za-z0-9_]*)\s*[?!]?\s*:/gm;

/**
 * Fold a plural or participle onto its allowlisted stem.
 *
 * `runs`, `parked` and `visited` are the same domain noun as `run`, `park` and
 * `visit`; requiring each inflection to be listed separately would triple the list
 * for no added precision.
 */
function fold(word: string): string {
    for (const suffix of ['ing', 'ed', 'es', 's']) {
        if (word.endsWith(suffix) && word.length > suffix.length + 2) {
            const stem = word.slice(0, -suffix.length);
            if (RECOGNISED.has(stem)) return stem;
            if (RECOGNISED.has(`${stem}e`)) return `${stem}e`;
        }
    }
    return word;
}

/** Words of fewer than four characters are too short to name a use case. */
const MIN_WORD_LENGTH = 4;

function wordsIn(identifier: string): string[] {
    return identifier
        .split(/(?=[A-Z])|_/)
        .map((word) => word.toLowerCase())
        .filter((word) => word.length >= MIN_WORD_LENGTH);
}

function gatedFiles(): string[] {
    const found: string[] = [];
    for (const { path, recursive } of GATED_PATHS) {
        if (!statSync(path).isDirectory()) {
            found.push(path);
            continue;
        }
        for (const entry of readdirSync(path)) {
            const full = join(path, entry);
            if (statSync(full).isDirectory()) {
                // `blocks/` is non-recursive: the contract files are gated, the
                // individual block directories are not.
                if (recursive && entry !== '__tests__') found.push(...collectTs(full));
                continue;
            }
            if (entry.endsWith('.ts')) found.push(full);
        }
    }
    return found;
}

function collectTs(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
        if (entry === '__tests__') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) found.push(...collectTs(full));
        else if (entry.endsWith('.ts')) found.push(full);
    }
    return found;
}

/** Every unrecognised word a file declares, as `word <- file` lines. */
function unrecognisedWords(files: readonly string[]): string[] {
    const offences: string[] = [];
    for (const file of files) {
        const code = codeOnly(readFileSync(file, 'utf8'));
        const reported = new Set<string>();
        const declared = [
            ...[...code.matchAll(DECLARATION)].map((match) => match[1]),
            ...[...code.matchAll(MEMBER)].map((match) => match[1]),
        ];
        for (const identifier of declared) {
            for (const raw of wordsIn(identifier)) {
                const word = fold(raw);
                if (RECOGNISED.has(word) || reported.has(word)) continue;
                reported.add(word);
                offences.push(`${relative(REPO_ROOT, file)} declares '${word}'`);
            }
        }
    }
    return offences.sort();
}

describe('the flow engine core names no use case', () => {
    it('gates the files it means to', () => {
        const files = gatedFiles().map((file) => relative(FLOWS_DIR, file));

        // The gate is only worth its failures if it is actually reading the engine.
        // A refactor that moved `executor.ts` would otherwise leave this passing
        // over a shrinking file set.
        expect(files).toContain(join('engine', 'executor.ts'));
        expect(files).toContain(join('data', 'flowGraph.ts'));
        expect(files).toContain(join('blocks', 'manifest.ts'));
        expect(files.length).toBeGreaterThan(15);

        // And it must not be reading the parts that are allowed a use case.
        expect(files.some((file) => file.startsWith('templates'))).toBe(false);
        expect(files.some((file) => file.startsWith(join('blocks', 'action')))).toBe(false);
        expect(files.some((file) => file.includes('__tests__'))).toBe(false);
    });

    it('declares no identifier outside the vocabulary', () => {
        expect(
            unrecognisedWords(gatedFiles()),
            'The flow engine is a general interpreter; it must not learn a use case. ' +
                'If this word names a genuine engine concept, add it to DOMAIN_VOCABULARY ' +
                'in this test and say why in review. If it names a product feature, the ' +
                'code belongs in a block or a template, not in the engine core.'
        ).toEqual([]);
    });

    it('rejects the use-case nouns it was built to reject', () => {
        // The gate's own test: proving the allowlist has no slack. Every one of these
        // is absent from both lists, so an engine file declaring one fails above.
        const wronglyAccepted = PROVEN_REJECTIONS.filter((word) => RECOGNISED.has(fold(word)));
        expect(
            wronglyAccepted,
            'A use-case noun has been added to the vocabulary, which makes this gate ' +
                'blind to exactly the kind of leak it exists to catch.'
        ).toEqual([]);
    });
});
