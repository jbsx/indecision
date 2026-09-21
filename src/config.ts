import { config as loadDotenv } from "dotenv";

/** Z.ai's OpenAI-compatible endpoint for GLM Coding Plan keys. Pay-as-you-go keys use `/api/paas/v4`. */
export const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const DEFAULT_ZAI_MODEL = "glm-5.3";

export interface Config {
  readonly zai: { readonly apiKey: string; readonly baseURL: string; readonly model: string };
  readonly typesafeApiKey: string;
}

export class ConfigError extends Error {}

/**
 * Reads both API keys from the process environment, with `.env` in the working directory as a
 * fallback. Fails before any network call when either is missing. `ZAI_BASE_URL` and `ZAI_MODEL`
 * optionally override the Advocate's endpoint and model.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadDotenv({ quiet: true, processEnv: env as Record<string, string> });

  const zaiApiKey = env["ZAI_API_KEY"]?.trim() ?? "";
  const typesafeApiKey = env["TYPESAFE_API_KEY"]?.trim() ?? "";
  const missing = [
    ...(zaiApiKey === "" ? ["ZAI_API_KEY"] : []),
    ...(typesafeApiKey === "" ? ["TYPESAFE_API_KEY"] : []),
  ];
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing ${missing.join(" and ")}. Set it in the environment or in a .env file in the working directory.`,
    );
  }
  return {
    zai: {
      apiKey: zaiApiKey,
      baseURL: env["ZAI_BASE_URL"]?.trim() || DEFAULT_ZAI_BASE_URL,
      model: env["ZAI_MODEL"]?.trim() || DEFAULT_ZAI_MODEL,
    },
    typesafeApiKey,
  };
}
