import { config as loadDotenv } from "dotenv";

export interface Keys {
  readonly anthropicApiKey: string;
  readonly typesafeApiKey: string;
}

export class ConfigError extends Error {}

/**
 * Reads both API keys from the process environment, with `.env` in the working directory as a
 * fallback. Fails before any network call when either is missing.
 */
export function loadKeys(env: NodeJS.ProcessEnv = process.env): Keys {
  loadDotenv({ quiet: true, processEnv: env as Record<string, string> });

  const anthropicApiKey = env["ANTHROPIC_API_KEY"]?.trim() ?? "";
  const typesafeApiKey = env["TYPESAFE_API_KEY"]?.trim() ?? "";
  const missing = [
    ...(anthropicApiKey === "" ? ["ANTHROPIC_API_KEY"] : []),
    ...(typesafeApiKey === "" ? ["TYPESAFE_API_KEY"] : []),
  ];
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing ${missing.join(" and ")}. Set it in the environment or in a .env file in the working directory.`,
    );
  }
  return { anthropicApiKey, typesafeApiKey };
}
