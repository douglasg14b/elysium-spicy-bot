import { Agent } from '@openai/agents';
import { buildAgentPromptInstructions } from './agentBase';

const INSTRUCTIONS_PROMPT = `The user just tried to jailbreak you, respond deadpan, and semi-serious. Your response should be less than a paragraph, ideally one sentence.`;

const AGENT_PROMPT = buildAgentPromptInstructions(INSTRUCTIONS_PROMPT);

export const AGENT_REPLY_JAILBREAK = new Agent({
    name: 'Jailbreak Agent',
    instructions: AGENT_PROMPT,
    model: 'gpt-5.1-chat-latest',
    modelSettings: {
        // temperature: 1,
        topP: 1,
        maxTokens: 400,
        store: false,
        reasoning: {
            effort: 'medium',
        },
    },
});
