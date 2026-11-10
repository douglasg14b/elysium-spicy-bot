import type { LanguageModelV4 } from '@openrouter/ai-sdk-provider';
import { CHAT_AGENT_MODEL } from '../../../environment';
import { openRouterModel } from '../../../shared/openRouterModel';

/** The chat agent's model on OpenRouter: `modelId` (an OpenRouter slug), else `CHAT_AGENT_MODEL`. */
export function chatModel(modelId: string = CHAT_AGENT_MODEL): LanguageModelV4 {
    return openRouterModel(modelId);
}
