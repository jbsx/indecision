import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Judge, JudgeRequest, UnflaggedVerdict } from "../ports.js";

export const JEV_MODEL = "jev-latest";

/**
 * The Judge, played by jev. Sends the request the pipeline built as one System One call, untouched,
 * and passes the Choice answer through unchanged: argmax only, no sampling.
 */
export function jevJudge(apiKey: string): Judge {
  const client = new TypeSafeClient({ apiKey, defaultModel: JEV_MODEL });
  return {
    async judge(request: JudgeRequest): Promise<UnflaggedVerdict> {
      const { answers } = await client.systemOne(request);
      const { choice, probabilities, confidence } = answers.verdict;
      return { pick: choice, probabilities, confidence };
    },
  };
}
