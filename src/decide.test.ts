import { describe, expect, it } from "vitest";
import { decide } from "./decide.js";
import type { Option } from "./domain.js";
import type { Advocate, Judge, JudgeAnswer, JudgeRequest, Log, LogEntry } from "./ports.js";

const gym: Option = {
  label: "Go to the gym",
  case: { for: ["Sleep better", "Keeps the streak"], against: ["Rain", "Tired"] },
};
const rest: Option = {
  label: "Rest at home",
  case: { for: ["Recovery day", "Finish the book"], against: ["Guilt", "Restless"] },
};

function scriptedAdvocate(options: readonly Option[]): Advocate {
  return { argue: async () => ({ refused: false, options }) };
}

function recordingJudge(answer: JudgeAnswer): Judge & { requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    judge: async (request) => {
      requests.push(request);
      return answer;
    },
  };
}

function recordingLog(): Log & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    append: async (entry) => {
      entries.push(entry);
    },
  };
}

const peaked: JudgeAnswer = {
  pick: "Go to the gym",
  probabilities: { "Go to the gym": 0.8, "Rest at home": 0.2 },
  confidence: 0.9,
};

describe("decide", () => {
  it("sends the Judge the Dilemma verbatim, every Case, and bare Option labels as criteria", async () => {
    const dilemma = "Should I  go to the gym\nor rest at home?";
    const judge = recordingJudge(peaked);

    await decide(dilemma, { advocate: scriptedAdvocate([gym, rest]), judge, log: recordingLog() });

    expect(judge.requests).toEqual([
      {
        state: {
          dilemma,
          options: [
            { label: "Go to the gym", for: gym.case.for, against: gym.case.against },
            { label: "Rest at home", for: rest.case.for, against: rest.case.against },
          ],
        },
        questions: {
          verdict: {
            type: "choice",
            instructions: "Which Option should this person take?",
            criteria: { "Go to the gym": null, "Rest at home": null },
          },
        },
      },
    ]);
  });

  it("gives a lone Option its refusal as the second Option, with the Case mirrored", async () => {
    const judge = recordingJudge({
      pick: "Go to the gym",
      probabilities: { "Go to the gym": 0.7, "Don't go to the gym": 0.3 },
      confidence: 0.8,
    });

    await decide("should I go to the gym", {
      advocate: scriptedAdvocate([gym]),
      judge,
      log: recordingLog(),
    });

    expect(judge.requests[0]?.state.options).toEqual([
      { label: "Go to the gym", for: gym.case.for, against: gym.case.against },
      { label: "Don't go to the gym", for: gym.case.against, against: gym.case.for },
    ]);
    expect(judge.requests[0]?.questions.verdict.criteria).toEqual({
      "Go to the gym": null,
      "Don't go to the gym": null,
    });
  });

  it("returns the Advocate's Refusal without calling the Judge or logging", async () => {
    const judge = recordingJudge(peaked);
    const log = recordingLog();
    const advocate: Advocate = {
      argue: async () => ({ refused: true, reason: "No Options are named." }),
    };

    const outcome = await decide("I feel stuck", { advocate, judge, log });

    expect(outcome).toEqual({ refused: true, reason: "No Options are named." });
    expect(judge.requests).toEqual([]);
    expect(log.entries).toEqual([]);
  });

  it("passes a peaked Verdict through unchanged and does not flag a close call", async () => {
    const outcome = await decide("gym or rest?", {
      advocate: scriptedAdvocate([gym, rest]),
      judge: recordingJudge(peaked),
      log: recordingLog(),
    });

    expect(outcome).toEqual({
      refused: false,
      options: [gym, rest],
      verdict: {
        pick: "Go to the gym",
        probabilities: { "Go to the gym": 0.8, "Rest at home": 0.2 },
        confidence: 0.9,
        closeCall: false,
      },
    });
  });

  it("flags a near-even Verdict as a close call but still picks the top Option", async () => {
    const outcome = await decide("gym or rest?", {
      advocate: scriptedAdvocate([gym, rest]),
      judge: recordingJudge({
        pick: "Rest at home",
        probabilities: { "Go to the gym": 0.46, "Rest at home": 0.54 },
        confidence: 0.55,
      }),
      log: recordingLog(),
    });

    expect(outcome).toMatchObject({
      refused: false,
      verdict: { pick: "Rest at home", closeCall: true },
    });
  });

  it("propagates a Judge failure and never substitutes a pick from the Advocate", async () => {
    const log = recordingLog();
    const judge: Judge = {
      judge: async () => {
        throw new Error("jev unreachable");
      },
    };

    await expect(
      decide("gym or rest?", { advocate: scriptedAdvocate([gym, rest]), judge, log }),
    ).rejects.toThrow("jev unreachable");
    expect(log.entries).toEqual([]);
  });

  it("appends exactly one log entry per successful run with Dilemma, Cases, Verdict and timestamp", async () => {
    const log = recordingLog();

    await decide("gym or rest?", {
      advocate: scriptedAdvocate([gym, rest]),
      judge: recordingJudge(peaked),
      log,
      now: () => new Date("2026-09-21T20:00:00.000Z"),
    });

    expect(log.entries).toEqual([
      {
        dilemma: "gym or rest?",
        options: [gym, rest],
        verdict: { ...peaked, closeCall: false },
        timestamp: "2026-09-21T20:00:00.000Z",
      },
    ]);
  });
});
