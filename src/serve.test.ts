import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Stage } from "./decide.js";
import type { Outcome } from "./domain.js";
import {
  createHandler,
  isServeCommand,
  readPort,
  type Handler,
  type Page,
  type Reply,
  type RunEvent,
  type ServeDeps,
  type Stream,
} from "./serve.js";

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

type Decide = ServeDeps["decide"];

function handler(decide: Decide = async () => outcome, maxBodyBytes?: number): Handler {
  return createHandler({ decide, ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }) });
}

function page(reply: Reply): Page {
  if (!("html" in reply)) throw new Error("expected a whole page, got a stream");
  return reply;
}

function postForm(handle: Handler, url: string, fields: Record<string, string>) {
  const form = new URLSearchParams(fields).toString();
  return handle({ method: "POST", url, body: Readable.from([form]) });
}

async function postDilemma(handle: Handler, dilemma: string): Promise<Page> {
  return page(await postForm(handle, "/", { dilemma }));
}

async function get(url = "/", handle = handler()): Promise<Page> {
  return page(await handle({ method: "GET", url, body: Readable.from([]) }));
}

async function post(
  body: string,
  decide: Decide = async () => outcome,
  maxBodyBytes?: number,
): Promise<Page> {
  return postDilemma(handler(decide, maxBodyBytes), body);
}

/** The page's script's submission: POSTs to the streamed route and hands back the Stream, not yet run. */
async function openStream(handle: Handler, dilemma: string): Promise<Stream> {
  const reply = await postForm(handle, "/decide", { dilemma });
  if ("html" in reply) throw new Error("expected a stream, got a whole page");
  return reply;
}

/** Runs a Stream and collects what it sends, in order. */
async function collect(reply: Stream): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  await reply.run((event) => {
    events.push(event);
  });
  return events;
}

/** A streamed submission, run to the end. */
async function stream(
  body: string,
  decide: Decide = async () => outcome,
  maxBodyBytes?: number,
): Promise<{ status: number; events: RunEvent[] }> {
  const reply = await openStream(handler(decide, maxBodyBytes), body);
  return { status: reply.status, events: await collect(reply) };
}

/** A `decide` that fires both stages, as the real pipeline does, before settling. */
function staged(settle: () => Promise<Outcome>): Decide {
  return async (_, onStage) => {
    onStage?.("advocate");
    onStage?.("judge");
    return settle();
  };
}

/** A `decide` that stays in flight until the test releases it, and tells the test when it was called. */
function stalledDecide() {
  const pending: Array<(outcome: Outcome) => void> = [];
  const seen: string[] = [];
  let started = () => {};
  const decide = (dilemma: string) =>
    new Promise<Outcome>((resolve) => {
      seen.push(dilemma);
      pending.push(resolve);
      started();
    });
  const untilInFlight = (count: number) =>
    new Promise<void>((resolve) => {
      started = () => {
        if (pending.length >= count) resolve();
      };
      started();
    });
  const releaseAll = () => {
    for (const resolve of pending.splice(0)) resolve(outcome);
  };
  return { decide, seen, untilInFlight, releaseAll };
}

describe("an open page", () => {
  it("shows the Dilemma page straight away to a request carrying no cookie", async () => {
    const reply = await get();

    expect(reply.status).toBe(200);
    expect(reply.html).toContain('<textarea name="dilemma"');
    expect(reply.html).not.toContain("passphrase");
  });

  it("has no unlock route", async () => {
    const reply = page(await postForm(handler(), "/unlock", { passphrase: "open sesame" }));

    expect(reply.status).toBe(404);
  });
});

describe("concurrent submissions", () => {
  it("serves three form submissions in flight at once, none turned away as busy", async () => {
    const { decide, seen, untilInFlight, releaseAll } = stalledDecide();
    const handle = handler(decide);

    const replies = ["gym or rest?", "tea or coffee?", "walk or bus?"].map((dilemma) =>
      postDilemma(handle, dilemma),
    );
    await untilInFlight(3);
    releaseAll();

    for (const reply of await Promise.all(replies)) {
      expect(reply.status).toBe(200);
      expect(reply.html).toContain("Verdict");
      expect(reply.html).not.toContain("busy");
    }
    expect(seen).toEqual(["gym or rest?", "tea or coffee?", "walk or bus?"]);
  });

  it("serves three streamed submissions in flight at once, none turned away as busy", async () => {
    const { decide, seen, untilInFlight, releaseAll } = stalledDecide();
    const handle = handler(decide);

    const streams = await Promise.all(
      ["gym or rest?", "tea or coffee?", "walk or bus?"].map((dilemma) => openStream(handle, dilemma)),
    );
    const runs = streams.map(collect);
    expect(streams.map((reply) => reply.status)).toEqual([200, 200, 200]);
    await untilInFlight(3);
    releaseAll();

    for (const events of await Promise.all(runs)) {
      expect(events).toEqual([{ outcome: expect.stringContaining("Verdict") }]);
    }
    expect(seen).toEqual(["gym or rest?", "tea or coffee?", "walk or bus?"]);
  });
});

describe("indecision serve", () => {
  it("serves a page with one box for the Dilemma", async () => {
    const reply = await get();

    expect(reply.status).toBe(200);
    expect(reply.html).toContain('<textarea name="dilemma"');
    expect(reply.html).toContain('<form method="post" action="/"');
  });

  it("decides the submitted Dilemma and renders the Verdict above the Cases, expanded", async () => {
    const seen: string[] = [];
    const reply = await post("gym or rest?", async (dilemma) => {
      seen.push(dilemma);
      return outcome;
    });

    expect(reply.status).toBe(200);
    expect(seen).toEqual(["gym or rest?"]);
    const verdictAt = reply.html.indexOf("Verdict");
    const pickAt = reply.html.indexOf("Go to the gym", verdictAt);
    const casesAt = reply.html.indexOf("Cases");
    const pointAt = reply.html.indexOf("Sleep better");
    expect(verdictAt).toBeGreaterThanOrEqual(0);
    expect(pickAt).toBeGreaterThan(verdictAt);
    expect(casesAt).toBeGreaterThan(pickAt);
    expect(pointAt).toBeGreaterThan(casesAt);
    expect(reply.html).toContain("80.0%");
    expect(reply.html).toContain("20.0%");
    expect(reply.html).toContain("0.90");
    expect(reply.html).not.toContain("Close call");
    expect(reply.html).toContain("<details open>");
    expect(reply.html).not.toContain("<details>");
    for (const point of ["Sleep better", "Rain", "Recovery day", "Guilt"]) {
      expect(reply.html).toContain(point);
    }
  });

  it("shows the close-call line when the Verdict is flagged", async () => {
    const reply = await post("gym or rest?", async () => ({
      ...outcome,
      verdict: {
        pick: "Rest at home",
        probabilities: { "Go to the gym": 0.46, "Rest at home": 0.54 },
        confidence: 0.55,
        closeCall: true,
      },
    }));

    expect(reply.status).toBe(200);
    expect(reply.html).toContain("Close call");
    expect(reply.html).toContain("46.0%");
    expect(reply.html).toContain("54.0%");
  });

  it("renders a Refusal as an outcome with its reason and keeps the Dilemma in the box", async () => {
    const reply = await post("I feel stuck & <lost>", async () => ({
      refused: true,
      reason: "No Options are named.",
    }));

    expect(reply.status).toBe(200);
    expect(reply.html).toContain("No choice to argue here");
    expect(reply.html).toContain("No Options are named.");
    expect(reply.html).toContain(">I feel stuck &amp; &lt;lost&gt;</textarea>");
    expect(reply.html).not.toContain("Verdict");
    expect(reply.html).not.toContain('class="error"');
  });

  it("renders a thrown error as an error banner and keeps the Dilemma in the box", async () => {
    const reply = await post("gym or rest?", async () => {
      throw new Error("jev unreachable");
    });

    expect(reply.status).toBe(500);
    expect(reply.html).toContain('class="error"');
    expect(reply.html).toContain("jev unreachable");
    expect(reply.html).toContain(">gym or rest?</textarea>");
    expect(reply.html).not.toContain("Verdict");
  });

  it("rejects a body over the cap with a clear message and never calls decide", async () => {
    const seen: string[] = [];
    const reply = await post(
      "x".repeat(200),
      async (dilemma) => {
        seen.push(dilemma);
        return outcome;
      },
      100,
    );

    expect(reply.status).toBe(413);
    expect(reply.html).toContain("too long");
    expect(seen).toEqual([]);
  });

  it("drains an over-cap body to its end so the 413 can still reach the client", async () => {
    const handle = handler(async () => outcome, 100);
    const body = Readable.from(["a".repeat(60), "b".repeat(60), "c".repeat(60)]);

    const reply = page(await handle({ method: "POST", url: "/", body }));

    expect(reply.status).toBe(413);
    expect(body.readableEnded).toBe(true);
  });

  it("asks for a Dilemma when the box is empty instead of calling decide", async () => {
    const seen: string[] = [];
    const reply = await post("   ", async (dilemma) => {
      seen.push(dilemma);
      return outcome;
    });

    expect(reply.status).toBe(400);
    expect(reply.html).toContain("No Dilemma given");
    expect(seen).toEqual([]);
  });

  it("answers any other path with 404", async () => {
    const reply = await get("/favicon.ico");

    expect(reply.status).toBe(404);
  });

  it("gives the page a script that submits to the streamed route and slots for the banner and outcome", async () => {
    const reply = await get();

    expect(reply.html).toContain('fetch("/decide"');
    expect(reply.html).toContain('id="banner"');
    expect(reply.html).toContain('id="outcome"');
  });
});

describe("the streamed route", () => {
  it("sends the Advocate stage, then the Judge stage, then the Verdict above the Cases", async () => {
    const seen: string[] = [];
    const { status, events } = await stream("gym or rest?", async (dilemma, onStage) => {
      seen.push(dilemma);
      onStage?.("advocate");
      seen.push("argue");
      onStage?.("judge");
      seen.push("judge");
      return outcome;
    });

    expect(status).toBe(200);
    expect(seen).toEqual(["gym or rest?", "argue", "judge"]);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ stage: "advocate", text: "The Advocate is arguing…" });
    expect(events[1]).toEqual({ stage: "judge", text: "The Judge is weighing…" });
    const last = events[2];
    if (last === undefined || !("outcome" in last)) throw new Error("expected an outcome last");
    const verdictAt = last.outcome.indexOf("Verdict");
    const casesAt = last.outcome.indexOf("Cases");
    expect(verdictAt).toBeGreaterThanOrEqual(0);
    expect(casesAt).toBeGreaterThan(verdictAt);
    expect(last.outcome).toContain("80.0%");
    expect(last.outcome).toContain("<details open>");
  });

  it("sends each stage as it happens, not only once the outcome is in", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = handler(async (_, onStage) => {
      onStage?.("advocate");
      await gate;
      onStage?.("judge");
      return outcome;
    });
    const reply = await openStream(handle, "gym or rest?");

    const stages: Stage[] = [];
    const finished = reply.run((event) => {
      if ("stage" in event) stages.push(event.stage);
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stages).toEqual(["advocate"]);

    release();
    await finished;
    expect(stages).toEqual(["advocate", "judge"]);
  });

  it("sends a Refusal as an outcome after the stages", async () => {
    const { status, events } = await stream(
      "I feel stuck",
      staged(async () => ({ refused: true, reason: "No Options are named." })),
    );

    expect(status).toBe(200);
    expect(events.map((event) => Object.keys(event)[0])).toEqual(["stage", "stage", "outcome"]);
    const last = events[2];
    if (last === undefined || !("outcome" in last)) throw new Error("expected an outcome last");
    expect(last.outcome).toContain("No Options are named.");
    expect(last.outcome).not.toContain("Verdict");
    expect(last.outcome).not.toContain('class="error"');
  });

  it("sends a thrown error as a banner after the stages", async () => {
    const { status, events } = await stream(
      "gym or rest?",
      staged(async () => {
        throw new Error("jev unreachable");
      }),
    );

    expect(status).toBe(200);
    expect(events.map((event) => Object.keys(event)[0])).toEqual(["stage", "stage", "error"]);
    const last = events[2];
    if (last === undefined || !("error" in last)) throw new Error("expected an error last");
    expect(last.error).toContain('class="error"');
    expect(last.error).toContain("jev unreachable");
  });

  it("rejects a body over the cap with an error and never calls decide", async () => {
    const seen: string[] = [];
    const { status, events } = await stream(
      "x".repeat(200),
      async (dilemma) => {
        seen.push(dilemma);
        return outcome;
      },
      100,
    );

    expect(status).toBe(413);
    expect(seen).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ error: expect.stringContaining("too long") });
  });

  it("asks for a Dilemma when the box is empty instead of calling decide", async () => {
    const seen: string[] = [];
    const { status, events } = await stream("   ", async (dilemma) => {
      seen.push(dilemma);
      return outcome;
    });

    expect(status).toBe(400);
    expect(seen).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ error: expect.stringContaining("No Dilemma given") });
  });

  it("answers a GET on the streamed route with 405", async () => {
    const reply = await get("/decide");

    expect(reply.status).toBe(405);
  });
});

describe("serve as a reserved first word", () => {
  it("is the serve command only when it is the whole first argument", () => {
    expect(isServeCommand(["serve"])).toBe(true);
    expect(isServeCommand(["serve", "extra"])).toBe(true);
    expect(isServeCommand(["serve or rest?"])).toBe(false);
    expect(isServeCommand(["gym or rest?"])).toBe(false);
    expect(isServeCommand([])).toBe(false);
  });
});

describe("PORT", () => {
  it("defaults to 3000 and reads a valid PORT", () => {
    expect(readPort({})).toBe(3000);
    expect(readPort({ PORT: "8080" })).toBe(8080);
  });

  it("rejects a PORT that is not a port number", () => {
    expect(() => readPort({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => readPort({ PORT: "70000" })).toThrow(/PORT/);
  });
});
