/**
 * Parse stdout from the Jarvis `agent` CLI when `--output-format json` wraps intent JSON.
 */
export function parseIntentFromAgentJson(raw: string): { intent: string; runPlan: boolean } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        return { intent: "other", runPlan: false };
    }
    if (typeof parsed !== "object" || parsed === null) {
        return { intent: "other", runPlan: false };
    }
    const obj = parsed as Record<string, unknown>;
    let resultStr: string | undefined;
    if (typeof obj.result === "string") {
        resultStr = obj.result;
    }
    let inner: unknown = resultStr ?? parsed;
    let peelGuard = 0;
    while (typeof inner === "string" && peelGuard < 4) {
        try {
            inner = JSON.parse(inner) as unknown;
        } catch {
            return { intent: "other", runPlan: false };
        }
        peelGuard += 1;
    }
    if (typeof inner !== "object" || inner === null) {
        return { intent: "other", runPlan: false };
    }
    const intentRaw = (inner as Record<string, unknown>).intent;
    let intent = typeof intentRaw === "string" ? intentRaw : "other";
    if (!["plan", "plan_feedback", "implement", "other"].includes(intent)) {
        intent = "other";
    }
    return { intent, runPlan: intent === "plan" };
}
