// src/config/env.ts
// Phase 2 update: adds AZURE_OPENAI_API_VERSION, required by AzureChatOpenAI
// (the raw OpenAI SDK client in Phase 1 didn't need it against the v1 endpoint;
// LangChain's Azure wrapper does).

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