import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aiService } from '../../ai-reply/aiService';

const ENABLE_FLAG = 'RUN_OPENAI_BIRTHDAY_TESTS';
const SHOULD_RUN_LIVE_TESTS = isTruthy(process.env[ENABLE_FLAG]) && !isTruthy(process.env.CI);

if (SHOULD_RUN_LIVE_TESTS) {
    loadDotEnvLocalIntoProcessEnv();
}

const describeLive = SHOULD_RUN_LIVE_TESTS ? describe : describe.skip;

type BirthdayPromptCase = {
    label: string;
    displayName: string;
    username: string;
};

const LIVE_BIRTHDAY_CASES: readonly BirthdayPromptCase[] = [
    { label: 'simple name', displayName: 'Avery', username: 'avery_irl' },
    { label: 'emoji display name', displayName: 'Luna 🔥', username: 'luna_afterdark' },
    { label: 'long display name', displayName: 'Captain Consensual Chaos', username: 'captain_chaos' },
    { label: 'mixed punctuation', displayName: 'Rae [mod-ish vibes]', username: 'rae.mod' },
    { label: 'minimal style', displayName: 'J', username: 'j_online' },
];

describeLive('birthday announcement live output (OpenAI)', () => {
    it(
        'prints generated birthday announcement samples for manual review',
        async () => {
            const repeatCount = parseRepeatCount(process.env.RUN_OPENAI_BIRTHDAY_TESTS_REPEAT);

            for (const birthdayCase of LIVE_BIRTHDAY_CASES) {
                console.log('\n============================================================');
                console.log(`[birthday-live] Case: ${birthdayCase.label}`);
                console.log(`[birthday-live] Input: displayName="${birthdayCase.displayName}", username="${birthdayCase.username}"`);

                for (let runIndex = 1; runIndex <= repeatCount; runIndex += 1) {
                    const generatedMessage = await aiService.generateBirthdayAnnouncement({
                        displayName: birthdayCase.displayName,
                        username: birthdayCase.username,
                    });

                    console.log(`[birthday-live] Output ${runIndex}/${repeatCount}:`);
                    console.log(generatedMessage);
                    console.log('------------------------------------------------------------');

                    expect(generatedMessage.trim().length).toBeGreaterThan(0);
                }
            }
        },
        120_000
    );
});

function parseRepeatCount(rawValue: string | undefined): number {
    const fallback = 2;
    if (!rawValue) {
        return fallback;
    }

    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }

    return parsed;
}

function isTruthy(value: string | undefined): boolean {
    if (!value) {
        return false;
    }

    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function loadDotEnvLocalIntoProcessEnv(): void {
    const envPath = resolve(process.cwd(), '.env.local');
    if (!existsSync(envPath)) {
        return;
    }

    const content = readFileSync(envPath, 'utf8');
    const lines = content.split(/\r?\n/u);
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine === '' || trimmedLine.startsWith('#')) {
            continue;
        }

        const equalsIndex = trimmedLine.indexOf('=');
        if (equalsIndex <= 0) {
            continue;
        }

        const key = trimmedLine.slice(0, equalsIndex).trim();
        if (!key || process.env[key] != null) {
            continue;
        }

        const rawValue = trimmedLine.slice(equalsIndex + 1).trim();
        const unquotedValue =
            (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
            (rawValue.startsWith("'") && rawValue.endsWith("'"))
                ? rawValue.slice(1, -1)
                : rawValue;

        process.env[key] = unquotedValue;
    }
}
