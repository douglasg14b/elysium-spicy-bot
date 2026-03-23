import {
    type DetectorIntent,
    isDetectorIntent,
} from "./githubPlanConstants.js";

/** Payload shape after we confirm `intent` is a known detector value. */
export type DetectorIntentPayload = { intent: DetectorIntent } & Record<string, unknown>;

function stripOptionalMarkdownJsonFence(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith("```")) {
        return trimmed;
    }
    const firstLineBreak = trimmed.indexOf("\n");
    if (firstLineBreak === -1) {
        return trimmed;
    }
    const inner = trimmed.slice(firstLineBreak + 1);
    const closingFence = inner.lastIndexOf("```");
    if (closingFence === -1) {
        return trimmed;
    }
    return inner.slice(0, closingFence).trim();
}

function tryParseIntentPayload(blob: string): DetectorIntentPayload | null {
    try {
        const obj = JSON.parse(blob) as unknown;
        if (typeof obj !== "object" || obj === null) {
            return null;
        }
        const rec = obj as Record<string, unknown>;
        const intent = rec.intent;
        if (typeof intent === "string" && isDetectorIntent(intent)) {
            return rec as DetectorIntentPayload;
        }
    } catch {
        /* invalid JSON */
    }
    return null;
}

/**
 * Parse JSON the intent agent wrote to `.jarvis/intent-result.json` (optional ``` fence stripped).
 */
export function parseIntentFromResultFileContents(raw: string): { intent: string; runPlan: boolean } | null {
    const stripped = stripOptionalMarkdownJsonFence(raw.trim());
    if (stripped === "") {
        return null;
    }
    const payload = tryParseIntentPayload(stripped);
    if (payload === null) {
        return null;
    }
    return { intent: payload.intent, runPlan: payload.intent === "plan" };
}
