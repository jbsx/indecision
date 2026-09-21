/** Formatting shared by the shells. The pipeline never formats; only the CLI and the HTTP page do. */

/** One decimal, so a close call's gap stays visible instead of rounding to the same figure. */
export function percent(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

/** The message of whatever was thrown, for showing to the person. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
