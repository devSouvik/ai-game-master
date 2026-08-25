// src/engine/narrator.ts
//
// The core game logic — no console, no readline, no HTTP. Given a session
// id and the player's text input, it talks to the model (with tools bound),
// updates memory, and returns the narrator's reply as plain text. Any future
// interface (CLI today, HTTP/WebSocket later) calls these same functions.

import { ChatOpenAI } from "@langchain/openai";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
  BaseMessage,
} from "@langchain/core/messages";
import { StructuredToolInterface } from "@langchain/core/tools";
import { SessionStore, StoredMessage } from "../memory/sessionStore";
import { rollDice, createInventoryTools } from "./tools";
import { env } from "../config/env";

// Instructions the model sees on every turn — its "character sheet" for
// how to behave as the Narrator.
const NARRATOR_SYSTEM_PROMPT = `You are the Narrator for a text-based fantasy
adventure. Describe the world vividly but concisely (2-4 sentences per turn).
Never break character. Use the roll_dice tool for any uncertain action —
never invent a dice result yourself. Use the inventory tools whenever the
player picks up, uses, or loses an item.`;

// Hard cap on how many times the tool-calling loop below can go around.
// This is a bounded-loop / harness safety net — without it, a model stuck
// repeatedly requesting tools could loop forever.
const MAX_TOOL_ITERATIONS = 4;

// Everything a narrator turn needs to run: one shared model client and one
// shared Redis connection, created once at startup and reused every turn.
export interface NarratorDeps {
  model: ChatOpenAI;
  store: SessionStore;
}

// Builds the shared dependencies. Called exactly ONCE, at app startup
// (from the CLI's main() function) — not on every turn.
export function createNarratorDeps(): NarratorDeps {
  const model = new ChatOpenAI({
    model: env.AZURE_OPENAI_DEPLOYMENT,
    apiKey: env.AZURE_OPENAI_API_KEY,
    configuration: {
      // Azure's newer OpenAI-compatible "v1" endpoint — plain ChatOpenAI
      // works directly against it (no separate Azure-specific client needed).
      baseURL: env.AZURE_OPENAI_ENDPOINT,
    },
    // NOTE: no `temperature` here — this deployment is a reasoning-style
    // model that only accepts the default value (1) and errors on anything else.
  });

  return {
    model,
    store: new SessionStore(env.REDIS_URL),
  };
}

// Used once at startup to greet the player: is this a brand-new session,
// or are we resuming one? Also returns the last narrator line for a recap.
export async function getOrStartSession(deps: NarratorDeps, sessionId: string) {
  const session = await deps.store.getOrCreateSession(sessionId);
  return {
    isNewSession: session.messages.length === 0,
    lastNarratorLine: [...session.messages]
      .reverse()
      .find((m) => m.role === "assistant")?.content,
  };
}

// The heart of the engine: takes one player message, returns the narrator's
// reply. Internally may call the model multiple times if it requests tools.
export async function runNarratorTurn(
  deps: NarratorDeps,
  sessionId: string,
  playerInput: string
): Promise<{ narratorText: string; }> {
  // 1. Save the player's message to Redis before doing anything else.
  await deps.store.appendMessage(sessionId, {
    role: "user",
    content: playerInput,
  });

  // 2. Re-fetch the full session so `history` includes the message we just saved.
  const session = await deps.store.getSession(sessionId);

  // 3. Build this turn's tool list: one stateless tool + three fresh
  // session-scoped inventory tools (rebuilt every turn — see the scale
  // note in the roadmap about caching this per-session later if needed).
  const tools: StructuredToolInterface[] = [
    rollDice,
    ...createInventoryTools(deps.store, sessionId),
  ];
  const modelWithTools = deps.model.bindTools(tools);

  // Lookup table so we can find the right tool by name once the model asks for one.
  const toolsByName: Record<string, StructuredToolInterface> = Object.fromEntries(
    tools.map((t) => [t.name, t])
  );

  // 4. Build the message list the model will see: system prompt + full
  // conversation history so far, converted into LangChain's message classes.
  let messages: BaseMessage[] = [
    new SystemMessage(NARRATOR_SYSTEM_PROMPT),
    ...toLangChainMessages(session!.messages),
  ];

  let finalText = "";

  // 5. THE TOOL-CALLING LOOP.
  // Call the model -> if it asked for tools, run them and feed results back
  // -> call the model again -> repeat until it answers with plain text
  // (or we hit MAX_TOOL_ITERATIONS).
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await modelWithTools.invoke(messages);

    if (!response.tool_calls?.length) {
      // Model is done reasoning and gave a normal reply — we're finished.
      finalText = response.text;
      break;
    }

    // Model wants one or more tools run. First, record its own request
    // in the conversation (it needs to "see" what it asked for).
    messages = [...messages, response];

    for (const toolCall of response.tool_calls) {
      const matchedTool = toolsByName[toolCall.name];
      const result = matchedTool
        ? await matchedTool.invoke(toolCall) // actually run the function from tools.ts
        : new ToolMessage({
          // Defensive fallback in case the model names a tool that doesn't exist.
          content: `Unknown tool: ${toolCall.name}`,
          tool_call_id: toolCall.id!,
        });
      messages = [...messages, result as ToolMessage];
    }

    if (i === MAX_TOOL_ITERATIONS - 1) {
      // Safety valve: on the last allowed loop, call the UNBOUND model
      // (no tools attached) so it CAN'T ask for another tool, forcing a
      // plain-text answer instead of running forever.
      const forced = await deps.model.invoke([
        ...messages,
        new HumanMessage("Please give your final narration now, without calling any more tools."),
      ]);
      finalText = forced.text;
    }
  }

  // 6. Save the narrator's final reply to Redis, same as we did for the player's message.
  await deps.store.appendMessage(sessionId, {
    role: "assistant",
    content: finalText,
  });

  return { narratorText: finalText };
}

// Converts our Redis-stored message shape into LangChain's message classes,
// which is what the model actually expects to receive.
function toLangChainMessages(messages: StoredMessage[]): BaseMessage[] {
  return messages.map((m) =>
    m.role === "user"
      ? new HumanMessage(m.content)
      : new AIMessage(m.content)
  );
}