// src/interfaces/cli/index.ts
//
// The ONLY file allowed to touch stdin/stdout. It knows nothing about
// Redis, LangChain, tools, or the model — it just gets text from the
// terminal, hands it to the engine, and prints whatever comes back.
// When a frontend arrives, a sibling file (interfaces/api/index.ts) will
// call the same engine functions — this file itself won't need to change.

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
    // Session id comes from the command line, e.g. `npm run dev -- my-session`.
    // Falls back to a default if none is given.
    const sessionId = process.argv[2] ?? "default-session";

    // Built ONCE for the whole run of the app — one model client, one Redis
    // connection, reused for every turn instead of recreated each time.
    const deps = createNarratorDeps();

    // Just for the greeting message — also triggers session creation in
    // Redis if this sessionId is brand new.
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
        // The game loop: read one line of player input, pass it to the engine,
        // print the reply, repeat — until the player types /quit.
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
        // Runs even if something above throws — prevents a broken terminal
        // state or a dangling Redis connection.
        rl.close();
        await deps.store.close();
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});