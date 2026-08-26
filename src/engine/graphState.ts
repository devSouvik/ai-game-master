// src/engine/graphState.ts

// The routing signal the classifier writes, and every conditional edge reads.
// Fill in: what are ALL the possible values nextStep could be? Think about
// every node in your 6-node design, plus how you'd signal "we're done, stop looping".
type NextStep = {};

// One NPC's tracked relationship progress.
// Fill in: what TWO pieces of info does this actually need to hold?
// (Hint: re-read the relationship-stage design from a few messages back.)
interface NpcRelationship {
    // ???
}

// Fill in: which NPC(s) are currently "in the room" with the player —
// this is what gates who the classifier is even allowed to route to.
interface ActiveScene {
    // ???
}

// The full shared state that flows through every node in the graph.
interface GraphState {
    sessionId: string;
    messages: /* ??? — reuse or extend something you already built in Phase 1/2 */;
    inventory: string[]; // carried over as-is from SessionState
    npcRelationships: /* ??? — use NpcRelationship somehow, keyed by NPC id */;
    activeScene: ActiveScene;
    nextStep: NextStep;
}