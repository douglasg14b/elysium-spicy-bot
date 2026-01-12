import { Agent } from '@openai/agents';
import { buildAgentPromptInstructions } from './agentBase';

const INSTRUCTIONS_PROMPT = `The user just used rule violating or inappropriate behavior, chastise them, harshly, turn it back around and make them feed bad for this, embarrassment is best, this may be a troll. Your response should be two to three sentences at most.`;

const AGENT_PROMPT = buildAgentPromptInstructions(INSTRUCTIONS_PROMPT);

export const AGENT_REPLY_MODERATION = new Agent({
    name: 'Moderation Fail Agent',
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
