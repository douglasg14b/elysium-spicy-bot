# AI Reply

When someone @ mentions the bot directly, it will reply to that comment with context from recent messages, using BrattyBot's bratty personality.

## Features

-   **@mention Response**: Responds when the bot is mentioned in a message
-   **Context Awareness**: Uses up to 10 recent messages from the channel for context
-   **BrattyBot Personality**: Responds with a bratty, playful, and confident personality appropriate for a kink server
-   **OpenRouter Integration**: Reply generation (chat completions and the `@openai/agents` graph) is routed through OpenRouter over the Chat Completions API
-   **Error Handling**: Graceful fallbacks when AI service is unavailable

## Configuration

The following environment variables need to be set:

-   `OPENROUTER_API_KEY` (required): Your OpenRouter API key — used for all reply generation
-   `OPENROUTER_BASE_URL` (optional): OpenRouter base URL (defaults to "https://openrouter.ai/api/v1")
-   `OPENAI_API_KEY` (required): OpenAI API key — used only by `@openai/guardrails` (Moderation/Jailbreak/PII), which is not proxied by OpenRouter
-   `AI_MODEL` (optional): OpenRouter model slug to use (defaults to "openai/gpt-5.1-chat-latest")
-   `AI_MAX_CONTEXT_MESSAGES` (optional): Number of recent messages to include for context (defaults to 10)

## Usage

Simply @mention the bot in any channel where it has access:

```
@BrattyBot Hey there, how are you?
```

The bot will respond with its bratty personality, taking into account the recent conversation context in the channel.

## Files

-   `aiService.ts`: OpenRouter/OpenAI client wiring (Agents SDK default, guardrails client) and BrattyBot personality configuration
-   `messageUtils.ts`: Utilities for fetching messages and handling mentions
-   `aiReplyHandler.ts`: Main event handler for processing @mentions
-   `index.ts`: Feature exports
