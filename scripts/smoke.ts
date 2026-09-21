/**
 * Manual smoke run against the real Advocate and the real Judge. Not part of the unit suite.
 *
 *   pnpm smoke                       # uses the sample Dilemma below
 *   pnpm smoke "pizza or sushi?"     # your own Dilemma
 *
 * Prints the jev request the pipeline built, then the Outcome. Nothing is logged.
 */
import { anthropicAdvocate } from "../src/advocate/anthropic.js";
import { loadKeys } from "../src/config.js";
import { decide } from "../src/decide.js";
import { jevJudge } from "../src/judge/jev.js";
import type { Judge, Log } from "../src/ports.js";

const SAMPLE_DILEMMA =
  "It's Friday night. I could go to my friend's birthday drinks, which I said I'd probably make, or stay in and finish the side project I've been putting off for weeks. I'm tired either way.";

const dilemma = process.argv.slice(2).join(" ").trim() || SAMPLE_DILEMMA;
const keys = loadKeys();

const jev = jevJudge(keys.typesafeApiKey);
const judge: Judge = {
  async judge(request) {
    console.log("--- jev request ---");
    console.log(JSON.stringify(request, null, 2));
    return jev.judge(request);
  },
};
const log: Log = { append: async () => {} };

console.log("--- Dilemma ---");
console.log(dilemma);
const outcome = await decide(dilemma, {
  advocate: anthropicAdvocate(keys.anthropicApiKey),
  judge,
  log,
});
console.log("--- Outcome ---");
console.log(JSON.stringify(outcome, null, 2));
