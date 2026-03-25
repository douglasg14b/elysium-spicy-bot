import { z } from "zod";
import { DETECTOR_INTENT_VALUES } from "../config/githubPlanConstants.js";

export const INTENT_CLASSIFICATION_SCHEMA = z.object({
    intent: z.enum(DETECTOR_INTENT_VALUES),
    confidence: z.number().min(0).max(1),
    reason: z.string().max(200),
});

export const INTENT_CLASSIFICATION_JSON_SCHEMA = INTENT_CLASSIFICATION_SCHEMA.toJSONSchema();
export type IntentClassification = z.infer<typeof INTENT_CLASSIFICATION_SCHEMA>;
