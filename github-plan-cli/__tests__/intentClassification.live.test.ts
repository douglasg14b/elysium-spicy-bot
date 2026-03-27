import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runIntentClassification } from "../src/intent/runIntentClassification.js";

const ENABLE_FLAG = "RUN_OPENAI_INTENT_TESTS";
const SHOULD_RUN_LIVE_TESTS = isTruthy(process.env[ENABLE_FLAG]) && !isTruthy(process.env.CI);

if (SHOULD_RUN_LIVE_TESTS) {
    loadDotEnvLocalIntoProcessEnv();
}

const describeLive = SHOULD_RUN_LIVE_TESTS ? describe : describe.skip;

type LiveIntentCase = {
    name: string;
    comment: string;
    hasExistingPlan: boolean;
    expectedIntent: "plan" | "plan_feedback" | "implement" | "other";
};

const LIVE_INTENT_CASES: readonly LiveIntentCase[] = [
    {
        name: "new plan request",
        comment: "Jarvis, please create an implementation plan for this issue.",
        hasExistingPlan: false,
        expectedIntent: "plan",
    },
    {
        name: "plan feedback explicit revise",
        comment: "Jarvis, revise the current plan to include a migration rollback step.",
        hasExistingPlan: true,
        expectedIntent: "plan_feedback",
    },
    {
        name: "implement existing plan",
        comment: "Jarvis, go ahead and build this plan.",
        hasExistingPlan: true,
        expectedIntent: "implement",
    },
    {
        name: "gratitude no ask",
        comment: "Thanks Jarvis, appreciate it.",
        hasExistingPlan: true,
        expectedIntent: "other",
    },
    {
        name: "plan request with roadmap wording",
        comment: "Can you draft a technical roadmap and implementation steps for this?",
        hasExistingPlan: false,
        expectedIntent: "plan",
    },
    {
        name: "plan request with mention of Jarvis",
        comment: "@jarvis please plan this issue end to end.",
        hasExistingPlan: false,
        expectedIntent: "plan",
    },
    {
        name: "plan feedback fix section",
        comment: "Update section 4 of the plan to include test cases for error paths.",
        hasExistingPlan: true,
        expectedIntent: "plan_feedback",
    },
    {
        name: "plan feedback mermaid correction",
        comment: "The mermaid diagram in the plan is broken, fix it.",
        hasExistingPlan: true,
        expectedIntent: "plan_feedback",
    },
    {
        name: "implement explicit execute wording",
        comment: "Execute the plan and open a PR.",
        hasExistingPlan: true,
        expectedIntent: "implement",
    },
    {
        name: "implement without plan pronoun",
        comment: "Please implement this now.",
        hasExistingPlan: false,
        expectedIntent: "implement",
    },
    {
        name: "plan should win over implement when both mentioned but dominant ask is planning",
        comment: "Before coding, write a full implementation plan first.",
        hasExistingPlan: false,
        expectedIntent: "plan",
    },
    {
        name: "other for ambiguous short command",
        comment: "Jarvis do it.",
        hasExistingPlan: true,
        expectedIntent: "other",
    },
    {
        name: "other for empty-style acknowledgement",
        comment: "looks good",
        hasExistingPlan: true,
        expectedIntent: "other",
    },
    {
        name: "plan_feedback even if no existing plan when target is plan text",
        comment: "Change the plan wording to be shorter and remove emojis.",
        hasExistingPlan: false,
        expectedIntent: "plan_feedback",
    },
    {
        name: "plan for ask to think through approach",
        comment: "What is the best approach here? Please produce a concrete plan.",
        hasExistingPlan: false,
        expectedIntent: "plan",
    },
    {
        name: "implement from shipping language",
        comment: "Ship this change now.",
        hasExistingPlan: false,
        expectedIntent: "implement",
    },
];

describeLive("intent classification live (OpenAI)", () => {
    it(
        "returns stable expected intents across repeated calls",
        async () => {
        const repeatCount = parseRepeatCount(process.env.RUN_OPENAI_INTENT_TESTS_REPEAT);

            const batchSize = parseBatchSize(process.env.RUN_OPENAI_INTENT_TESTS_BATCH_SIZE);
            for (const testCase of LIVE_INTENT_CASES) {
                const observedIntents: string[] = [];
                for (let runIndex = 0; runIndex < repeatCount; runIndex += 1) {
                    const batchResults = await runIntentCaseBatch(testCase, batchSize);
                    for (const batchResult of batchResults) {
                        expect(batchResult.intent, `${testCase.name} [run ${runIndex}]`).toBe(
                            testCase.expectedIntent,
                        );
                        observedIntents.push(batchResult.intent);
                    }
                }

                const distinctIntents = new Set(observedIntents);
                expect(distinctIntents.size, `${testCase.name} should be consistent`).toBe(1);
        }
        },
        120_000,
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

function parseBatchSize(rawValue: string | undefined): number {
    const fallback = 3;
    if (!rawValue) {
        return fallback;
    }

    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }

    return parsed;
}

async function runIntentCaseBatch(testCase: LiveIntentCase, batchSize: number): Promise<{ intent: string }[]> {
    const calls = Array.from({ length: batchSize }, async () =>
        runIntentClassification({
            text: testCase.comment,
            hasExistingPlan: testCase.hasExistingPlan,
            discussionKind: "issue",
        }),
    );
    return Promise.all(calls);
}

function isTruthy(value: string | undefined): boolean {
    if (!value) {
        return false;
    }

    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function loadDotEnvLocalIntoProcessEnv(): void {
    const envPath = resolve(process.cwd(), ".env.local");
    if (!existsSync(envPath)) {
        return;
    }

    const content = readFileSync(envPath, "utf8");
    const lines = content.split(/\r?\n/u);
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine === "" || trimmedLine.startsWith("#")) {
            continue;
        }

        const equalsIndex = trimmedLine.indexOf("=");
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
