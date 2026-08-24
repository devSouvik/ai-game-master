// src/interfaces/cli/index.ts
// This is the ONLY file allowed to touch stdin/stdout. It calls the engine
// and handles presentation — nothing else. When the frontend arrives, this
// file gets a sibling (interfaces/api/index.ts) that calls the same engine
// functions; this file itself won't need to change.

import dotenv from "dotenv";

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
    createNarratorDeps,
    getOrStartSession,
    runNarratorTurn,
} from "../../engine/narrator";

dotenv.config({ override: true });

async function main() {
    const sessionId = process.argv[2] ?? "default-session";
    const deps = createNarratorDeps();

    const { isNewSession, lastNarratorLine } = await getOrStartSession(
        deps,
        sessionId
    );

    console.log(
        isNewSession
            ? `Starting new session "${sessionId}".`
            : `Resuming session "${sessionId}".`
    );
    if (lastNarratorLine) {
        console.log(`\n[Recap] ${lastNarratorLine}\n`);
    }

    const rl = readline.createInterface({ input, output });

    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const playerInput = await rl.question("> ");
            if (playerInput.trim().toLowerCase() === "/quit") break;

            const { narratorText } = await runNarratorTurn(
                deps,
                sessionId,
                playerInput
            );
            console.log(`\n${narratorText}\n`);
        }
    } finally {
        rl.close();
        await deps.store.close();
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});