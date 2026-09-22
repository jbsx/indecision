import type { Dilemma, Option, Refusal, Verdict } from "./domain.js";

/** Extracts the Options from a Dilemma and argues each one. Never decides. */
export interface Advocate {
  argue(dilemma: Dilemma): Promise<Refusal | { refused: false; options: readonly Option[] }>;
}

/**
 * One System One request carrying a single Choice question, exactly as sent to jev. Plain JSON
 * so the adapter can pass it through untouched.
 */
export interface JudgeRequest {
  state: {
    dilemma: Dilemma;
    options: { label: string; for: string[]; against: string[] }[];
  };
  questions: {
    verdict: { type: "choice"; instructions: string; criteria: Record<string, null> };
  };
}

/** The Choice answer: the pick with its probabilities and confidence, before the close-call flag. */
export type UnflaggedVerdict = Pick<Verdict, "pick" | "probabilities" | "confidence">;

/** Weighs the Cases and picks an Option. Played by jev and nothing else. */
export interface Judge {
  judge(request: JudgeRequest): Promise<UnflaggedVerdict>;
}

/** One record per run that reached a Verdict. */
export interface VerdictEntry {
  readonly refused: false;
  readonly dilemma: Dilemma;
  readonly options: readonly Option[];
  readonly verdict: Verdict;
  readonly timestamp: string;
}

/** One record per Refusal, so an over-strict Advocate leaves evidence. */
export interface RefusalEntry {
  readonly refused: true;
  readonly dilemma: Dilemma;
  readonly reason: string;
  readonly timestamp: string;
}

/** One record per run, whether it reached a Verdict or was refused. */
export type LogEntry = VerdictEntry | RefusalEntry;

export interface Log {
  append(entry: LogEntry): Promise<void>;
}
