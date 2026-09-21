import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import type { Outcome } from "./domain.js";

const outcome: Outcome = {
  refused: false,
  options: [
    { label: "Go to the gym", case: { for: ["Sleep better"], against: ["Rain"] } },
    { label: "Rest at home", case: { for: ["Recovery day"], against: ["Guilt"] } },
  ],
  verdict: {
    pick: "Go to the gym",
    probabilities: { "Go to the gym": 0.8, "Rest at home": 0.2 },
    confidence: 0.9,
    closeCall: false,
  },
};

function sink(): Writable & { text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return Object.assign(stream, { text: () => chunks.join("") });
}

function run(argv: string[], stdin: string, decide = async (_: string) => outcome) {
  const stdout = sink();
  const stderr = sink();
  const exitCode = runCli({
    argv,
    stdin: Readable.from([stdin]),
    stdout,
    stderr,
    decide,
  });
  return exitCode.then((code) => ({ code, stdout: stdout.text(), stderr: stderr.text() }));
}

describe("indecision CLI", () => {
  it("takes the Dilemma as one argument and prints the Verdict before the Cases", async () => {
    const seen: string[] = [];
    const { code, stdout } = await run(["gym or rest?"], "", async (dilemma) => {
      seen.push(dilemma);
      return outcome;
    });

    expect(code).toBe(0);
    expect(seen).toEqual(["gym or rest?"]);
    const verdictAt = stdout.indexOf("Go to the gym");
    const casesAt = stdout.indexOf("Sleep better");
    expect(verdictAt).toBeGreaterThanOrEqual(0);
    expect(casesAt).toBeGreaterThan(verdictAt);
    expect(stdout).toContain("80.0%");
    expect(stdout).toContain("20.0%");
    expect(stdout).toContain("0.90");
  });

  it("reads a multi-line Dilemma from stdin when no argument is given", async () => {
    const seen: string[] = [];
    const { code, stdout } = await run([], "gym\nor rest?\n", async (dilemma) => {
      seen.push(dilemma);
      return outcome;
    });

    expect(code).toBe(0);
    expect(seen).toEqual(["gym\nor rest?"]);
    expect(stdout.indexOf("Verdict: Go to the gym")).toBeLessThan(stdout.indexOf("Cases"));
  });

  it("prints a Refusal to stderr and exits 1", async () => {
    const { code, stdout, stderr } = await run(["I feel stuck"], "", async () => ({
      refused: true,
      reason: "No Options are named.",
    }));

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("No Options are named.");
  });
});
