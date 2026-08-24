// src/engine/narrator.ts
// Framework-agnostic narrator turn logic. No console/readline/HTTP here —
// this file should work identically called from a CLI, an HTTP handler,
// or a test.

import OpenAI from "openai";
import { SessionStore, StoredMessage } from "../memory/sessionStore";
import { env } from "../config/env";

const NARRATOR_SYSTEM_PROMPT = `You are the Narrator for a text-based fantasy
adventure. Describe the world vividly but concisely (2-4 sentences per turn).
Never break character. Never resolve dice rolls or combat yourself — that's
the Referee's job in a later phase; for now, narrate outcomes as if they
already happened.`;

export interface NarratorDeps {
    client: OpenAI;
    store: SessionStore;
    deployment: string;
}

export interface NarratorTurnResult {
    narratorText: string;
    isNewSession: boolean;
    messageCount: number;
}

export function createNarratorDeps(): NarratorDeps {
    return {
        client: new OpenAI({
            apiKey: env.AZURE_OPENAI_API_KEY,
            baseURL: env.AZURE_OPENAI_ENDPOINT,
        }),
        store: new SessionStore(env.REDIS_URL),
        deployment: env.AZURE_OPENAI_DEPLOYMENT,
    };
}

export async function getOrStartSession(deps: NarratorDeps, sessionId: string) {
    const session = await deps.store.getOrCreateSession(sessionId);
    return {
        isNewSession: session.messages.length === 0,
        lastNarratorLine: [...session.messages]
            .reverse()
            .find((m) => m.role === "assistant")?.content,
    };
}

export async function runNarratorTurn(
    deps: NarratorDeps,
    sessionId: string,
    playerInput: string
): Promise<NarratorTurnResult> {
    await deps.store.appendMessage(sessionId, {
        role: "user",
        content: playerInput,
    });

    const session = await deps.store.getSession(sessionId);
    const history = toResponsesInput(session!.messages);

    const response = await deps.client.responses.create({
        model: deps.deployment,
        instructions: NARRATOR_SYSTEM_PROMPT,
        input: history,
    });

    const narratorText = response.output_text;

    const updated = await deps.store.appendMessage(sessionId, {
        role: "assistant",
        content: narratorText,
    });

    return {
        narratorText,
        isNewSession: false,
        messageCount: updated.messages.length,
    };
}

function toResponsesInput(messages: StoredMessage[]) {
    return messages.map((m) => ({ role: m.role, content: m.content }));
}