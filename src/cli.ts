import type { Readable, Writable } from "node:stream";
import type { Dilemma, Option, Outcome, Verdict } from "./domain.js";

export interface CliIo {
  readonly argv: readonly string[];
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly decide: (dilemma: Dilemma) => Promise<Outcome>;
}

/** Thin shell over `decide`: Dilemma in from argument or stdin, text out, exit code back. */
export async function runCli(io: CliIo): Promise<number> {
  const dilemma = await resolveDilemma(io);
  if (dilemma === "") {
    io.stderr.write("No Dilemma given. Pass it as an argument or on stdin.\n");
    return 1;
  }

  let outcome: Outcome;
  try {
    outcome = await io.decide(dilemma);
  } catch (error) {
    io.stderr.write(`indecision: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (outcome.refused) {
    io.stderr.write(`Can't decide this one: ${outcome.reason}\n`);
    return 1;
  }

  io.stdout.write(renderVerdict(outcome.verdict, outcome.options));
  io.stdout.write("\n");
  io.stdout.write(renderCases(outcome.options));
  return 0;
}

async function resolveDilemma(io: CliIo): Promise<Dilemma> {
  if (io.argv.length > 0) return io.argv.join(" ").trim();
  let text = "";
  for await (const chunk of io.stdin) text += String(chunk);
  return text.trim();
}

function renderVerdict(verdict: Verdict, options: readonly Option[]): string {
  const width = Math.max(...options.map((o) => o.label.length));
  const lines = [`Verdict: ${verdict.pick}`];
  for (const option of options) {
    const probability = verdict.probabilities[option.label] ?? 0;
    lines.push(`  ${option.label.padEnd(width)}  ${percent(probability)}`);
  }
  lines.push(`Confidence: ${verdict.confidence.toFixed(2)}`);
  if (verdict.closeCall) lines.push("Close call: the Cases were nearly balanced.");
  return lines.join("\n") + "\n";
}

function renderCases(options: readonly Option[]): string {
  const blocks = options.map((option) =>
    [
      option.label,
      "  For:",
      ...option.case.for.map((point) => `    - ${point}`),
      "  Against:",
      ...option.case.against.map((point) => `    - ${point}`),
    ].join("\n"),
  );
  return "Cases\n" + blocks.join("\n\n") + "\n";
}

function percent(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}
