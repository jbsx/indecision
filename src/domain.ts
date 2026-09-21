/** The user's own words describing the choice, exactly as written. */
export type Dilemma = string;

/** The argument for and against one Option, with the same number of points on each side. */
export interface Case {
  readonly for: readonly string[];
  readonly against: readonly string[];
}

/** One alternative the user stated (or the implied refusal of a lone alternative). */
export interface Option {
  readonly label: string;
  readonly case: Case;
}

/** The Judge's pick, a probability for every Option, and a confidence in the pick. */
export interface Verdict {
  readonly pick: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  /** True when the top two probabilities are nearly even. Still a Verdict. */
  readonly closeCall: boolean;
}

/** The Advocate declined to argue because the Dilemma names no Options. */
export interface Refusal {
  readonly refused: true;
  readonly reason: string;
}

/** What `decide` returns: a Verdict with the Cases it was reached on, or a Refusal. */
export type Outcome =
  | Refusal
  | { readonly refused: false; readonly verdict: Verdict; readonly options: readonly Option[] };
