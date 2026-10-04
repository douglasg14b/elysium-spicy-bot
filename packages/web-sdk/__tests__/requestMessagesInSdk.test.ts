import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SDK_GENERATOR_CONFIG } from '../openapi-ts.config';

/**
 * The server's refusal sentences reach the committed SDK beside their rules.
 *
 * `generatedSdkIsCurrent.test.ts` holds `src/gen` to what the config makes of the spec, but
 * a config that quietly stops carrying sentences — a hey-api upgrade renaming the resolver
 * nodes `zodMessageResolvers.ts` replaces, say — regenerates an SDK that is "current" and
 * has none. This reads the committed output for them.
 */

const zodSource = readFileSync(join(SDK_GENERATOR_CONFIG.output.path, 'zod.gen.ts'), 'utf8');

/**
 * Every sentence the committed spec carries under `x-messages`, once per schema node that
 * carries it — a node's two bounds sharing one sentence can become a single `.length()`.
 */
function specSentences(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.flatMap(specSentences);
    }
    if (typeof value !== 'object' || value === null) {
        return [];
    }
    const entries: [string, unknown][] = Object.entries(value);
    return entries.flatMap(([key, entry]) =>
        key === 'x-messages' && typeof entry === 'object' && entry !== null
            ? [...new Set(Object.values(entry).filter((sentence): sentence is string => typeof sentence === 'string'))]
            : specSentences(entry)
    );
}

/** How often `sentence` appears in the generated source as a quoted message argument. */
function occurrencesInSdk(sentence: string): number {
    // The generator quotes with `'`, escaping any inside the sentence.
    return zodSource.split(`'${sentence.replaceAll("'", "\\'")}'`).length - 1;
}

describe('request messages in the SDK', () => {
    it('words the warnings channel rule with the server’s sentence', () => {
        // The sentence is `guildRoutes.ts`'s, on `WarningsConfigUpdate.modChannelId`.
        expect(zodSource).toContain("modChannelId: z.string().min(1, 'Pick a channel. Warning notices do not haunt the void.')");
    });

    /*
     * Counted, not just found: a sentence shared by a component and by a field the
     * resolvers fail to word (an inline nullable one, say) would otherwise be "present".
     */
    it('carries every sentence the committed spec holds, as often as the spec holds it', () => {
        const spec: unknown = JSON.parse(readFileSync(SDK_GENERATOR_CONFIG.input, 'utf8'));
        const expected = new Map<string, number>();
        for (const sentence of specSentences(spec)) {
            expected.set(sentence, (expected.get(sentence) ?? 0) + 1);
        }
        // A walk that found nothing would leave nothing missing and pass for no reason.
        expect(expected.size).toBeGreaterThan(0);

        const short = [...expected]
            .filter(([sentence, count]) => occurrencesInSdk(sentence) < count)
            .map(([sentence, count]) => `${sentence} (spec ${count}, zod.gen.ts ${occurrencesInSdk(sentence)})`);
        expect(short, 'Sentences zod.gen.ts carries fewer times than the spec does.').toEqual([]);
    });
});
