#!/usr/bin/env node
import { zaiAdvocate } from "./advocate/zai.js";
import { runCli } from "./cli.js";
import { ConfigError, loadConfig } from "./config.js";
import { decide } from "./decide.js";
import { jevJudge } from "./judge/jev.js";
import { errorMessage } from "./format.js";
import { jsonlLog } from "./log/jsonl.js";
import { HOST, isServeCommand, readPort, startServer } from "./serve.js";

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
  try {
    const server = await startServer({
      port: readPort(process.env),
      decide: (dilemma, onStage) => decide(dilemma, { ...ports, onStage }),
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : "?";
    process.stderr.write(`indecision: listening on http://${HOST}:${port}\n`);
    server.on("error", (error) => process.stderr.write(`indecision: ${errorMessage(error)}\n`));
  } catch (error) {
    process.stderr.write(`indecision: ${errorMessage(error)}\n`);
    process.exit(1);
  }
} else {
  process.exitCode = await runCli({
    argv,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    decide: decideWithPorts,
  });
}
