// sessionStore.ts
// Phase 1 — Redis-backed session memory for the AI Game Master narrator.
// Scale note: one JSON blob per session key. Fine for single-user, single-session
// play. Revisit (streams, TTL sharding, etc.) only if sessions grow large or
// concurrent multi-user access is introduced.

import Redis from "ioredis";

export interface StoredMessage {
    role: "user" | "assistant" | "system";
    content: string;
    ts: number; // epoch ms
}

export interface SessionState {
    sessionId: string;
    messages: StoredMessage[];
    createdAt: number;
    updatedAt: number;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — adjust as needed

export class SessionStore {
    private redis: Redis;

    constructor (connectionString: string) {
        if (!connectionString) {
            throw new Error(
                "Redis connection string is required (set REDIS_URL in .env)"
            );
        }
        // ioredis parses rediss://... (TLS) and redis://... connection strings directly.
        this.redis = new Redis(connectionString, {
            maxRetriesPerRequest: 3,
            retryStrategy(times) {
                // Basic backoff — enough for a solo dev app. A production multi-tenant
                // service would want circuit-breaking and alerting here instead.
                return Math.min(times * 200, 2000);
            },
        });

        this.redis.on("error", (err) => {
            console.error("[SessionStore] Redis connection error:", err.message);
        });
    }

    private key(sessionId: string): string {
        return `session:${sessionId}`;
    }

    async getSession(sessionId: string): Promise<SessionState | null> {
        const raw = await this.redis.get(this.key(sessionId));
        if (!raw) return null;
        try {
            return JSON.parse(raw) as SessionState;
        } catch (err) {
            console.error(`[SessionStore] Corrupt session data for ${sessionId}`, err);
            return null;
        }
    }

    async createSession(sessionId: string): Promise<SessionState> {
        const now = Date.now();
        const session: SessionState = {
            sessionId,
            messages: [],
            createdAt: now,
            updatedAt: now,
        };
        await this.saveSession(session);
        return session;
    }

    async getOrCreateSession(sessionId: string): Promise<SessionState> {
        const existing = await this.getSession(sessionId);
        return existing ?? (await this.createSession(sessionId));
    }

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

    private async saveSession(session: SessionState): Promise<void> {
        await this.redis.set(
            this.key(session.sessionId),
            JSON.stringify(session),
            "EX",
            SESSION_TTL_SECONDS
        );
    }

    async close(): Promise<void> {
        await this.redis.quit();
    }
}