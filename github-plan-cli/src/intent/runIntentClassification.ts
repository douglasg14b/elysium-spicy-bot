import { AgentInputItem, Runner } from "@openai/agents";
import { assertOpenAiApiKeyConfigured } from "../agent/agentEnv.js";
import { recordAgentTelemetryStep } from "../telemetry/recordAgentTelemetryStep.js";
import { isPlanCliDebugEnabled, planDebugLog, truncateForPlanDebug } from "../plan/planDebug.js";
import { AGENT_JARVIS_INTENT_CLASSIFIER } from "./agentIntentClassifier.js";
import { INTENT_CLASSIFICATION_SCHEMA } from "./intentClassificationSchema.js";

/**
 * Classify a single string (e.g. the issue_comment body that triggered the workflow).
 * Does not read GitHub state or write `GITHUB_OUTPUT` — callers handle that.
 */
export async function runIntentClassification(input: {
    text: string;
}): Promise<{ intent: string; runPlan: boolean }> {
    assertOpenAiApiKeyConfigured();

    planDebugLog("runIntentClassification", {
        textChars: input.text.length,
        textPreview: truncateForPlanDebug(input.text),
    });

    const startedAt = Date.now();
    const runner = new Runner({});
    const conversation: AgentInputItem[] = [
        { role: "user", content: [{ type: "input_text", text: input.text }] },
    ];
    const runResult = await runner.run(AGENT_JARVIS_INTENT_CLASSIFIER, conversation);
    const durationMs = Date.now() - startedAt;

    recordAgentTelemetryStep({
        name: "Intent classification (OpenAI Agents)",
        durationMs,
        usage: undefined,
    });

    if (runResult.finalOutput === undefined) {
        throw new Error("Intent classifier agent returned no output.");
    }

    const intentPayload = INTENT_CLASSIFICATION_SCHEMA.parse(runResult.finalOutput);
    const runPlan = intentPayload.intent === "plan" || intentPayload.intent === "plan_feedback";

    planDebugLog("runIntentClassification: done", {
        durationMs,
        intent: intentPayload.intent,
        runPlan,
    });
    if (isPlanCliDebugEnabled() && intentPayload.intent === "other") {
        planDebugLog("runIntentClassification: output preview (intent was other)", {
            contentPreview: truncateForPlanDebug(JSON.stringify(intentPayload), 6_000),
        });
    }

    return { intent: intentPayload.intent, runPlan };
}
