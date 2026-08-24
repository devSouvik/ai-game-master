## File overview

| File | Role |
|---|---|
| `src/config/env.ts` | Validates required env vars exist at startup, fails fast with a clear error |
| `src/memory/sessionStore.ts` | All Redis reads/writes — the only file that knows Redis exists |
| `src/engine/narrator.ts` | The actual "game logic" — takes player input, talks to the model, updates memory. Framework/I/O agnostic |
| `src/interfaces/cli/index.ts` | Terminal input/output loop — the only file that knows this is a CLI app |

The dependency direction matters: `cli/index.ts` → `narrator.ts` → `sessionStore.ts` + Azure SDK. Nothing points backward. `sessionStore.ts` doesn't know `narrator.ts` exists; `narrator.ts` doesn't know `cli/index.ts` exists. That's what lets you swap the CLI for an HTTP API later without touching the other two files.

---

## `env.ts`

```ts
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}...`);
  }
  return value;
}
```
A small helper: reads one env var, throws immediately if it's missing/empty. This is what turned your earlier blank `AZURE_OPENAI_BASE_URL=` into an immediate, readable error instead of a cryptic `undefined` failure three function calls deep.

```ts
export const env = {
  AZURE_OPENAI_API_KEY: required("AZURE_OPENAI_API_KEY"),
  ...
};
```
This object is built **once, at import time** — the moment any other file does `import { env } from "./config/env"`, all four `required()` calls run immediately. That's the "fail fast at startup" behavior: if anything's missing, your app won't even reach the game loop.

---

## `sessionStore.ts`

```ts
export interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
}
```
TypeScript types — no runtime code, just a contract. `role` is a **union type**: it can *only* be one of those three strings, not any string. This is TypeScript catching typos like `"asistant"` at compile time instead of at 2am in a Redis dump.

```ts
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
```
30 days in seconds. Redis will auto-delete a session key if it's untouched that long — this is a housekeeping decision, not a game-design one.

```ts
export class SessionStore {
  private redis: Redis;

  constructor(connectionString: string) {
```
A class wrapping one Redis client. `private` means `redis` can't be accessed from outside this class — callers only get the methods below (`getSession`, `appendMessage`, etc.), never the raw client. This is **encapsulation**: it means later, if you swap Redis for something else, only this file changes.

```ts
    this.redis = new Redis(connectionString, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        return Math.min(times * 200, 2000);
      },
    });
```
`maxRetriesPerRequest: 3` — if a single command (like `GET`) fails, ioredis retries it 3 times before giving up. `retryStrategy` controls *reconnection* attempts (the whole connection dropping): each retry waits longer, capped at 2 seconds, so it doesn't hammer Redis Cloud if it's briefly unreachable.

```ts
  private key(sessionId: string): string {
    return `session:${sessionId}`;
  }
```
Every session is stored under a key like `session:my-first-session`. The `session:` prefix is a Redis convention — lets you namespace different kinds of data in the same Redis instance later (e.g. `npc:aldric:memory`) without collisions.

```ts
  async getSession(sessionId: string): Promise<SessionState | null> {
    const raw = await this.redis.get(this.key(sessionId));
    if (!raw) return null;
```
Redis stores strings only — `raw` is either the JSON string you saved, or `null` if the key doesn't exist. `!raw` catches both `null` and empty string.

```ts
    try {
      return JSON.parse(raw) as SessionState;
    } catch (err) {
      console.error(`[SessionStore] Corrupt session data for ${sessionId}`, err);
      return null;
    }
```
`JSON.parse` can throw if the stored data is somehow malformed. Wrapping it means a corrupt entry degrades to "treat as if no session exists" instead of crashing your whole app.

```ts
  async getOrCreateSession(sessionId: string): Promise<SessionState> {
    const existing = await this.getSession(sessionId);
    return existing ?? (await this.createSession(sessionId));
  }
```
`??` is the **nullish coalescing operator** — "use the left side unless it's `null`/`undefined`, then use the right side." So: try to fetch, and only create a new one if nothing was found.

```ts
  async appendMessage(sessionId, message) {
    const session = await this.getOrCreateSession(sessionId);
    session.messages.push({ ...message, ts: Date.now() });
```
`{ ...message, ts: Date.now() }` — the **spread operator** copies all fields from `message` (`role`, `content`) into a new object, then adds `ts`. This is why the function signature type is `Omit<StoredMessage, "ts">` — callers pass everything *except* the timestamp; this function stamps it.

```ts
  private async saveSession(session: SessionState): Promise<void> {
    await this.redis.set(
      this.key(session.sessionId),
      JSON.stringify(session),
      "EX",
      SESSION_TTL_SECONDS
    );
  }
```
`"EX", SESSION_TTL_SECONDS` is Redis's `SET key value EX seconds` syntax — set the value *and* an expiry in one atomic command, so there's no window where the key exists without a TTL.

---

## `narrator.ts`

```ts
export interface NarratorDeps {
  client: OpenAI;
  store: SessionStore;
  deployment: string;
}
```
This is **dependency injection**: instead of `runNarratorTurn` reaching out and creating its own OpenAI client or SessionStore internally, they're passed in as arguments. Why this matters: it's what makes this file testable later (you can pass in a fake/mock `client` in a test) and reusable (a future HTTP handler builds `deps` once and reuses it across requests, instead of reconnecting to Redis on every call).

```ts
export async function getOrStartSession(deps: NarratorDeps, sessionId: string) {
  const session = await deps.store.getOrCreateSession(sessionId);
  return {
    isNewSession: session.messages.length === 0,
    lastNarratorLine: [...session.messages]
      .reverse()
      .find((m) => m.role === "assistant")?.content,
  };
}
```
`[...session.messages].reverse()` — copies the array first (spread), *then* reverses the copy. Reversing in place (`session.messages.reverse()`) would mutate the actual session data, which you don't want just to find the last line. `.find(...)` then walks from the end looking for the most recent assistant message. `?.content` is **optional chaining** — if `.find()` returns `undefined` (no assistant message yet), this whole expression short-circuits to `undefined` instead of throwing.

```ts
export async function runNarratorTurn(deps, sessionId, playerInput) {
  await deps.store.appendMessage(sessionId, { role: "user", content: playerInput });

  const session = await deps.store.getSession(sessionId);
  const history = toResponsesInput(session!.messages);
```
Save the player's message first, *then* re-fetch the full session (so `history` includes the message you just saved). `session!` — the `!` is a **non-null assertion**, telling TypeScript "trust me, this won't be null" (it won't, since we just wrote to that key). Slightly unsafe in general, but fine here since we control the write immediately above.

```ts
  const response = await deps.client.responses.create({
    model: deps.deployment,
    instructions: NARRATOR_SYSTEM_PROMPT,
    input: history,
  });
```
The actual model call — full conversation history sent every turn (no server-side conversation state on Azure's end here). This is why Redis matters: *you* are the one maintaining continuity, not the API.

```ts
  const narratorText = response.output_text;

  const updated = await deps.store.appendMessage(sessionId, {
    role: "assistant",
    content: narratorText,
  });
```
Save the model's reply back to the session, so next turn's `history` includes it too.

```ts
function toResponsesInput(messages: StoredMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}
```
Strips out the `ts` field, since the Responses API doesn't expect it — this is a small "adapter" between your storage shape and the API's expected shape. Small function, but worth noticing: it's the seam you'd change if you ever store richer metadata per message than the API needs.

---

## `interfaces/cli/index.ts`

```ts
const sessionId = process.argv[2] ?? "default-session";
```
`process.argv` is `[node path, script path, ...your args]` — so `argv[2]` is the first argument *you* passed (`my-first-session`). Falls back to `"default-session"` if you don't pass one.

```ts
const rl = readline.createInterface({ input, output });
```
Node's built-in prompt/readline — this is the only reason this file exists separately from `narrator.ts`. It's terminal-specific plumbing.

```ts
try {
  while (true) {
    const playerInput = await rl.question("> ");
    if (playerInput.trim().toLowerCase() === "/quit") break;

    const { narratorText } = await runNarratorTurn(deps, sessionId, playerInput);
    console.log(`\n${narratorText}\n`);
  }
} finally {
  rl.close();
  await deps.store.close();
}
```
The game loop. `finally` guarantees `rl.close()` and Redis disconnect happen even if something throws mid-loop — without it, a crash could leave the terminal in a broken input state or leak the Redis connection.
