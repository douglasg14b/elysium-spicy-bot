import { createOpenRouter, type LanguageModelV4 } from '@openrouter/ai-sdk-provider';
import { OPENROUTER_API_KEY, OPENROUTER_BASE_URL } from '../environment';

const openrouter = createOpenRouter({ apiKey: OPENROUTER_API_KEY, baseURL: OPENROUTER_BASE_URL });

/** A chat model on OpenRouter, by its slug (`mistralai/mistral-large-4-0`). Every model the bot calls goes through here. */
export function openRouterModel(modelId: string): LanguageModelV4 {
    return openrouter.chat(modelId);
}
