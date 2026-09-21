import type { Dilemma, Option, Outcome, Verdict } from "./domain.js";
import type { Advocate, Judge, JudgeRequest, Log } from "./ports.js";

/** The two waits in a run: the Advocate arguing the Cases, then the Judge weighing them. */
export type Stage = "advocate" | "judge";

export interface Ports {
  readonly advocate: Advocate;
  readonly judge: Judge;
  readonly log: Log;
  /** Clock for the log timestamp. Defaults to the wall clock. */
  readonly now?: () => Date;
  /** Told which role is about to be asked, just before it is. A shell can show where the time goes. */
  readonly onStage?: (stage: Stage) => void;
}

const JUDGE_INSTRUCTIONS = "Which Option should this person take?";

/** A Verdict whose top two probabilities are closer than this is a close call. */
const CLOSE_CALL_THRESHOLD = 0.1;

/** Takes a Dilemma and returns a Verdict or a Refusal. The Judge alone decides. */
export async function decide(dilemma: Dilemma, ports: Ports): Promise<Outcome> {
  ports.onStage?.("advocate");
  const argued = await ports.advocate.argue(dilemma);
  if (argued.refused) return argued;

  const options = withRefusalCounterpart(argued.options);
  ports.onStage?.("judge");
  const answer = await ports.judge.judge(judgeRequest(dilemma, options));
  const verdict: Verdict = { ...answer, closeCall: isCloseCall(answer.probabilities) };

  const timestamp = (ports.now ?? (() => new Date()))().toISOString();
  await ports.log.append({ dilemma, options, verdict, timestamp });

  return { refused: false, options, verdict };
}

function isCloseCall(probabilities: Readonly<Record<string, number>>): boolean {
  const [top = 0, runnerUp = 0] = Object.values(probabilities).sort((a, b) => b - a);
  return top - runnerUp < CLOSE_CALL_THRESHOLD;
}

/**
 * A Dilemma naming a single Option implies its refusal as the second. The counterpart's Case is
 * the original's mirrored, so both sides keep the same points and the same effort.
 */
function withRefusalCounterpart(options: readonly Option[]): readonly Option[] {
  const [only] = options;
  if (options.length !== 1 || only === undefined) return options;
  return [
    only,
    {
      label: `Don't ${lowerFirst(only.label)}`,
      case: { for: only.case.against, against: only.case.for },
    },
  ];
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function judgeRequest(dilemma: Dilemma, options: readonly Option[]): JudgeRequest {
  return {
    state: {
      dilemma,
      options: options.map((o) => ({
        label: o.label,
        for: [...o.case.for],
        against: [...o.case.against],
      })),
    },
    questions: {
      verdict: {
        type: "choice",
        instructions: JUDGE_INSTRUCTIONS,
        criteria: Object.fromEntries(options.map((o) => [o.label, null])),
      },
    },
  };
}
