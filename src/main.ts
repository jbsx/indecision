#!/usr/bin/env node
import { anthropicAdvocate } from "./advocate/anthropic.js";
import { runCli } from "./cli.js";
import { ConfigError, loadKeys } from "./config.js";
import { decide } from "./decide.js";
import { jevJudge } from "./judge/jev.js";
import { jsonlLog } from "./log/jsonl.js";

let keys;
try {
  keys = loadKeys();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`indecision: ${error.message}\n`);
  process.exit(1);
}

const ports = {
  advocate: anthropicAdvocate(keys.anthropicApiKey),
  judge: jevJudge(keys.typesafeApiKey),
  log: jsonlLog(),
};

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  decide: (dilemma) => decide(dilemma, ports),
});
