import { Agent } from "@openai/agents";
import { readPromptFile } from "../prompts/loadPrompt.js";
import { INTENT_CLASSIFICATION_SCHEMA } from "./intentClassificationSchema.js";

/** Model for `classify intent` (fixed; not read from env). */
export const JARVIS_INTENT_CLASSIFIER_MODEL = "gpt-5.2-mini";

export const AGENT_JARVIS_INTENT_CLASSIFIER = new Agent({
    name: "Jarvis intent classification",
    instructions: readPromptFile("intent-agent.md"),
    model: JARVIS_INTENT_CLASSIFIER_MODEL,
    outputType: INTENT_CLASSIFICATION_SCHEMA,
    modelSettings: {
        reasoning: {
            effort: "low",
        },
        store: false,
    },
});
