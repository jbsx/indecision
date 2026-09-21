import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Judge, JudgeAnswer, JudgeRequest } from "../ports.js";

export const JEV_MODEL = "jev-latest";

/**
 * The Judge, played by jev. Sends the request the pipeline built as one System One call and
 * passes the Choice answer through unchanged: argmax only, no sampling.
 */
export function jevJudge(apiKey: string): Judge {
  const client = new TypeSafeClient({ apiKey, defaultModel: JEV_MODEL });
  return {
    async judge(request: JudgeRequest): Promise<JudgeAnswer> {
      const { answers } = await client.systemOne({
        state: {
          dilemma: request.state.dilemma,
          options: request.state.options.map((o) => ({
            label: o.label,
            for: [...o.for],
            against: [...o.against],
          })),
        },
        questions: { verdict: { ...request.questions.verdict } },
      });
      const { choice, probabilities, confidence } = answers.verdict;
      return { pick: choice, probabilities, confidence };
    },
  };
}
