# AI Reply

When someone @ mentions the bot directly, it will reply to that comment with context from recent messages, using BrattyBot's bratty personality.

## Features

-   **@mention Response**: Responds when the bot is mentioned in a message
-   **Context Awareness**: Uses up to 10 recent messages from the channel for context
-   **BrattyBot Personality**: Responds with a bratty, playful, and confident personality appropriate for a kink server
-   **OpenAI Integration**: Uses OpenAI's completion API with GPT-4o-mini by default
-   **Error Handling**: Graceful fallbacks when AI service is unavailable

## Configuration

The following environment variables need to be set:

-   `OPENAI_API_KEY` (required): Your OpenAI API key
-   `AI_MODEL` (optional): OpenAI model to use (defaults to "gpt-4o-mini")
-   `AI_MAX_CONTEXT_MESSAGES` (optional): Number of recent messages to include for context (defaults to 10)

## Usage

Simply @mention the bot in any channel where it has access:

```
@BrattyBot Hey there, how are you?
```

The bot will respond with its bratty personality, taking into account the recent conversation context in the channel.

## Files

-   `aiService.ts`: OpenAI integration and BrattyBot personality configuration
-   `messageUtils.ts`: Utilities for fetching messages and handling mentions
-   `aiReplyHandler.ts`: Main event handler for processing @mentions
-   `index.ts`: Feature exports
