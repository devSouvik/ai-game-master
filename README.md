# AI Game Master

A command-line, text-based fantasy adventure powered by LangChain, Azure OpenAI, and Redis-backed session memory.

The narrator stays in character, remembers prior turns in a named session, rolls dice for uncertain actions, and maintains a per-session inventory.

## Features

- Interactive CLI with resumable named sessions
- Azure OpenAI chat model through LangChain's `ChatOpenAI`
- Model-initiated tool calls for dice rolls and inventory updates
- Redis persistence with a 30-day sliding session expiry
- A bounded tool loop to prevent a runaway sequence of model tool calls
- Strict TypeScript compilation

## Architecture

```text
CLI (stdin/stdout)
        |
        v
Narrator engine
  |             |
  v             v
LangChain     Redis session store
ChatOpenAI    (messages and inventory)
  |
  v
Azure OpenAI v1 endpoint
```

The CLI is deliberately thin: it creates the dependencies once, prompts for input, and renders the narrator response. The engine owns the game prompt and tool-calling loop. `SessionStore` is the only module that accesses Redis, which keeps the engine reusable from a future HTTP or WebSocket interface.

## Prerequisites

- Node.js 20 or later
- An Azure OpenAI deployment available through its OpenAI-compatible **v1** endpoint
- A Redis instance (use `rediss://` when your provider requires TLS)

## Setup

Install dependencies:

```bash
npm install
```

Create a `.env` file in the repository root using `env.example` as the template:

```env
AZURE_OPENAI_ENDPOINT=https://YOUR_RESOURCE.services.ai.azure.com/openai/v1
AZURE_OPENAI_API_KEY=your-azure-openai-api-key
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
REDIS_URL=rediss://default:password@host:port
```

`AZURE_OPENAI_ENDPOINT` must be the full v1 base URL, ending in `/openai/v1`. The current implementation passes this value to `ChatOpenAI` as `configuration.baseURL`; it does not use the legacy Azure API-version configuration.

Keep `.env` private. It is ignored by Git and must never contain credentials committed to the repository.

## Run the game

Start a new session, or resume a session with the same ID:

```bash
npm run dev -- my-adventure
```

Without an argument, the CLI uses `default-session`:

```bash
npm run dev
```

Enter actions at the prompt, for example:

```text
> I search the ruined tower for a hidden door.
> I take the silver key.
> /quit
```

Type `/quit` to close the CLI and Redis connection cleanly.

## Build and run compiled output

```bash
npm run build
npm start -- my-adventure
```

## How a turn works

1. The player input is appended to the Redis session.
2. The engine rebuilds the conversation from the stored messages and adds the narrator system prompt.
3. LangChain invokes the Azure-hosted model with the available tools bound to it.
4. If the model requests a tool, the engine executes it and returns its result as a tool message.
5. The loop repeats until the model produces narration, or reaches the four-iteration safety limit.
6. The final narration is saved to Redis for the next turn.

This is an explicit LangChain tool-execution loop. LangChain's current documentation describes this pattern: `bindTools()` lets a model request application tools, while the application executes the requests and supplies results for the next model invocation. See the [LangChain tool-calling guide](https://docs.langchain.com/oss/javascript/langchain/models#tool-calling).

## Available tools

| Tool | Purpose |
|---|---|
| `roll_dice` | Rolls one or more dice and returns individual rolls plus their total. |
| `add_item_to_inventory` | Adds an item to the current session inventory. |
| `remove_item_from_inventory` | Removes a case-insensitive item match from the current session inventory. |
| `list_inventory` | Returns the current session inventory. |

The model requests tools; it does not directly execute Redis operations or generate dice results.

## Project structure

```text
src/
  config/env.ts              Environment loading and required-value validation
  engine/narrator.ts         Narrator prompt, model setup, and tool loop
  engine/tools.ts            Dice and session-scoped inventory tools
  memory/sessionStore.ts     Redis persistence and session lifecycle
  interfaces/cli/index.ts    Command-line application entry point
```

## Session data

Each Redis key is namespaced as `session:<sessionId>` and stores:

- conversation messages with timestamps;
- the player inventory;
- creation and update timestamps.

Every write renews the key expiry to 30 days. A missing or expired session is created automatically when it is first used.

## Development notes

- The model client and Redis connection are created once at application startup and reused for the entire CLI run.
- The engine sends complete stored conversation history on each turn. Long-running sessions will eventually need a history window or summarization strategy.
- The current Redis persistence model is appropriate for the single-process CLI. Before serving concurrent requests for the same session, introduce atomic updates or optimistic locking to avoid lost writes.
- There are no automated tests yet. `npm run build` is the current validation command.

## Further reading

- [LangChain JavaScript tool calling](https://docs.langchain.com/oss/javascript/langchain/models#tool-calling)
- [LangChain Azure OpenAI integration](https://docs.langchain.com/oss/javascript/integrations/chat/azure)
