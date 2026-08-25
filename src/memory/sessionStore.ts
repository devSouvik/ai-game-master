// src/memory/sessionStore.ts
//
// This is the ONLY file in the app that talks to Redis directly. Every other
// file reads/writes session data through the methods below — never through
// `this.redis` itself (that field is `private`).
//
// IMPORTANT: this class holds NO game data in memory. The only state it
// keeps between calls is the Redis connection itself. Every method fetches
// the current session from Redis, works on a local copy, and saves it back.
// Redis is the single source of truth — this class is just the gatekeeper.

import Redis from "ioredis";

// Shape of one chat message as stored in a session's history.
export interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number; // when this message was created (epoch ms)
}

// Shape of an entire session, exactly as it's stored in Redis (as JSON).
export interface SessionState {
  sessionId: string;
  messages: StoredMessage[];
  inventory: string[];
  createdAt: number;
  updatedAt: number;
}

// How long an untouched session survives in Redis before auto-expiring.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export class SessionStore {
  // The only real state this class holds — the Redis connection itself.
  private redis: Redis;

  constructor (connectionString: string) {
    if (!connectionString) {
      throw new Error(
        "Redis connection string is required (set REDIS_URL in .env)"
      );
    }

    this.redis = new Redis(connectionString, {
      maxRetriesPerRequest: 3, // retry a single failed command up to 3 times
      retryStrategy(times) {
        // How long to wait before trying to RECONNECT if the connection drops.
        // Waits a bit longer each attempt, capped at 2 seconds.
        return Math.min(times * 200, 2000);
      },
    });

    this.redis.on("error", (err) => {
      console.error("[SessionStore] Redis connection error:", err.message);
    });
  }

  // Builds the Redis key for a session, e.g. "session:my-first-session".
  // Centralized here so the naming convention only lives in one place.
  private key(sessionId: string): string {
    return `session:${sessionId}`;
  }

  // Reads one session from Redis and parses it back into a JS object.
  // Returns null if the session doesn't exist yet.
  async getSession(sessionId: string): Promise<SessionState | null> {
    const raw = await this.redis.get(this.key(sessionId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionState;
    } catch (err) {
      // Malformed data shouldn't crash the app — just treat it as "no session".
      console.error(`[SessionStore] Corrupt session data for ${sessionId}`, err);
      return null;
    }
  }

  // Builds a brand-new, empty session object and saves it to Redis.
  // Only called when a sessionId has no existing data.
  async createSession(sessionId: string): Promise<SessionState> {
    const now = Date.now();
    const session: SessionState = {
      sessionId,
      messages: [],
      inventory: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.saveSession(session);
    return session;
  }

  // Convenience wrapper: fetch the session if it exists, otherwise create one.
  // Almost every other method calls this first, so callers never have to
  // check "does this session exist yet?" themselves.
  async getOrCreateSession(sessionId: string): Promise<SessionState> {
    const existing = await this.getSession(sessionId);
    return existing ?? (await this.createSession(sessionId));
  }

  // Adds one message (user or assistant) to a session's history and persists it.
  async appendMessage(
    sessionId: string,
    message: Omit<StoredMessage, "ts">
  ): Promise<SessionState> {
    const session = await this.getOrCreateSession(sessionId);
    session.messages.push({ ...message, ts: Date.now() });
    session.updatedAt = Date.now();
    await this.saveSession(session);
    return session;
  }

  // Just reads the current inventory list — no changes made.
  async getInventory(sessionId: string): Promise<string[]> {
    const session = await this.getOrCreateSession(sessionId);
    return session.inventory;
  }

  // Adds one item to the player's inventory and persists it.
  async addItem(sessionId: string, item: string): Promise<string[]> {
    const session = await this.getOrCreateSession(sessionId);
    session.inventory.push(item);
    session.updatedAt = Date.now();
    await this.saveSession(session);
    return session.inventory;
  }

  // Removes one item from the inventory (case-insensitive match) and persists it.
  // Returns whether the item was actually found and removed.
  async removeItem(
    sessionId: string,
    item: string
  ): Promise<{ inventory: string[]; removed: boolean; }> {
    const session = await this.getOrCreateSession(sessionId);
    const index = session.inventory.findIndex(
      (i) => i.toLowerCase() === item.toLowerCase()
    );
    const removed = index !== -1;
    if (removed) {
      session.inventory.splice(index, 1);
      session.updatedAt = Date.now();
      await this.saveSession(session);
    }
    return { inventory: session.inventory, removed };
  }

  // Shared "write this session to Redis" logic, used by every method above
  // that changes something. Private because callers should only ever say
  // WHAT to save (via the methods above), never call this directly.
  private async saveSession(session: SessionState): Promise<void> {
    await this.redis.set(
      this.key(session.sessionId),
      JSON.stringify(session),
      "EX",
      SESSION_TTL_SECONDS // reset the 30-day expiry on every save
    );
  }

  // Cleanly closes the Redis connection — call this once, when the app exits.
  async close(): Promise<void> {
    await this.redis.quit();
  }
}