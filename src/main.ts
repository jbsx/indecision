#!/usr/bin/env node
import { zaiAdvocate } from "./advocate/zai.js";
import { runCli } from "./cli.js";
import { ConfigError, loadConfig } from "./config.js";
import { decide } from "./decide.js";
import { jevJudge } from "./judge/jev.js";
import { jsonlLog } from "./log/jsonl.js";
import { isServeCommand, readPort, startServer } from "./serve.js";

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

const argv = process.argv.slice(2);
const decideWithPorts = (dilemma: string) => decide(dilemma, ports);

if (isServeCommand(argv)) {
  if (argv.length > 1) {
    process.stderr.write("indecision: `serve` takes no arguments. Set PORT to pick the port.\n");
    process.exit(1);
  }
  let port;
  try {
    port = readPort(process.env);
  } catch (error) {
    process.stderr.write(`indecision: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  const server = await startServer({ port, decide: decideWithPorts });
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  process.stderr.write(`indecision: listening on http://0.0.0.0:${bound}\n`);
} else {
  process.exitCode = await runCli({
    argv,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    decide: decideWithPorts,
  });
}
