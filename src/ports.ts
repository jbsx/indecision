import type { Dilemma, Option, Refusal, Verdict } from "./domain.js";

/** Extracts the Options from a Dilemma and argues each one. Never decides. */
export interface Advocate {
  argue(dilemma: Dilemma): Promise<Refusal | { refused: false; options: readonly Option[] }>;
}

/** One System One request carrying a single Choice question, as sent to jev. */
export interface JudgeRequest {
  readonly state: {
    readonly dilemma: Dilemma;
    readonly options: readonly {
      readonly label: string;
      readonly for: readonly string[];
      readonly against: readonly string[];
    }[];
  };
  readonly questions: {
    readonly verdict: {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, null>>;
    };
  };
}

/** The Choice answer: the pick with its probabilities and confidence, before the close-call flag. */
export type JudgeAnswer = Pick<Verdict, "pick" | "probabilities" | "confidence">;

/** Weighs the Cases and picks an Option. Played by jev and nothing else. */
export interface Judge {
  judge(request: JudgeRequest): Promise<JudgeAnswer>;
}

/** One record per successful run. */
export interface LogEntry {
  readonly dilemma: Dilemma;
  readonly options: readonly Option[];
  readonly verdict: Verdict;
  readonly timestamp: string;
}

export interface Log {
  append(entry: LogEntry): Promise<void>;
}
