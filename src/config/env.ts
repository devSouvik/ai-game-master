// src/config/env.ts
// Single source of truth for required environment variables. Fails fast at
// startup with a clear message instead of letting `undefined` propagate into
// SDK calls and surface as a confusing error later.


import dotenv from "dotenv";
dotenv.config({ override: true });

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `Missing required environment variable: ${name}. Check your .env file.`
        );
    }
    return value;
}

export const env = {
    AZURE_OPENAI_API_KEY: required("AZURE_OPENAI_API_KEY"),
    AZURE_OPENAI_ENDPOINT: required("AZURE_OPENAI_ENDPOINT"),
    AZURE_OPENAI_DEPLOYMENT: required("AZURE_OPENAI_DEPLOYMENT"),
    REDIS_URL: required("REDIS_URL"),
};