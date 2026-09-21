#!/usr/bin/env node
import { zaiAdvocate } from "./advocate/zai.js";
import { runCli } from "./cli.js";
import { ConfigError, loadConfig } from "./config.js";
import { decide } from "./decide.js";
import { jevJudge } from "./judge/jev.js";
import { jsonlLog } from "./log/jsonl.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`indecision: ${error.message}\n`);
  process.exit(1);
}

const ports = {
  advocate: zaiAdvocate(config.zai),
  judge: jevJudge(config.typesafeApiKey),
  log: jsonlLog(),
};

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  decide: (dilemma) => decide(dilemma, ports),
});
