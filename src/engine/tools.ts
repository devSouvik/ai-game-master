// src/engine/tools.ts
//
// Defines every tool the Narrator agent can call. A "tool" here is just a
// function wrapped with LangChain's `tool()` helper, plus a description and
// a schema that tell the MODEL when to call it and what arguments to pass.
// The model never runs these itself — it only ever asks your code to.

import { tool } from "langchain";
import { z } from "zod";
import { SessionStore } from "../memory/sessionStore";

// STATELESS TOOL — doesn't touch Redis or any session. Pure function: given
// some numbers, returns a random result. Exported as a ready-to-use tool
// (not a factory) because it needs no per-session setup.
export const rollDice = tool(
  async ({ sides, count }: { sides?: number; count?: number; }) => {
    const numSides = sides ?? 20;
    const numDice = count ?? 1;
    const rolls = Array.from(
      { length: numDice },
      () => Math.floor(Math.random() * numSides) + 1
    );
    const total = rolls.reduce((a, b) => a + b, 0);
    // Tool results are always returned as text — JSON-stringifying lets the
    // model parse structure back out of the string.
    return JSON.stringify({ rolls, total });
  },
  {
    name: "roll_dice",
    // This description is read by the MODEL, not by you — it's how the
    // model decides WHEN to call this tool.
    description:
      "Roll one or more dice. Use this for any action with an uncertain " +
      "outcome — attacks, skill checks, saving throws. Never invent a " +
      "result yourself; always call this tool.",
    // The schema is the model's only way of knowing what arguments this
    // tool accepts. Each .describe() explains one argument to the model.
    schema: z.object({
      sides: z
        .number()
        .optional()
        .describe("Number of sides on the die (default 20, i.e. a d20)"),
      count: z
        .number()
        .optional()
        .describe("How many dice to roll (default 1)"),
    }),
  }
);

// FACTORY FUNCTION — this is NOT a tool itself. Calling it BUILDS three
// stateful tools, each closed over one specific session's store + id. The
// model never sees sessionId; it's captured here in the closure, invisible
// to the model's schema.
export function createInventoryTools(store: SessionStore, sessionId: string) {
  const addItem = tool(
    async ({ item }: { item: string; }) => {
      const inventory = await store.addItem(sessionId, item);
      return `Added "${item}". Current inventory: ${inventory.join(", ") || "(empty)"}`;
    },
    {
      name: "add_item_to_inventory",
      description: "Add an item to the player's inventory (e.g. after picking something up).",
      schema: z.object({
        item: z.string().describe("Name of the item to add"),
      }),
    }
  );

  const removeItem = tool(
    async ({ item }: { item: string; }) => {
      const { inventory, removed } = await store.removeItem(sessionId, item);
      return removed
        ? `Removed "${item}". Current inventory: ${inventory.join(", ") || "(empty)"}`
        : `"${item}" was not found in inventory. Current inventory: ${inventory.join(", ") || "(empty)"}`;
    },
    {
      name: "remove_item_from_inventory",
      description: "Remove an item from the player's inventory (e.g. after using or losing it).",
      schema: z.object({
        item: z.string().describe("Name of the item to remove"),
      }),
    }
  );

  const listInventory = tool(
    async () => {
      const inventory = await store.getInventory(sessionId);
      return inventory.length ? inventory.join(", ") : "(empty)";
    },
    {
      name: "list_inventory",
      description: "List the player's current inventory items.",
      schema: z.object({}), // no arguments needed
    }
  );

  // Returned as a flat array — callers use `...createInventoryTools(...)`
  // to spread these three into a single combined tools list alongside rollDice.
  return [addItem, removeItem, listInventory];
}