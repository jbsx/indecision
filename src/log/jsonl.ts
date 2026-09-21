import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import envPaths from "env-paths";
import type { Log, LogEntry } from "../ports.js";

/** `indecision/log.jsonl` under the user's data directory (XDG on Linux). */
export function defaultLogPath(): string {
  return path.join(envPaths("indecision", { suffix: "" }).data, "log.jsonl");
}

/** Appends one JSON line per run, creating the directory on first use. */
export function jsonlLog(filePath: string = defaultLogPath()): Log {
  return {
    async append(entry: LogEntry): Promise<void> {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
    },
  };
}
