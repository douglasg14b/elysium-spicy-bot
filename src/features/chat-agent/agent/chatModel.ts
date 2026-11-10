import { createOpenRouter, type LanguageModelV4 } from '@openrouter/ai-sdk-provider';
import { CHAT_AGENT_MODEL, OPENROUTER_API_KEY, OPENROUTER_BASE_URL } from '../../../environment';

const openrouter = createOpenRouter({ apiKey: OPENROUTER_API_KEY, baseURL: OPENROUTER_BASE_URL });

/** The chat agent's model on OpenRouter: `modelId` (an OpenRouter slug), else `CHAT_AGENT_MODEL`. */
export function chatModel(modelId: string = CHAT_AGENT_MODEL): LanguageModelV4 {
    return openrouter.chat(modelId);
}
